import type { OpeningHoursContext } from '../types/domain.ts';

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * Is the business open at `at`, in its own timezone?
 *
 * The timezone handling is the whole point of this function. A naive
 * `new Date().getDay()` uses the *server's* timezone, which on Vercel is UTC — so
 * a London business would be told it was closed for an hour every summer evening,
 * and an Australian one would be wrong by most of a day. Everything here goes
 * through `Intl.DateTimeFormat` with the tenant's zone.
 */
export function isOpenNow(
  hours: OpeningHoursContext[],
  at: Date = new Date(),
  timezone = 'UTC',
): boolean {
  if (hours.length === 0) return false;

  const local = getLocalParts(at, timezone);
  const today = hours.find((h) => h.day_of_week === local.dayOfWeek);

  if (!today || today.is_closed || !today.opens_at || !today.closes_at) return false;

  const nowMinutes = local.hour * 60 + local.minute;
  const opens = parseTimeToMinutes(today.opens_at);
  const closes = parseTimeToMinutes(today.closes_at);
  if (opens === null || closes === null) return false;

  // A closing time before the opening time means the shift runs past midnight
  // (22:00–02:00). Late-night trades exist, and treating this as "never open"
  // would silently break them.
  if (closes <= opens) {
    return nowMinutes >= opens || nowMinutes < closes;
  }

  return nowMinutes >= opens && nowMinutes < closes;
}

/**
 * Human-readable hours for the prompt, with consecutive identical days collapsed
 * ("Monday to Friday, 09:00–17:30") because seven separate lines reads like a
 * database dump and wastes prompt budget.
 */
export function describeOpeningHours(hours: OpeningHoursContext[]): string {
  if (hours.length === 0) return 'Opening hours have not been published.';

  // Present Monday-first, which is how most of the world reads a week, while the
  // stored data is Sunday-indexed to match JavaScript's getDay().
  const ordered = [1, 2, 3, 4, 5, 6, 0]
    .map((day) => hours.find((h) => h.day_of_week === day))
    .filter((h): h is OpeningHoursContext => Boolean(h));

  if (ordered.length === 0) return 'Opening hours have not been published.';

  const groups: Array<{ days: number[]; label: string }> = [];

  for (const entry of ordered) {
    const label = entry.is_closed
      ? 'Closed'
      : `${formatTime(entry.opens_at)}–${formatTime(entry.closes_at)}`;

    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.days.push(entry.day_of_week);
    } else {
      groups.push({ days: [entry.day_of_week], label });
    }
  }

  return groups
    .map((group) => {
      const first = DAY_NAMES[group.days[0]!]!;
      if (group.days.length === 1) return `- ${first}: ${group.label}`;
      const last = DAY_NAMES[group.days[group.days.length - 1]!]!;
      return `- ${first} to ${last}: ${group.label}`;
    })
    .join('\n');
}

/**
 * Next opening moment at or after `from`. Used to tell a caller when someone will
 * actually get back to them instead of a vague "soon".
 */
export function nextOpeningTime(
  hours: OpeningHoursContext[],
  from: Date = new Date(),
  timezone = 'UTC',
): Date | null {
  if (hours.length === 0) return null;
  if (isOpenNow(hours, from, timezone)) return from;

  const local = getLocalParts(from, timezone);

  // Look ahead a week; if nothing is open in seven days, nothing is open.
  for (let offset = 0; offset < 8; offset += 1) {
    const dayOfWeek = (local.dayOfWeek + offset) % 7;
    const entry = hours.find((h) => h.day_of_week === dayOfWeek);
    if (!entry || entry.is_closed || !entry.opens_at) continue;

    const opens = parseTimeToMinutes(entry.opens_at);
    if (opens === null) continue;

    // Today only counts if opening is still ahead of us.
    if (offset === 0 && local.hour * 60 + local.minute >= opens) continue;

    const candidate = new Date(from);
    candidate.setUTCDate(candidate.getUTCDate() + offset);

    // Rebuild the instant from the tenant-local wall clock. Comparing the
    // resulting local time back against the target absorbs the DST offset, which
    // a plain setUTCHours would get wrong twice a year.
    const targetHour = Math.floor(opens / 60);
    const targetMinute = opens % 60;

    const localParts = getLocalParts(candidate, timezone);
    const deltaMinutes =
      targetHour * 60 + targetMinute - (localParts.hour * 60 + localParts.minute);

    return new Date(candidate.getTime() + deltaMinutes * 60_000);
  }

  return null;
}

/** True when the local time falls inside the configured quiet window. */
export function isWithinQuietHours(
  start: string | null,
  end: string | null,
  at: Date = new Date(),
  timezone = 'UTC',
): boolean {
  if (!start || !end) return false;

  const local = getLocalParts(at, timezone);
  const nowMinutes = local.hour * 60 + local.minute;
  const from = parseTimeToMinutes(start);
  const to = parseTimeToMinutes(end);
  if (from === null || to === null) return false;

  // Quiet hours almost always wrap midnight (21:00–08:00), so this branch is the
  // common case rather than the edge case.
  if (to <= from) return nowMinutes >= from || nowMinutes < to;
  return nowMinutes >= from && nowMinutes < to;
}

interface LocalParts {
  dayOfWeek: number;
  hour: number;
  minute: number;
}

function getLocalParts(at: Date, timezone: string): LocalParts {
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const parts = formatter.formatToParts(at);
    const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
    const hourRaw = parts.find((p) => p.type === 'hour')?.value ?? '0';
    const minute = Number.parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);

    // en-GB renders midnight as "24" in some runtimes; normalise to 0.
    const hour = Number.parseInt(hourRaw, 10) % 24;

    const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);

    return {
      dayOfWeek: dayIndex >= 0 ? dayIndex : at.getUTCDay(),
      hour: Number.isNaN(hour) ? 0 : hour,
      minute: Number.isNaN(minute) ? 0 : minute,
    };
  } catch {
    // An invalid timezone in a tenant record must degrade to UTC, not throw on
    // every inbound message.
    return { dayOfWeek: at.getUTCDay(), hour: at.getUTCHours(), minute: at.getUTCMinutes() };
  }
}

function parseTimeToMinutes(value: string | null): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!match) return null;
  const hour = Number.parseInt(match[1]!, 10);
  const minute = Number.parseInt(match[2]!, 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return hour * 60 + minute;
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  const match = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!match) return value;
  return `${match[1]!.padStart(2, '0')}:${match[2]}`;
}
