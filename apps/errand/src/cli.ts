import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { errandHome, maskSid } from './config.ts';
import { type DialDeps, dial, errandServiceHealthy } from './dial.ts';
import { runCommand } from './guards/batch.ts';
import { normaliseUkNumber } from './guards/number.ts';
import { describePrune, prune } from './prune.ts';
import { type ReadbackDeps, createQuestionInStore, renderWindow, runNotifier, sendReadback } from './readback.ts';
import { reportOnce } from './report.ts';
import {
  isErrandId,
  listErrands,
  newErrand,
  readBrief,
  readEvents,
  readGoUsed,
  readOutcome,
  readReadback,
  readTranscript,
} from './store.ts';
import { createErrandCall } from './twilio-call.ts';
import { watch } from './watch.ts';

/**
 * The `errand` command line: how SAM drives an errand from chat (must-dos 1, 2, 3, 17).
 *
 *   errand new <brief.json>     validate the brief, create the folder, print the id
 *   errand readback <id>        send the read-back with the Go button (T6)
 *   errand dial <id> [--check]  every guard, then one call; --check stops before the call (T11)
 *   errand status <id>          the brief, events, transcript and outcome, in plain text
 *   errand watch <id>           the 20-minute no-outcome alarm (T18; run by the dial's timer)
 *   errand prune [--dry-run]    remove folders older than 90 days (T18; run daily)
 *   errand list                 every errand with its state
 *
 * Exit codes: 0 done, 2 bad usage, 3 refused (with the reason on stdout), 1 anything else.
 * Chat in, Telegram out, files on disk: there is no other interface (Won't do).
 *
 * Credentials arrive through `with-secrets --as errand-caller` (the wrapper in
 * `deploy/errand`); nothing here prints one. Every live dependency can be replaced, which is
 * how the tests run the whole command against a temp folder.
 */

export const USAGE = `usage:
  errand new <brief.json>
  errand readback <id>
  errand dial <id> [--check]
  errand status <id>
  errand watch <id>
  errand prune [--dry-run]
  errand list`;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;

export interface CliDeps {
  home: string;
  now: () => Date;
  notify: (args: string[]) => Promise<number>;
  readback: Omit<ReadbackDeps, 'now' | 'home' | 'notify'>;
  dial: Omit<DialDeps, 'now' | 'home' | 'sendOutcome'>;
}

export interface CliResult {
  code: number;
  out: string[];
}

/** The live wiring: the real store, notifier, closer store, runner, health check and Twilio create. */
export function liveDeps(env: NodeJS.ProcessEnv = process.env): CliDeps {
  return {
    home: errandHome(env),
    now: () => new Date(),
    notify: runNotifier(),
    readback: { checkNumber: normaliseUkNumber, createQuestion: createQuestionInStore() },
    dial: {
      health: () => errandServiceHealthy(),
      run: runCommand,
      createCall: (input) => createErrandCall(input, { env }),
      watchCommand: [env.ERRAND_CLI?.trim() || join(homedir(), '.local', 'bin', 'errand')],
    },
  };
}

function stateOf(id: string, home: string): string {
  const outcome = readOutcome(id, home);
  if (outcome) return `outcome: ${outcome.kind.replace('_', ' ')}${outcome.limit ? ` (${outcome.limit})` : ''}`;
  if (readEvents(id, home).some((event) => event.kind === 'dialled')) return 'dialled, no outcome yet';
  if (readGoUsed(id, home)) return 'go used';
  if (readReadback(id, home)) return 'read back, waiting for Go';
  return 'new';
}

/** Plain text for SAM: everything in the folder, in reading order. */
export function statusText(id: string, home: string): string[] {
  const brief = readBrief(id, home);
  if (!brief) return [`no such errand: ${id}`];
  const out = [
    `Errand ${id}: ${stateOf(id, home)}`,
    `Business: ${brief.business}`,
    `Number: ${brief.number}`,
    `Goal: ${brief.goal}`,
    `Window: ${renderWindow(brief.window)}`,
    ...(brief.afterHours ? ['After hours: yes'] : []),
    ...Object.entries(brief.details).map(([key, value]) => `Detail ${key}: ${value}`),
    `Contact: ${brief.contact.name}, ${brief.contact.mobile}`,
  ];
  const readback = readReadback(id, home);
  if (readback) out.push(`Read back at ${readback.sentAt} (question ${readback.questionId}, brief #${readback.briefHash.slice(0, 8)}), dialling ${readback.dialNumber}`);
  const go = readGoUsed(id, home);
  if (go) out.push(`Go: answered ${go.answeredAt} via ${go.answeredVia}, used ${go.usedAt}`);
  out.push('', 'Events:');
  for (const event of readEvents(id, home)) {
    const { time, kind, ...fields } = event;
    const detail = Object.entries(fields)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => `${key}=${key === 'callSid' ? maskSid(String(value)) : typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
      .join(' ');
    out.push(`  ${time} ${kind}${detail ? ` ${detail}` : ''}`);
  }
  out.push('', 'Transcript:');
  const transcript = readTranscript(id, home);
  if (transcript.length === 0) out.push('  (none)');
  for (const line of transcript) out.push(`  ${line.time} ${line.speaker === 'amy' ? 'Amy' : 'Them'}: ${line.words}`);
  const outcome = readOutcome(id, home);
  out.push('', `Outcome: ${outcome ? JSON.stringify(outcome) : '(none yet)'}`);
  return out;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<CliResult> {
  const [command, ...args] = argv;
  const usage = (): CliResult => ({ code: EXIT_USAGE, out: [USAGE] });
  const needId = (): string | null => (args.length >= 1 && isErrandId(args[0]) ? args[0] : null);

  switch (command) {
    case 'new': {
      if (args.length !== 1) return usage();
      let input: unknown;
      try {
        input = JSON.parse(readFileSync(args[0]!, 'utf8'));
      } catch (error) {
        return { code: EXIT_FAILED, out: [`cannot read brief: ${error instanceof Error ? error.message : String(error)}`] };
      }
      try {
        const { id } = newErrand(input, deps.now(), deps.home);
        return { code: EXIT_OK, out: [id] };
      } catch (error) {
        return { code: EXIT_REFUSED, out: [`refused: ${error instanceof Error ? error.message : String(error)}`] };
      }
    }
    case 'readback': {
      const id = needId();
      if (!id || args.length !== 1) return usage();
      const result = await sendReadback(id, { ...deps.readback, notify: deps.notify, now: deps.now, home: deps.home });
      if (!result.ok) return { code: EXIT_REFUSED, out: [`refused: ${result.reason}`] };
      return { code: EXIT_OK, out: [result.readback.text, '', `Go question ${result.readback.questionId} sent; waiting for Colin's tap.`] };
    }
    case 'dial': {
      const id = needId();
      const rest = args.slice(1);
      if (!id || rest.some((arg) => arg !== '--check') || rest.length > 1) return usage();
      const result = await dial(id, { check: rest.includes('--check') }, {
        ...deps.dial,
        now: deps.now,
        home: deps.home,
        sendOutcome: async (errandId) => void (await reportOnce(errandId, { notify: deps.notify, now: deps.now, home: deps.home })),
      });
      return { code: result.code, out: result.lines };
    }
    case 'status': {
      const id = needId();
      if (!id || args.length !== 1) return usage();
      if (!readBrief(id, deps.home)) return { code: EXIT_FAILED, out: [`no such errand: ${id}`] };
      return { code: EXIT_OK, out: statusText(id, deps.home) };
    }
    case 'watch': {
      const id = needId();
      if (!id || args.length !== 1) return usage();
      return { code: EXIT_OK, out: [await watch(id, deps.now(), { notify: deps.notify, home: deps.home })] };
    }
    case 'prune': {
      if (args.length > 1 || (args.length === 1 && args[0] !== '--dry-run')) return usage();
      return { code: EXIT_OK, out: [describePrune(prune(deps.now(), { dryRun: args[0] === '--dry-run' }, { home: deps.home }))] };
    }
    case 'list': {
      if (args.length !== 0) return usage();
      const ids = listErrands(deps.home);
      return { code: EXIT_OK, out: ids.length ? ids.map((id) => `${id}  ${stateOf(id, deps.home)}`) : ['(no errands)'] };
    }
    default:
      return usage();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2), liveDeps())
    .then((result) => {
      process.stdout.write(`${result.out.join('\n')}\n`);
      process.exitCode = result.code;
    })
    .catch((error: unknown) => {
      process.stdout.write(`internal: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = EXIT_FAILED;
    });
}
