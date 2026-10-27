import { createHash } from 'node:crypto';

/**
 * The per-call brief (must-do 1).
 *
 * SAM writes one of these from Colin's chat before anything else happens. It is the whole
 * of what Amy is allowed to know and do on the call: who she is ringing, what for, inside
 * which window, the details the goal needs, the one name and mobile she may give, and the
 * limits. Anything not in the brief, she does not have.
 *
 * The brief is also what Colin's Go is for. Its hash is recorded with the read-back, and the
 * dial step refuses when the brief on disk no longer hashes to the same value — so an edit
 * after the read-back, however small, voids the Go (must-do 3a). That is why the hash is
 * over canonical JSON (keys sorted at every level): the same brief must always give the
 * same hash however it was serialised, and any change to any field must give a different one.
 */

/** What kind of errand. A table booking is the first case and the only one with required details. */
export type GoalKind = 'table' | 'other';

/**
 * The guardrails every errand carries, by name (spec "Must do" 9 to 15 and OPEN 3). They are
 * listed in the brief so the read-back shows Colin exactly what Amy is held to; the code
 * enforces each one regardless of what the brief says.
 */
export const FIXED_LIMITS: readonly string[] = [
  'any time inside the window, never outside it',
  "gives only Colin's name and mobile",
  'rings off if asked for payment, card, deposit or bank details',
  'agrees nothing beyond the goal',
  'turn cap 20',
  'maximum call length 8 minutes',
];

export interface BriefWindow {
  /** `YYYY-MM-DD`, UK local date. */
  date: string;
  /** `HH:MM`, UK local time, the earliest acceptable time (inclusive). */
  earliest: string;
  /** `HH:MM`, UK local time, the latest acceptable time (inclusive). */
  latest: string;
}

export interface Brief {
  /** The business's name, as Amy will say it and as the report will show it. */
  business: string;
  /** The number as SAM was given it. The dial step normalises it; the read-back shows the result. */
  number: string;
  /** The goal in plain words, for example "book a table for two". */
  goal: string;
  goalKind: GoalKind;
  window: BriefWindow;
  /** Free key-value details the goal needs. For a table, `partySize` is required. */
  details: Record<string, string | number>;
  /** The name and mobile Amy may give: Colin's. The callback number is always this mobile. */
  contact: { name: string; mobile: string };
  /** The fixed guardrails by name, plus any Colin adds as text. */
  limits: { fixed: string[]; added: string[] };
  /**
   * Colin's after-hours consent (OPEN 14, changed 2026-10-27): present and `true` only when this
   * call may dial outside the calling hours. The read-back says so, and his Go on it is the consent.
   */
  afterHours?: true;
}

export type BriefValidation = { ok: true; brief: Brief } | { ok: false; field: string; error: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function realDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Minutes after midnight for an `HH:MM` string already checked against `TIME`. */
export function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/**
 * Check a brief and return it in its stored shape.
 *
 * The one normalisation is the fixed limits: when the brief names none, the full list is
 * filled in, so SAM does not have to copy it out each time. When it names some, every
 * fixed limit must be there — a brief cannot drop a guardrail by leaving it out. Nothing
 * else is changed: the number in particular stays exactly as given, and the read-back
 * shows the normalised form beside it.
 *
 * A failure names the field, so SAM can ask Colin for exactly what is missing.
 */
export function validateBrief(input: unknown): BriefValidation {
  const fail = (field: string, error: string): BriefValidation => ({ ok: false, field, error });
  if (!isRecord(input)) return fail('brief', 'must be an object');

  if (!nonEmpty(input.business)) return fail('business', 'the business name is required');
  if (!nonEmpty(input.number)) return fail('number', 'the number to dial is required');
  if (!nonEmpty(input.goal)) return fail('goal', 'the goal in plain words is required');
  if (input.goalKind !== 'table' && input.goalKind !== 'other') return fail('goalKind', 'must be "table" or "other"');

  const window = input.window;
  if (!isRecord(window)) return fail('window', 'the window (date, earliest, latest) is required');
  if (typeof window.date !== 'string' || !realDate(window.date)) return fail('window.date', 'must be a real date, YYYY-MM-DD');
  if (typeof window.earliest !== 'string' || !TIME.test(window.earliest)) return fail('window.earliest', 'must be HH:MM');
  if (typeof window.latest !== 'string' || !TIME.test(window.latest)) return fail('window.latest', 'must be HH:MM');
  if (minutesOf(window.earliest) > minutesOf(window.latest)) return fail('window', 'earliest is after latest');

  const details = input.details ?? {};
  if (!isRecord(details)) return fail('details', 'must be an object of key-value details');
  for (const [key, value] of Object.entries(details)) {
    if (typeof value !== 'string' && typeof value !== 'number') return fail(`details.${key}`, 'must be text or a number');
  }
  if (input.goalKind === 'table') {
    const size = details.partySize;
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
      return fail('details.partySize', 'a table booking needs the party size, a whole number of at least 1');
    }
  }

  const contact = input.contact;
  if (!isRecord(contact)) return fail('contact', "Colin's name and mobile are required");
  if (!nonEmpty(contact.name)) return fail('contact.name', "Colin's name is required");
  if (!nonEmpty(contact.mobile)) return fail('contact.mobile', "Colin's mobile is required");

  const limits = input.limits ?? {};
  if (!isRecord(limits)) return fail('limits', 'must be an object with fixed and added lists');
  const fixed = limits.fixed ?? [...FIXED_LIMITS];
  if (!Array.isArray(fixed) || !fixed.every((item) => typeof item === 'string')) return fail('limits.fixed', 'must be a list of text');
  for (const limit of FIXED_LIMITS) {
    if (!fixed.includes(limit)) return fail('limits.fixed', `missing the fixed limit "${limit}"`);
  }
  const added = limits.added ?? [];
  if (!Array.isArray(added) || !added.every((item) => nonEmpty(item))) return fail('limits.added', 'must be a list of text');

  if (input.afterHours !== undefined && input.afterHours !== true) return fail('afterHours', 'must be true, or left out');

  return {
    ok: true,
    brief: {
      business: input.business.trim(),
      number: input.number.trim(),
      goal: input.goal.trim(),
      goalKind: input.goalKind,
      window: { date: window.date, earliest: window.earliest, latest: window.latest },
      details: details as Record<string, string | number>,
      contact: { name: contact.name.trim(), mobile: contact.mobile.trim() },
      limits: { fixed: fixed as string[], added: (added as string[]).map((item) => item.trim()) },
      // Only when set, so a brief without it hashes as it always did.
      ...(input.afterHours === true ? { afterHours: true as const } : {}),
    },
  };
}

/** JSON with object keys sorted at every level, so one brief always serialises one way. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** sha256 of the brief's canonical JSON, hex. Any edit to any field changes it. */
export function briefHash(brief: Brief): string {
  return createHash('sha256').update(canonicalJson(brief)).digest('hex');
}
