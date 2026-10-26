import { CALLING_HOURS } from '../config.ts';

/**
 * The calling-hours guard (OPEN 14).
 *
 * No errand dials outside 08:00 to 21:00 UK time. 08:00 itself dials and 21:00 itself does
 * not. The hour is read in `Europe/London`, not from a fixed offset, so the rule holds the
 * same on either side of a clock change. A refusal says what the UK time is now, so the
 * reason is useful without anyone working out time zones.
 */

export type HoursCheckResult = { ok: true } | { ok: false; reason: string };

/** `HH:MM` in the calling-hours zone. */
export function ukTime(now: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: CALLING_HOURS.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
}

export function checkCallingHours(now: Date): HoursCheckResult {
  const time = ukTime(now);
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const minutes = hour * 60 + minute;
  if (minutes >= CALLING_HOURS.startHour * 60 && minutes < CALLING_HOURS.endHour * 60) return { ok: true };
  const pad = (h: number): string => `${String(h).padStart(2, '0')}:00`;
  return {
    ok: false,
    reason: `outside calling hours (${pad(CALLING_HOURS.startHour)} to ${pad(CALLING_HOURS.endHour)} UK); it is ${time} UK time now`,
  };
}
