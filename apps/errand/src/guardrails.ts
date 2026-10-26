import { type Brief, minutesOf } from './brief.ts';
import { ROBOT_NUMBER } from './config.ts';

/**
 * Guardrails checked in code (must-dos 9, 10, 11, 15).
 *
 * The prompt tells Amy the rules; these functions make sure the rules hold even when the
 * model forgets them. They are pure, run on every turn by the turn engine (T15), and each
 * one errs towards caution: a false alarm ends a call politely or swaps a line for a safe
 * one, while a miss could hand a card number or a stranger's booking to a business.
 *
 *  * `checkTheirWords` reads what the other side said, and spots a payment ask: card,
 *    expiry, security code, deposit, pre-payment, bank details, or a long run of digits read
 *    out. Any of these ends the call politely (must-do 11). It is the business's words that
 *    are checked, because a deposit can be asked for in many ways and the answer is always no.
 *  * `checkAmyLine` reads what Amy is about to say, and blocks any phone number other than
 *    Colin's mobile (the robot number always), an email address, a postal address, a date of
 *    birth or a card or bank detail (must-do 10); and agreement to anything beyond the goal —
 *    a deposit, an extra, a sign-up, a membership, a change to another booking (must-do 15).
 *    A blocked line is replaced by a fixed one, never sent.
 *  * `checkAgreedTime` holds the window: a time Amy would agree must sit inside it, edges
 *    included (must-do 9). A time outside is refused and kept as an offered time for the report.
 *  * `callbackNumber` is always Colin's mobile from the brief, never the robot number.
 *
 * These are the errand's own patterns. The receptionist's handover patterns in
 * `@atwood/core/domain` are a different job and are neither reused nor changed.
 */

export const PERSONAL_DETAILS_LINE = 'Colin will give that to you directly.';
export const EXTRAS_LINE = 'I can only book the table today, thank you.';
export const EXTRAS_LINE_OTHER = 'I can only do what Colin asked today, thank you.';

export type PaymentKind =
  | 'card'
  | 'expiry'
  | 'security code'
  | 'deposit'
  | 'pre-payment'
  | 'pay now'
  | 'bank details'
  | 'long number';

export type TheirWordsCheck = { kind: 'ok' } | { kind: 'payment'; matched: PaymentKind };

/** Ordered: the more specific kinds first, so the report names the clearest one. */
const PAYMENT_PATTERNS: Array<[PaymentKind, RegExp]> = [
  ['security code', /\b(cvv|cvc|cv2|security code|three digits on the back|3 digits on the back)\b/i],
  ['expiry', /\b(expiry|expiration|expires? (date|on)|valid (until|thru|through))\b/i],
  ['bank details', /\b(bank (details|account|transfer)|sort code|account number|iban)\b/i],
  ['deposit', /\b(deposit|down ?payment)\b/i],
  ['pre-payment', /\b(pre-?pay(ment)?|pay (up ?front|in advance)|payment in advance)\b/i],
  ['pay now', /\b(pay now|pay (it )?today|take (a |the )?payment|make (a |the )?payment|payment details)\b/i],
  ['card', /\b(cards?|card number|long number on the card|card details|credit|debit)\b/i],
];

const NUMBER_WORDS = /\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/gi;

/** The longest run of digits in `text` allowing spaces and dashes between them. */
function longestDigitRun(text: string): number {
  let best = 0;
  for (const match of text.matchAll(/\d[\d\s-]*\d|\d/g)) {
    best = Math.max(best, match[0].replace(/\D/g, '').length);
  }
  // Digits read out as words: "four five six seven ..." — count consecutive number words.
  let run = 0;
  let lastEnd = -1;
  for (const match of text.matchAll(NUMBER_WORDS)) {
    const gap = lastEnd < 0 ? '' : text.slice(lastEnd, match.index);
    run = lastEnd >= 0 && /^[\s,-]*$/.test(gap) ? run + 1 : 1;
    lastEnd = (match.index ?? 0) + match[0].length;
    best = Math.max(best, run);
  }
  return best;
}

/** The number of digits that counts as a card or account number being read out. */
export const LONG_DIGIT_RUN = 12;

export function checkTheirWords(text: string): TheirWordsCheck {
  for (const [kind, pattern] of PAYMENT_PATTERNS) {
    if (pattern.test(text)) return { kind: 'payment', matched: kind };
  }
  if (longestDigitRun(text) >= LONG_DIGIT_RUN) return { kind: 'payment', matched: 'long number' };
  return { kind: 'ok' };
}

/** Digits only, with a UK `44` country code turned back into a trunk `0`, for comparing numbers. */
function nationalDigits(number: string): string {
  const digits = number.replace(/\D/g, '');
  return digits.startsWith('44') ? `0${digits.slice(2)}` : digits;
}

/** A phone-number-like run: nine or more digits with optional spaces, dashes, brackets or a leading +. */
const PHONE_RUN = /\+?\(?\d[\d\s()-]{7,}\d/g;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+|\b(at|@)\s*(gmail|hotmail|outlook|yahoo|icloud)\b|\bdot com\b/i;
const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;
const STREET = /\b\d+[a-z]?\s+(\w+\s+){1,3}(street|st|road|rd|avenue|ave|lane|ln|drive|close|way|crescent|terrace|place|gardens)\b/i;
const BIRTH = /\b(date of birth|d\.?o\.?b\.?|born on|birthday)\b/i;
const CARD_OR_BANK = /\b(card number|sort code|account number|cvv|cvc|security code|expiry|iban)\b/i;

const AGREEMENT = /\b(yes|yeah|sure|fine|okay|ok|agree[sd]?|happy to|that'?s (great|fine|perfect)|go ahead|please do|we'?ll take|sign (him|me|colin) up|add (it|that))\b/i;
const BEYOND_GOAL =
  /\b(deposit|extras?|add-?ons?|upgrades?|sign(ing)?[ -]?up|membership|member|newsletter|mailing list|loyalty|subscription|(change|move|cancel|amend)\w* (his|the|my|colin'?s|another|other) (other )?booking|other booking)\b/i;

export type AmyLineCheck = { ok: true } | { ok: false; kind: 'personal' | 'extras'; replacement: string };

export function checkAmyLine(line: string, brief: Brief): AmyLineCheck {
  const personal: AmyLineCheck = { ok: false, kind: 'personal', replacement: PERSONAL_DETAILS_LINE };
  const colin = nationalDigits(brief.contact.mobile);
  const robot = nationalDigits(ROBOT_NUMBER);
  for (const match of line.matchAll(PHONE_RUN)) {
    const digits = nationalDigits(match[0]);
    if (digits.length < 9) continue;
    if (digits === robot || digits !== colin) return personal;
  }
  if (EMAIL.test(line) || POSTCODE.test(line) || STREET.test(line) || BIRTH.test(line) || CARD_OR_BANK.test(line)) return personal;
  if (AGREEMENT.test(line) && BEYOND_GOAL.test(line)) {
    return { ok: false, kind: 'extras', replacement: brief.goalKind === 'table' ? EXTRAS_LINE : EXTRAS_LINE_OTHER };
  }
  return { ok: true };
}

export type AgreedTimeCheck = { ok: true; time: string } | { ok: false; offered: string };

/**
 * A time Amy would agree, held to the window. Accepts `HH:MM`, or a date and time
 * (`YYYY-MM-DD HH:MM` or with a `T`), whose date must be the window's. The edges are inside.
 * A refused time is pushed onto `offeredTimes` (once) so the report can list it.
 */
export function checkAgreedTime(time: string, window: Brief['window'], offeredTimes: string[] = []): AgreedTimeCheck {
  const match = /^(?:(\d{4}-\d{2}-\d{2})[T ])?([01]\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  const record = (): AgreedTimeCheck => {
    if (!offeredTimes.includes(time.trim())) offeredTimes.push(time.trim());
    return { ok: false, offered: time.trim() };
  };
  if (!match) return record();
  const [, date, hh, mm] = match;
  if (date && date !== window.date) return record();
  const hhmm = `${hh}:${mm}`;
  const minutes = minutesOf(hhmm);
  if (minutes < minutesOf(window.earliest) || minutes > minutesOf(window.latest)) return record();
  return { ok: true, time: hhmm };
}

/** The callback number Amy gives: Colin's mobile, from the brief, always. */
export function callbackNumber(brief: Brief): string {
  return brief.contact.mobile;
}
