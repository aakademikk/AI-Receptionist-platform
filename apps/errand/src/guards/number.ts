/**
 * The number guard (must-do 4; OPEN 13).
 *
 * The dial step refuses any number that is not an allowed UK kind. Allowed: geographic 01
 * and 02, non-geographic 03, mobiles 071 to 075 and 077 to 079, and 080 freephone. Refused,
 * each with its own reason so SAM can tell Colin exactly why: 999 and 112, premium and
 * chargeable numbers (09, and 118 directory enquiries), 070 personal numbers, 076 pagers,
 * 084 and 087 (refused in the first release, OPEN 13), anything outside +44, and anything
 * that is not a UK number shape.
 *
 * Emergency numbers are refused before any normalising, on the bare digits, so no spelling
 * of 999 can be normalised into something that looks dialable. The 118 directory check is
 * on the six-digit short form only: `0118` is Reading's area code and is an ordinary
 * geographic number.
 *
 * The same function normalises the number for the read-back (T6) and checks it again in the
 * dial step (T11), so what Colin was shown is exactly what is dialled.
 */

export type NumberCheckResult = { ok: true; e164: string } | { ok: false; reason: string };

export const REASON_EMERGENCY = 'emergency number';
export const REASON_PREMIUM = 'premium or chargeable';
export const REASON_PERSONAL = 'personal number';
export const REASON_PAGER = 'pager';
export const REASON_084_087 = '084/087 refused in the first release';
export const REASON_ABROAD = 'outside the UK';
export const REASON_SHAPE = 'not a UK number shape';

const EMERGENCY = new Set(['999', '112']);

export function normaliseUkNumber(input: string): NumberCheckResult {
  const refuse = (reason: string): NumberCheckResult => ({ ok: false, reason });
  const compact = input.replace(/[\s().\-]/g, '');

  if (EMERGENCY.has(compact)) return refuse(REASON_EMERGENCY);
  if (/^118\d{3}$/.test(compact)) return refuse(REASON_PREMIUM);
  if (!/^\+?\d+$/.test(compact)) return refuse(REASON_SHAPE);

  let national: string;
  if (compact.startsWith('+')) {
    if (!compact.startsWith('+44')) return refuse(REASON_ABROAD);
    national = compact.slice(3);
  } else if (compact.startsWith('00')) {
    if (!compact.startsWith('0044')) return refuse(REASON_ABROAD);
    national = compact.slice(4);
  } else if (compact.startsWith('0')) {
    national = compact.slice(1);
  } else {
    return refuse(REASON_SHAPE);
  }
  // `+44 (0)20 ...` keeps its trunk zero once the brackets are gone.
  if (national.startsWith('0')) national = national.slice(1);

  if (EMERGENCY.has(national)) return refuse(REASON_EMERGENCY);
  if (national.startsWith('9')) return refuse(REASON_PREMIUM);
  if (national.startsWith('70')) return refuse(REASON_PERSONAL);
  if (national.startsWith('76')) return refuse(REASON_PAGER);
  if (national.startsWith('84') || national.startsWith('87')) return refuse(REASON_084_087);

  const mobile = /^7[1-57-9]/.test(national);
  const geographic = /^[12]/.test(national);
  const nonGeographic = national.startsWith('3');
  const freephone = national.startsWith('80');
  if (!mobile && !geographic && !nonGeographic && !freephone) return refuse(REASON_SHAPE);

  // Ten digits after the trunk zero, the UK norm; a few 01 areas and some 0800 numbers have nine.
  // 02 numbers are always ten.
  const nineAllowed = national.startsWith('1') || freephone;
  if (national.length !== 10 && !(nineAllowed && national.length === 9)) return refuse(REASON_SHAPE);

  return { ok: true, e164: `+44${national}` };
}
