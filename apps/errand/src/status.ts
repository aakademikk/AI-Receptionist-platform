import { MAX_CALL_S, errandHome, maskSid } from './config.ts';
import { type ReportDeps, reportOnce } from './report.ts';
import { type Outcome, appendEvent, readOutcome, writeOutcome } from './store.ts';

/**
 * The status callback (must-dos 12, 16, 17, 18).
 *
 * Twilio posts every call status change here. Each one is logged — status, `AnsweredBy` when
 * present, duration, time, masked CallSid — because together they are the call's record
 * (must-do 17). On the terminal one the outcome is settled if the call session did not settle
 * it (a socket drop, a call that never reached the socket), and Colin is told, once.
 *
 *   no-answer, busy, failed, canceled   not reached, with the reason
 *   completed, duration >= 480 s        ended early: maximum length (Twilio's TimeLimit fired)
 *   completed otherwise                 failed: call ended with no outcome
 *
 * **Nothing here can place a call** (must-do 18). This module imports neither the call create
 * nor the dial step, and a test reads its source to keep it that way: a "no answer" is
 * reported, never redialled.
 */

export const TERMINAL_STATUSES = new Set(['completed', 'no-answer', 'busy', 'failed', 'canceled']);

const NOT_REACHED_REASON: Record<string, string> = {
  'no-answer': 'no answer',
  busy: 'busy',
  failed: 'call failed',
  canceled: 'call canceled',
};

export function outcomeFromStatus(status: string, durationS: number | null, at: string): Outcome {
  if (status === 'completed') {
    if (durationS !== null && durationS >= MAX_CALL_S) return { kind: 'ended_early', limit: 'maximum length', source: 'status', at };
    return { kind: 'failed', reason: 'call ended with no outcome', source: 'status', at };
  }
  return { kind: 'not_reached', reason: NOT_REACHED_REASON[status] ?? status, source: 'status', at };
}

export type StatusDeps = ReportDeps;

/**
 * Handle one status post. The outcome is settled synchronously; the report is returned as a
 * promise and not awaited by the server, so a slow notifier never holds Twilio's request open
 * (Twilio would time out and retry; the report's exclusive claim makes that harmless anyway).
 */
export function handleStatus(errandId: string, params: Record<string, string>, deps: StatusDeps): { reported: Promise<boolean> | null } {
  const home = deps.home ?? errandHome();
  const now = deps.now ?? (() => new Date());
  const status = params.CallStatus ?? 'unknown';
  const duration = params.CallDuration !== undefined && /^\d+$/.test(params.CallDuration) ? Number(params.CallDuration) : null;
  const at = now();
  appendEvent(
    errandId,
    { kind: 'status', status, answeredBy: params.AnsweredBy ?? null, duration, callSid: maskSid(params.CallSid) },
    at,
    home,
  );
  if (!TERMINAL_STATUSES.has(status)) return { reported: null };
  if (!readOutcome(errandId, home)) writeOutcome(errandId, outcomeFromStatus(status, duration, at.toISOString()), home);
  return { reported: reportOnce(errandId, { ...deps, home }) };
}
