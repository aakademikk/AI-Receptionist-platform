import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';

import { type Brief, briefHash, validateBrief } from './brief.ts';
import { errandHome, jobStore, notifyBin } from './config.ts';
import { type Readback, appendEvent, assertErrandId, readBrief, writeReadback } from './store.ts';

/**
 * The read-back and the Go question (must-dos 2 and 3; OPEN 1).
 *
 * SAM reads the whole brief back to Colin in one message, with the number exactly as it will
 * be dialled, and nothing dials until Colin taps Go on that read-back. The Go is not
 * something SAM can give itself: it is a question in the closer's store, answered only by
 * the bridge (`closer_answer.py`, run by SAM_ui when Colin taps), so the dial step reads the
 * bridge's record rather than anything SAM wrote (facts A5).
 *
 * The question follows the facts' recommended shape (A2, A4): a `choice2` with options
 * `Go` and `Cancel`, `gated: true` so the answer needs Colin's biometric step-up in the SAM
 * tab and a stray lock-screen tap cannot give it, `acceptAction: none` so accepting starts
 * no work by itself. It lives in its own job dir, `job_errand-<errand id>_<stamp>`, because
 * a push button needs a job id and an errand has no fleet job. Its text carries the whole
 * read-back on one line, so the Go is visibly for this brief; the folder records that text
 * and the options, and the dial step refuses if they no longer match.
 *
 * Telegram carries the read-back text only (facts A3); the Go button rides on the phone push
 * and the SAM tab. Both the question creator and the notifier are injected, so tests never
 * write under `~/.sam` or send anything.
 */

export const GO_OPTIONS = ['Go', 'Cancel'] as const;
export const READBACK_CLOSING = 'Tap Go to place this call. Nothing dials without it.';

/** The number check the dial step also runs (T8). Injected so this module does not fix the rules. */
export type NumberCheck = (input: string) => { ok: true; e164: string } | { ok: false; reason: string };

/** The closer's question shape (facts A1 table), as the errand creates it. */
export interface GoQuestion {
  id: string;
  kind: 'choice2';
  text: string;
  options: string[];
  source: 'errand';
  gated: true;
  acceptAction: 'none';
  state: 'open';
  createdAt: string;
  answeredAt: null;
  answeredVia: null;
  result: null;
}

export interface ReadbackDeps {
  checkNumber: NumberCheck;
  /** Writes the question where the bridge will answer it. Returns nothing; throws on failure. */
  createQuestion: (jobId: string, question: GoQuestion) => void;
  /** Runs the notifier with these arguments; resolves to its exit code. */
  notify: (args: string[]) => Promise<number>;
  now: () => Date;
  home?: string;
}

export type ReadbackResult = { ok: true; readback: Readback } | { ok: false; reason: string };

/**
 * `+44 7700 900123`: E.164 grouped the way the number is said. The read-back shows both this
 * and the bare E.164, so Colin can check it by eye and SAM's record shows exactly what dials.
 */
export function spacedUkNumber(e164: string): string {
  if (!e164.startsWith('+44')) return e164;
  const rest = e164.slice(3);
  const groups = rest.startsWith('2')
    ? [rest.slice(0, 2), rest.slice(2, 6), rest.slice(6)]
    : rest.startsWith('7') || rest.startsWith('1')
      ? [rest.slice(0, 4), rest.slice(4)]
      : [rest.slice(0, 3), rest.slice(3, 6), rest.slice(6)];
  return `+44 ${groups.filter(Boolean).join(' ')}`;
}

/** "Wed 28 Oct, between 19:00 and 20:30". The date is a calendar date; noon UTC keeps it on the day. */
export function renderWindow(window: Brief['window']): string {
  const [y, m, d] = window.date.split('-').map(Number) as [number, number, number];
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, d, 12)))
    .replace(/,/g, '');
  return `${day}, between ${window.earliest} and ${window.latest}`;
}

/** `partySize` → `Party size`. */
function labelOf(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The short tag that ties a read-back to one brief: the first 8 of its hash. */
export function hashTag(hash: string): string {
  return hash.slice(0, 8);
}

/**
 * The read-back: one message, one line per brief field in a fixed order. The order is fixed
 * so two read-backs of the same brief are the same text, and Colin always finds the number
 * in the same place.
 */
export function renderReadback(brief: Brief, dialNumber: string): string {
  const lines = [
    `Errand call for Colin. Check every line.`,
    `Business: ${brief.business}`,
    `Number as dialled: ${dialNumber} (${spacedUkNumber(dialNumber)})`,
    `Goal: ${brief.goal}`,
    `Kind: ${brief.goalKind}`,
    `Window: ${renderWindow(brief.window)}`,
    ...Object.keys(brief.details)
      .sort()
      .map((key) => `${labelOf(key)}: ${brief.details[key]}`),
    `Name Amy may give: ${brief.contact.name}`,
    `Mobile Amy may give: ${brief.contact.mobile}`,
    `Limits: ${[...brief.limits.fixed, ...brief.limits.added].join('; ')}`,
    `Brief #${hashTag(briefHash(brief))}`,
    READBACK_CLOSING,
  ];
  return lines.join('\n');
}

/** The question's text: the read-back on one line, as the closer's question text is one line. */
export function questionTextFor(readbackText: string): string {
  return readbackText.split('\n').join(' / ');
}

/** UTC to the second, the closer's `createdAt` format. */
export function closerTimestamp(now: Date): string {
  return `${now.toISOString().slice(0, 19)}Z`;
}

function jobIdFor(errandId: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `job_errand-${errandId}_${stamp}`;
}

/**
 * Build and send the read-back for an errand, and record it.
 *
 * Order matters. The brief is validated and the number checked first, and a refused number
 * stops here with its reason: nothing is created and nothing is sent. Then the question is
 * created and `readback.json` written *before* the notifier runs, so the folder always knows
 * the question Colin may answer; a notifier failure is recorded as an event and leaves the
 * question answerable from the SAM tab. A later read-back replaces this one with a new
 * question, and a Go on the old question then names a question the folder no longer points at.
 */
export async function sendReadback(errandId: string, deps: ReadbackDeps): Promise<ReadbackResult> {
  const home = deps.home ?? errandHome();
  assertErrandId(errandId);
  const stored = readBrief(errandId, home);
  if (!stored) return { ok: false, reason: 'no such errand' };
  const checked = validateBrief(stored);
  if (!checked.ok) return { ok: false, reason: `brief ${checked.field}: ${checked.error}` };
  const brief = checked.brief;

  const number = deps.checkNumber(brief.number);
  if (!number.ok) {
    appendEvent(errandId, { kind: 'readback_refused', reason: number.reason }, deps.now(), home);
    return { ok: false, reason: `number refused: ${number.reason}` };
  }

  const now = deps.now();
  const text = renderReadback(brief, number.e164);
  const questionId = `q_${randomBytes(4).toString('hex')}`;
  const jobId = jobIdFor(errandId, now);
  const createdAt = closerTimestamp(now);
  const question: GoQuestion = {
    id: questionId,
    kind: 'choice2',
    text: questionTextFor(text),
    options: [...GO_OPTIONS],
    source: 'errand',
    gated: true,
    acceptAction: 'none',
    state: 'open',
    createdAt,
    answeredAt: null,
    answeredVia: null,
    result: null,
  };
  deps.createQuestion(jobId, question);

  const readback: Readback = {
    text,
    briefHash: briefHash(brief),
    dialNumber: number.e164,
    questionId,
    jobId,
    questionText: question.text,
    questionOptions: question.options,
    sentAt: createdAt,
  };
  writeReadback(errandId, readback, home);

  const code = await deps.notify([
    `Errand read-back: ${brief.business}`,
    `Errand call to ${brief.business} on ${spacedUkNumber(number.e164)}. Check the read-back, then tap Go in the SAM tab.`,
    '--question',
    questionId,
    '--options',
    GO_OPTIONS.join('|'),
    '--job',
    jobId,
    '--full',
    text,
  ]).catch(() => -1);
  appendEvent(errandId, { kind: 'readback_sent', questionId, jobId, briefHash: readback.briefHash, notifyExit: code }, deps.now(), home);
  return { ok: true, readback };
}

/**
 * The live question creator: the waiting-on-colin precedent (facts A2). A job dir holding
 * only a `closer.json` with this one question, written atomically (temp file in the same
 * dir, fsync, rename) as `closer_core.write_record` does. Never called by a test with the
 * live store; tests pass a temp `SAM_JOB_STORE` or a fake.
 */
export function createQuestionInStore(store: string = jobStore()): ReadbackDeps['createQuestion'] {
  return (jobId, question) => {
    if (!/^job_[A-Za-z0-9._-]+$/.test(jobId)) throw new Error('bad job id');
    const dir = join(store, jobId);
    mkdirSync(dir, { recursive: false, mode: 0o700 });
    const record = { jobId, source: 'errand', questions: [question] };
    const path = join(dir, 'closer.json');
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    const fd = openSync(temp, 'r');
    fsyncSync(fd);
    closeSync(fd);
    renameSync(temp, path);
  };
}

/** The live notifier: `notify-colin.sh` with arguments, no shell. Resolves to its exit code. */
export function runNotifier(bin: string = notifyBin()): (args: string[]) => Promise<number> {
  return (args) =>
    new Promise((resolve) => {
      execFile(bin, args, { timeout: 30_000 }, (error) => {
        if (!error) return resolve(0);
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        resolve(typeof code === 'number' ? code : 1);
      });
    });
}
