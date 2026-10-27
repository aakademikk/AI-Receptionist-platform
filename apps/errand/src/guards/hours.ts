import { CALLING_HOURS } from '../config.ts';

/**
 * The calling-hours guard (OPEN 14).
 *
 * No errand dials outside 08:00 to 21:00 UK time. 08:00 itself dials and 21:00 itself does
 * not. The hour is read in `Europe/London`, not from a fixed offset, so the rule holds the
 * same on either side of a clock change. A refusal says what the UK time is now, so the
 * reason is useful without anyone working out time zones.
 *
 * The one way past it (OPEN 14, changed by Colin 2026-10-27): a brief with `afterHours: true`.
 * The read-back shows that line and the Go is pinned to the read-back, so Colin's Go is his
 * consent; a late pizza place is open when a fixed clock says it is not. The pass carries a
 * note, so `--check` and the dial record say the override is what let it through.
 */

export type HoursCheckResult = { ok: true; note?: string } | { ok: false; reason: string };

export const AFTER_HOURS_NOTE = 'after hours, on the brief';

/** `HH:MM` in the calling-hours zone. */
export function ukTime(now: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: CALLING_HOURS.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
}

export function checkCallingHours(now: Date, options: { afterHours?: boolean } = {}): HoursCheckResult {
  const time = ukTime(now);
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const minutes = hour * 60 + minute;
  if (minutes >= CALLING_HOURS.startHour * 60 && minutes < CALLING_HOURS.endHour * 60) return { ok: true };
  if (options.afterHours === true) return { ok: true, note: AFTER_HOURS_NOTE };
  const pad = (h: number): string => `${String(h).padStart(2, '0')}:00`;
  return {
    ok: false,
    reason: `outside calling hours (${pad(CALLING_HOURS.startHour)} to ${pad(CALLING_HOURS.endHour)} UK); it is ${time} UK time now`,
  };
}
