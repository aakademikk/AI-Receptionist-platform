import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Brief, validateBrief } from './brief.ts';
import { ERRAND_ID_PATTERN, errandHome } from './config.ts';

/**
 * The errand folder store (spec Robustness "Data model"; must-do 17).
 *
 * One folder per errand under `ERRAND_HOME/<errand id>/`, the id being the UK date, time and
 * a short slug (`2026-10-27-1412-luigis-table`). It holds everything SAM needs to answer
 * "what happened?" from the folder alone: the brief, the read-back, the go that released the
 * call, every call status change, the machine-detection result, digits sent, each turn and
 * the outcome. The CallSid in the events ties it to Twilio's own record. Nothing here
 * touches the tenant database.
 *
 * Three rules hold for every writer:
 *
 *  * **Paths are built from a validated id only.** The id is checked against its pattern
 *    before any path exists, so a crafted id (`../../jobs/x`) is refused rather than
 *    resolved. Every query-string id the server receives goes through the same check.
 *  * **Some files are written once, and the filesystem enforces it.** `go-used.json`,
 *    `outcome.json` and `alert.json` use exclusive create (`wx`): a second write fails
 *    with `EEXIST`, so two racing writers cannot both believe they won. That is what makes
 *    a Go single-use (must-do 3c), an outcome final, and an alert one message.
 *  * **Only the owner can read it.** Folders are mode 700 and files 600: a transcript holds
 *    what a business said on the phone and Colin's mobile.
 */

export type Speaker = 'amy' | 'them';

export interface ErrandEvent {
  time: string;
  kind: string;
  [field: string]: unknown;
}

export interface TranscriptLine {
  time: string;
  speaker: Speaker;
  words: string;
}

export interface Readback {
  text: string;
  briefHash: string;
  dialNumber: string;
  questionId: string;
  jobId: string;
  /** The exact question text and options as created, which the go check compares (facts A5 rule 5). */
  questionText: string;
  questionOptions: string[];
  sentAt: string;
}

export interface GoUsed {
  questionId: string;
  jobId: string;
  answeredAt: string;
  answeredVia: string;
  briefHash: string;
  usedAt: string;
}

/** The outcome kinds of must-do 16, plus `failed` for a model or socket failure (Robustness). */
export type OutcomeKind = 'booked' | 'not_booked' | 'voicemail_left' | 'not_reached' | 'ended_early' | 'failed';

/** Which limit ended a call early (must-do 12, 11). */
export type EarlyLimit = 'payment asked' | 'confused' | 'turn cap' | 'maximum length';

export interface Outcome {
  kind: OutcomeKind;
  /** Plain-words reason: why not booked, why not reached, why failed. */
  reason?: string;
  limit?: EarlyLimit;
  /** For `booked`: the agreed time (`HH:MM`), date, name booked under and any reference. */
  agreedTime?: string;
  date?: string;
  nameBookedUnder?: string;
  reference?: string;
  /** Times the business offered that sat outside the window. */
  offeredTimes?: string[];
  /** Who settled it: the call session, the status callback, the dial step, the call instructions. */
  source: 'session' | 'status' | 'dial' | 'twiml';
  at: string;
}

export interface Alert {
  text: string;
  at: string;
}

export function isErrandId(id: unknown): id is string {
  return typeof id === 'string' && ERRAND_ID_PATTERN.test(id);
}

/** Throws on a bad id before any path is built from it. */
export function assertErrandId(id: unknown): string {
  if (!isErrandId(id)) throw new Error(`not a valid errand id: ${JSON.stringify(String(id).slice(0, 80))}`);
  return id;
}

export function errandDir(id: string, home: string = errandHome()): string {
  return join(home, assertErrandId(id));
}

function filePath(id: string, name: string, home: string): string {
  return join(errandDir(id, home), name);
}

/** UK local date and time pieces for `now`, used for the id so it reads as Colin's clock. */
function ukParts(now: Date): { date: string; hhmm: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hhmm: `${get('hour')}${get('minute')}` };
}

/** Lower-case letters, digits and single dashes, at most `max` characters. */
export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'errand';
}

/** The id for a brief created at `now`: `YYYY-MM-DD-HHMM-<business>-<kind>`. */
export function makeErrandId(brief: Brief, now: Date, suffix = ''): string {
  const { date, hhmm } = ukParts(now);
  const base = slugify(`${brief.business} ${brief.goalKind}`, 40 - suffix.length);
  return `${date}-${hhmm}-${base}${suffix}`;
}

function writeOnceJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

/** Replace a file atomically: write a temp file beside it, then rename over. */
function replaceJson(path: string, data: unknown): void {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

/**
 * Create the folder for a new errand and write its brief.
 *
 * The brief is validated first; a bad one creates nothing. Two errands for the same
 * business in the same minute get `-2`, `-3` suffixes rather than sharing a folder: the
 * folder is created without `recursive`, so an existing one is a clean `EEXIST`.
 */
export function newErrand(input: unknown, now: Date, home: string = errandHome()): { id: string; brief: Brief } {
  const checked = validateBrief(input);
  if (!checked.ok) throw new Error(`brief ${checked.field}: ${checked.error}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  for (let n = 1; n <= 99; n += 1) {
    const id = makeErrandId(checked.brief, now, n === 1 ? '' : `-${n}`);
    try {
      mkdirSync(join(home, assertErrandId(id)), { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    writeOnceJson(filePath(id, 'brief.json', home), checked.brief);
    appendEvent(id, { kind: 'created' }, now, home);
    return { id, brief: checked.brief };
  }
  throw new Error('too many errands for this business in one minute');
}

export function errandExists(id: string, home: string = errandHome()): boolean {
  return isErrandId(id) && existsSync(join(home, id, 'brief.json'));
}

export function readBrief(id: string, home: string = errandHome()): Brief | null {
  return readJson<Brief>(filePath(id, 'brief.json', home));
}

/**
 * Replace the brief. Any edit after a read-back changes the brief's hash, and the dial step
 * then refuses the Go for the old read-back (must-do 3a). Recorded as an event.
 */
export function writeBrief(id: string, input: unknown, now: Date, home: string = errandHome()): Brief {
  const checked = validateBrief(input);
  if (!checked.ok) throw new Error(`brief ${checked.field}: ${checked.error}`);
  replaceJson(filePath(id, 'brief.json', home), checked.brief);
  appendEvent(id, { kind: 'brief_edited' }, now, home);
  return checked.brief;
}

/**
 * Write the read-back. A later read-back replaces it (with a new Go question), so a Go
 * tapped on an earlier one names a question the folder no longer points at and is refused.
 */
export function writeReadback(id: string, readback: Readback, home: string = errandHome()): void {
  replaceJson(filePath(id, 'readback.json', home), readback);
}

export function readReadback(id: string, home: string = errandHome()): Readback | null {
  return readJson<Readback>(filePath(id, 'readback.json', home));
}

/** Exclusive create: the second caller gets `EEXIST`. This is what makes a Go single-use. */
export function writeGoUsed(id: string, go: GoUsed, home: string = errandHome()): void {
  writeOnceJson(filePath(id, 'go-used.json', home), go);
}

export function readGoUsed(id: string, home: string = errandHome()): GoUsed | null {
  return readJson<GoUsed>(filePath(id, 'go-used.json', home));
}

export function appendEvent(id: string, event: { kind: string; [field: string]: unknown }, now: Date, home: string = errandHome()): void {
  const line: ErrandEvent = { time: now.toISOString(), ...event };
  appendFileSync(filePath(id, 'events.jsonl', home), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

export function readEvents(id: string, home: string = errandHome()): ErrandEvent[] {
  return readLines<ErrandEvent>(filePath(id, 'events.jsonl', home));
}

export function appendTranscript(id: string, speaker: Speaker, words: string, now: Date, home: string = errandHome()): void {
  const line: TranscriptLine = { time: now.toISOString(), speaker, words };
  appendFileSync(filePath(id, 'transcript.jsonl', home), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

export function readTranscript(id: string, home: string = errandHome()): TranscriptLine[] {
  return readLines<TranscriptLine>(filePath(id, 'transcript.jsonl', home));
}

/** Written once. Returns false (and changes nothing) when an outcome is already settled. */
export function writeOutcome(id: string, outcome: Outcome, home: string = errandHome()): boolean {
  try {
    writeOnceJson(filePath(id, 'outcome.json', home), outcome);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

export function readOutcome(id: string, home: string = errandHome()): Outcome | null {
  return readJson<Outcome>(filePath(id, 'outcome.json', home));
}

/** Written once. Returns false when an alert was already raised. */
export function writeAlert(id: string, alert: Alert, home: string = errandHome()): boolean {
  try {
    writeOnceJson(filePath(id, 'alert.json', home), alert);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

export function readAlert(id: string, home: string = errandHome()): Alert | null {
  return readJson<Alert>(filePath(id, 'alert.json', home));
}

/**
 * Claim the one outcome report: `reported.json` by exclusive create, before the notifier runs.
 * True for exactly one caller, so a repeated status post can never send a second message.
 */
export function claimReport(id: string, now: Date, home: string = errandHome()): boolean {
  try {
    writeOnceJson(filePath(id, 'reported.json', home), { claimedAt: now.toISOString() });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** Every errand id in the store, oldest first (the id sorts by date and time). */
export function listErrands(home: string = errandHome()): string[] {
  if (!existsSync(home)) return [];
  return readdirSync(home).filter(isErrandId).sort();
}

/** The time of the errand's `dialled` event, or null when it was never dialled. */
export function dialledAt(id: string, home: string = errandHome()): Date | null {
  const event = readEvents(id, home).find((item) => item.kind === 'dialled');
  return event ? new Date(event.time) : null;
}
