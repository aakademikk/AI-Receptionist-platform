import { NO_OUTCOME_ALERT_MS, errandHome } from './config.ts';
import { ukTime } from './guards/hours.ts';
import { appendEvent, assertErrandId, dialledAt, readBrief, readOutcome, writeAlert } from './store.ts';

/**
 * The no-outcome watchdog (must-do 19).
 *
 * The dial step schedules `errand watch <id>` as a transient user timer 20 minutes after
 * dialling (T11). By then every call has ended (8-minute limit) and its status callback has
 * settled an outcome. If none exists, something broke — the status callback never arrived,
 * the service was down — and Colin gets one alert, so a dialled errand can never just go quiet.
 *
 * One alert, by exclusive create of `alert.json` before the notifier runs. A run with an
 * outcome present exits silently; a run before 20 minutes (a timer that fired early) does
 * nothing and leaves the alert for a later run.
 */

export interface WatchDeps {
  notify: (args: string[]) => Promise<number>;
  home?: string;
}

export type WatchResult = 'outcome present' | 'not dialled' | 'too early' | 'already alerted' | 'alerted';

export async function watch(errandId: string, now: Date, deps: WatchDeps): Promise<WatchResult> {
  const home = deps.home ?? errandHome();
  assertErrandId(errandId);
  if (readOutcome(errandId, home)) return 'outcome present';
  const dialled = dialledAt(errandId, home);
  if (!dialled) return 'not dialled';
  if (now.getTime() - dialled.getTime() < NO_OUTCOME_ALERT_MS) return 'too early';

  const text = `Errand ${errandId} dialled at ${ukTime(dialled)} has no outcome after 20 minutes`;
  if (!writeAlert(errandId, { text, at: now.toISOString() }, home)) return 'already alerted';
  const business = readBrief(errandId, home)?.business ?? 'unknown business';
  const code = await deps.notify([`Errand alert: ${business}`, text, '--full', text]).catch(() => -1);
  appendEvent(errandId, { kind: 'alert_sent', notifyExit: code }, now, home);
  return 'alerted';
}
