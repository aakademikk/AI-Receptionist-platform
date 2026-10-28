import { ERRAND_PORT, HEALTH_PATH, HEALTH_TIMEOUT_MS, errandHome, maskSid } from './config.ts';
import { checkGo, markGoUsed, type GoDeps, type GoRecord } from './go.ts';
import { type Runner, checkBatch } from './guards/batch.ts';
import { checkCallingHours, ukTime } from './guards/hours.ts';
import { checkNoLiveErrand } from './guards/live.ts';
import { normaliseUkNumber } from './guards/number.ts';
import { appendEvent, assertErrandId, errandExists, readBrief, readReadback, writeOutcome } from './store.ts';
import type { CreateCallResult } from './twilio-call.ts';

/**
 * The dial step (must-dos 3 to 7, 18).
 *
 * The one place an errand call is created. Every guard runs before the create, in this
 * order, and a refusal says which guard and why and places no call:
 *
 *   1. health    the errand service answers on 127.0.0.1 ("errand service down" if not:
 *                with no service, nobody would answer Twilio's call instructions request);
 *   2. go        Colin's Go for this exact read-back, under 30 minutes, unused (T7);
 *   3. number    an allowed UK kind, and the same E.164 the read-back showed (T8);
 *   4. hours     08:00 to 21:00 UK time (T8), or outside it when the brief says `afterHours`
 *                and Colin's Go is for that read-back (OPEN 14 change, T34);
 *   5. batch     no robot speed-test unit or process (T9);
 *   6. live      no other errand call live (T9).
 *
 * With every guard passed, the Go is consumed (exclusive create) *before* the create, so
 * nothing can dial twice on one Go, and then exactly one create is attempted. It is never
 * retried and nothing here loops (must-do 18): a failed create settles the outcome as "not
 * reached: failed to place" and reports it, and trying again needs a new Go from Colin.
 * A placed call gets its watchdog: a transient user timer that runs `errand watch <id>` 20
 * minutes later (T18). Its unit name starts `errand-watch-`, never `robot-`, so the batch
 * guard cannot mistake an errand for a speed test.
 *
 * `--check` runs every guard without stopping at the first refusal, prints one line each,
 * and never consumes the Go or creates a call, so a single guard can be proved on the live
 * box without a valid Go (T24).
 *
 * Exit codes: 0 placed (or every guard passed under `--check`), 3 refused, 1 internal or a
 * failed create.
 */

export const EXIT_PLACED = 0;
export const EXIT_INTERNAL = 1;
export const EXIT_REFUSED = 3;

/** The watchdog's delay as `systemd-run` reads it; the value is `NO_OUTCOME_ALERT_MS` (20 minutes). */
export const WATCH_DELAY = '20m';

export interface DialDeps extends GoDeps {
  now: () => Date;
  /** True when the errand service answers its health check. */
  health: () => Promise<boolean>;
  /** Runs the batch listings and the watchdog's `systemd-run`. */
  run: Runner;
  createCall: (input: { errandId: string; to: string }) => Promise<CreateCallResult>;
  /** Sends the settled outcome to Colin (T17's reporter). */
  sendOutcome: (errandId: string) => Promise<void>;
  /** The errand CLI as a command, e.g. `['/home/col/.local/bin/errand']`; `watch <id>` is appended. */
  watchCommand: string[];
}

export interface DialResult {
  code: number;
  lines: string[];
}

type GuardResult = { ok: true; note?: string } | { ok: false; reason: string };

/** The live health check: the errand service's local-only endpoint, 2-second timeout. */
export async function errandServiceHealthy(fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher(`http://127.0.0.1:${ERRAND_PORT}${HEALTH_PATH}`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return response.status === 200;
  } catch {
    return false;
  }
}

export async function dial(errandId: string, options: { check?: boolean }, deps: DialDeps): Promise<DialResult> {
  const home = deps.home ?? errandHome();
  const check = options.check === true;
  try {
    assertErrandId(errandId);
    if (!errandExists(errandId, home)) return { code: EXIT_REFUSED, lines: ['refused: no such errand'] };

    // What the guards learned, for the create: the Go to consume and the number to ring.
    const learned: { go?: GoRecord; e164?: string; afterHours?: boolean } = {};
    const guards: Array<[string, () => Promise<GuardResult> | GuardResult]> = [
      ['health', async () => ((await deps.health()) ? { ok: true } : { ok: false, reason: 'errand service down' })],
      [
        'go',
        () => {
          const result = checkGo(errandId, deps.now(), deps);
          if (result.ok) learned.go = result.go;
          return result;
        },
      ],
      [
        'number',
        () => {
          const brief = readBrief(errandId, home)!;
          const number = normaliseUkNumber(brief.number);
          if (!number.ok) return number;
          // The Go's number, re-derived from the brief Colin saw (Wave C R2); readback.json only
          // when the Go guard did not pass, which is the --check listing.
          const expected = learned.go?.dialNumber ?? readReadback(errandId, home)?.dialNumber;
          if (expected && expected !== number.e164) return { ok: false, reason: 'number differs from the read-back' };
          learned.e164 = number.e164;
          return { ok: true };
        },
      ],
      [
        'hours',
        () => {
          const result = checkCallingHours(deps.now(), { afterHours: readBrief(errandId, home)?.afterHours === true });
          if (result.ok && result.note) learned.afterHours = true;
          return result;
        },
      ],
      ['batch', () => checkBatch({ run: deps.run })],
      ['live', () => checkNoLiveErrand(deps.now(), { home })],
    ];

    const lines: string[] = [];
    let refused = false;
    for (const [name, guard] of guards) {
      const result = await guard();
      if (check) {
        lines.push(result.ok ? `${name}: pass${result.note ? ` (${result.note})` : ''}` : `${name}: refused: ${result.reason}`);
        refused ||= !result.ok;
        continue;
      }
      if (!result.ok) {
        appendEvent(errandId, { kind: 'dial_refused', guard: name, reason: result.reason }, deps.now(), home);
        return { code: EXIT_REFUSED, lines: [`refused: ${name}: ${result.reason}`] };
      }
    }
    if (check) return { code: refused ? EXIT_REFUSED : EXIT_PLACED, lines };

    // Every guard passed. Consume the Go before anything can dial on it; a racing dial that
    // passed the same guards loses this exclusive create and places nothing.
    const used = markGoUsed(errandId, learned.go!, deps.now(), home);
    if (!used.ok) return { code: EXIT_REFUSED, lines: ['refused: go consumed by another dial'] };
    if (learned.afterHours) appendEvent(errandId, { kind: 'after_hours', ukTime: ukTime(deps.now()) }, deps.now(), home);

    const to = learned.e164!;
    const created = await deps.createCall({ errandId, to });
    if (!created.ok) {
      appendEvent(errandId, { kind: 'create_failed', failure: created.failure, status: created.status ?? null, twilioCode: created.twilioCode ?? null }, deps.now(), home);
      writeOutcome(errandId, { kind: 'not_reached', reason: 'failed to place', source: 'dial', at: deps.now().toISOString() }, home);
      await deps.sendOutcome(errandId).catch(() => undefined);
      return { code: EXIT_INTERNAL, lines: [`failed: could not place the call (${created.failure}); not retried`] };
    }

    appendEvent(errandId, { kind: 'dialled', callSid: maskSid(created.callSid), to }, deps.now(), home);
    const unit = `errand-watch-${errandId}`;
    const watch = await deps
      .run('systemd-run', ['--user', `--on-active=${WATCH_DELAY}`, `--unit=${unit}`, ...deps.watchCommand, 'watch', errandId])
      .catch(() => ({ code: -1, stdout: '', stderr: '' }));
    appendEvent(errandId, { kind: 'watch_scheduled', unit, exit: watch.code }, deps.now(), home);
    const note = watch.code === 0 ? '' : '; watchdog NOT scheduled';
    return { code: EXIT_PLACED, lines: [`placed: ${maskSid(created.callSid)}${note}`] };
  } catch (error) {
    return { code: EXIT_INTERNAL, lines: [`internal: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
