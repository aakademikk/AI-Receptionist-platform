import { LIVE_MARGIN_MS, MAX_CALL_S, errandHome } from '../config.ts';
import { dialledAt, listErrands, readOutcome } from '../store.ts';

/**
 * One errand call at a time (must-do 6).
 *
 * An errand is live when it has a `dialled` event, no outcome yet, and was dialled less than
 * the maximum call length plus a margin ago. Past that it cannot still be on the phone
 * (Twilio's `TimeLimit` ends it), and an errand that old with no outcome is the watchdog's
 * business (T18), not a reason to block every later errand for ever.
 */

export type LiveCheckResult = { ok: true } | { ok: false; reason: string };

export function checkNoLiveErrand(now: Date, deps: { home?: string } = {}): LiveCheckResult {
  const home = deps.home ?? errandHome();
  const window = MAX_CALL_S * 1000 + LIVE_MARGIN_MS;
  for (const id of listErrands(home)) {
    const dialled = dialledAt(id, home);
    if (!dialled || readOutcome(id, home)) continue;
    if (now.getTime() - dialled.getTime() < window) return { ok: false, reason: `errand ${id} is live` };
  }
  return { ok: true };
}
