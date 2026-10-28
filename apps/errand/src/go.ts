import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { briefHash, validateBrief } from './brief.ts';
import { GO_EXPIRY_MS, errandHome, jobStore, pushLog } from './config.ts';
import { normaliseUkNumber } from './guards/number.ts';
import { GO_OPTIONS, questionTextFor, renderReadback } from './readback.ts';
import { type GoUsed, assertErrandId, readBrief, readGoUsed, readReadback, writeGoUsed } from './store.ts';

/**
 * The Go check (must-do 3; OPEN 1, OPEN 2; facts A5).
 *
 * Nothing dials without Colin's explicit Go for that exact read-back. A Go is valid only if
 * it (a) matches the brief as read back, (b) is younger than 30 minutes, and (c) has not
 * been used. Every other answer fails closed with a named reason the dial step prints.
 *
 * **Whose record this reads.** The Go is the bridge's: `closer_answer.py`, the only code
 * that changes a question's state, writes `state`, `result`, `answeredAt` and `answeredVia`
 * together under its lock when Colin taps. So this reads the closer's `closer.json` for the
 * job and question the read-back recorded, and never searches the store for a likely
 * match. From the errand folder it reads only what pins the Go to a brief: the read-back's
 * question id, job id, text, options and brief hash, and whether `go-used.json` exists.
 * Nothing SAM writes in the errand folder can turn a non-Go into a Go, and nothing it writes
 * there can move a Go to another brief: the brief on disk is re-rendered and must give the exact
 * text the bridge holds, and the number dialled is the one derived from it (Wave C R2), never
 * `readback.json`'s copy.
 *
 * This is a convention-and-permissions proof, not a cryptographic one (facts A5): any
 * process running as `col` could edit the file. The file is therefore also required to be a
 * regular file owned by this user and not a symlink, and the push-log must show the Go
 * question was sent to Colin before it was answered (the second trace facts A5 found).
 */

export interface GoRecord {
  questionId: string;
  jobId: string;
  answeredAt: string;
  answeredVia: 'push' | 'tab';
  briefHash: string;
  /** The E.164 number the Go was given for, derived from the brief on disk. */
  dialNumber: string;
}

export type GoCheck = { ok: true; go: GoRecord } | { ok: false; reason: string };

export interface GoDeps {
  home?: string;
  /** The closer's job store. */
  store?: string;
  pushLogPath?: string;
  /** The uid the bridge's file must belong to; the current process's by default. */
  uid?: number;
}

const JOB_ID = /^job_[A-Za-z0-9._-]+$/;
const QUESTION_ID = /^q_[0-9a-f]{8}$/;
const CLOSER_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** A clock difference this small between the bridge and the dial step is not a forged future answer. */
const CLOCK_SKEW_MS = 60_000;

interface BridgeQuestion {
  id?: unknown;
  kind?: unknown;
  text?: unknown;
  options?: unknown;
  state?: unknown;
  result?: unknown;
  createdAt?: unknown;
  answeredAt?: unknown;
  answeredVia?: unknown;
}

function readBridgeQuestion(store: string, jobId: string, questionId: string, uid: number): BridgeQuestion | string {
  if (!JOB_ID.test(jobId) || !QUESTION_ID.test(questionId)) return 'read-back names a malformed question';
  const path = join(store, jobId, 'closer.json');
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return "no bridge record for the read-back's question";
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return 'bridge record is not a regular file';
  if (stat.uid !== uid) return 'bridge record is not owned by this user';
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return 'bridge record is unreadable';
  }
  const questions = (record as { questions?: unknown })?.questions;
  if (!Array.isArray(questions)) return 'bridge record has no questions list';
  const found = questions.find((item: BridgeQuestion) => item?.id === questionId) as BridgeQuestion | undefined;
  return found ?? "no bridge record for the read-back's question";
}

/** True when `sam-push` logged sending this question before `answeredAtMs` (facts A5 second trace). */
function pushedBefore(path: string, questionId: string, answeredAtMs: number): boolean {
  if (!existsSync(path)) return false;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  for (const line of text.split('\n')) {
    if (!line.includes(questionId)) continue;
    try {
      const entry = JSON.parse(line) as { questionId?: unknown; ts?: unknown };
      // `answeredAt` is to the second, so a send in the same second still counts as before.
      if (entry.questionId === questionId && typeof entry.ts === 'number' && entry.ts < answeredAtMs + 1000) return true;
    } catch {
      // A torn line is not a trace.
    }
  }
  return false;
}

export function checkGo(errandId: string, now: Date, deps: GoDeps = {}): GoCheck {
  const home = deps.home ?? errandHome();
  const store = deps.store ?? jobStore();
  const refuse = (reason: string): GoCheck => ({ ok: false, reason });
  assertErrandId(errandId);

  const readback = readReadback(errandId, home);
  if (!readback) return refuse('no read-back');

  const question = readBridgeQuestion(store, readback.jobId, readback.questionId, deps.uid ?? process.getuid?.() ?? -1);
  if (typeof question === 'string') return refuse(question);

  // Facts A5 rule 5: the question must still be the one created for this read-back.
  if (
    question.kind !== 'choice2' ||
    question.text !== readback.questionText ||
    JSON.stringify(question.options) !== JSON.stringify(readback.questionOptions) ||
    JSON.stringify(question.options) !== JSON.stringify(GO_OPTIONS)
  ) {
    return refuse('bridge question does not match the read-back');
  }

  // Rules 1 and 2. Both choices of a choice2 set `accepted`, so the result decides.
  if (question.state === 'open') return refuse('not answered yet');
  if (question.result === `Chose ${GO_OPTIONS[1]}`) return refuse('Colin chose Cancel');
  if (question.state !== 'accepted' || question.result !== `Chose ${GO_OPTIONS[0]}`) return refuse('answer is not Go');

  // Rule 3: only the bridge writes these two values.
  if (question.answeredVia !== 'push' && question.answeredVia !== 'tab') return refuse('answer was not written by the bridge');

  if (typeof question.answeredAt !== 'string' || !CLOSER_TIME.test(question.answeredAt)) return refuse('answer time is missing or malformed');
  if (typeof question.createdAt !== 'string' || !CLOSER_TIME.test(question.createdAt)) return refuse('question time is missing or malformed');
  const answeredAtMs = Date.parse(question.answeredAt);
  const createdAtMs = Date.parse(question.createdAt);

  if (!pushedBefore(deps.pushLogPath ?? pushLog(), readback.questionId, answeredAtMs)) {
    return refuse('no push-log entry for the Go question before the answer');
  }

  // Rule 4.
  if (answeredAtMs < createdAtMs || answeredAtMs < Date.parse(readback.sentAt)) return refuse('answered before the read-back was sent');
  if (answeredAtMs > now.getTime() + CLOCK_SKEW_MS) return refuse('answer time is in the future');
  if (now.getTime() - answeredAtMs >= GO_EXPIRY_MS) return refuse('go expired (30 minutes)');
  if (answeredAtMs - createdAtMs > GO_EXPIRY_MS) return refuse('go expired (answered more than 30 minutes after the read-back)');

  // Must-do 3a: any edit after the read-back voids the Go.
  const stored = readBrief(errandId, home);
  const checked = stored ? validateBrief(stored) : null;
  if (!checked?.ok || briefHash(checked.brief) !== readback.briefHash) return refuse('brief edited after read-back');
  // Wave C R2: readback.json sits beside the brief, so it cannot vouch for it. The brief on disk
  // must render to the text Colin tapped Go on, as the bridge recorded it.
  const number = normaliseUkNumber(checked.brief.number);
  if (!number.ok || questionTextFor(renderReadback(checked.brief, number.e164)) !== question.text) {
    return refuse('brief edited after read-back');
  }

  // Must-do 3c.
  if (readGoUsed(errandId, home)) return refuse('go already used');

  return {
    ok: true,
    go: {
      questionId: readback.questionId,
      jobId: readback.jobId,
      answeredAt: question.answeredAt,
      answeredVia: question.answeredVia,
      briefHash: readback.briefHash,
      dialNumber: number.e164,
    },
  };
}

/**
 * Consume the Go: `go-used.json` by exclusive create, written before any call is placed.
 * Two dial steps racing on one Go both pass `checkGo`, and exactly one wins this write.
 */
export function markGoUsed(errandId: string, go: GoRecord, now: Date, home: string = errandHome()): { ok: true } | { ok: false; reason: string } {
  const record: GoUsed = { ...go, usedAt: now.toISOString() };
  try {
    writeGoUsed(errandId, record, home);
    return { ok: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: 'go already used' };
    throw error;
  }
}
