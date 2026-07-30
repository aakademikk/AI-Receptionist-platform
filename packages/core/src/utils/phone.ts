/**
 * Phone number handling.
 *
 * Deliberately not a full libphonenumber dependency. We need three things:
 * a canonical storage key, a display form, and confidence that a string we are
 * about to hand to Twilio is dialable. Full national-format parsing for 200
 * countries is not on that list, and the SQL side already has a matching
 * `normalize_phone()` that must agree with this function — a simpler rule is
 * easier to keep in step across two languages.
 *
 * If a tenant ever needs true national-format entry, swap the internals here and
 * the SQL function together, and nothing else has to change.
 */

/** Default dialling codes for the regions we currently sell into. */
const REGION_DIAL_CODES: Record<string, string> = {
  GB: '44',
  US: '1',
  CA: '1',
  IE: '353',
  AU: '61',
  NZ: '64',
  ZA: '27',
};

/** Trunk prefix stripped when promoting a national number to E.164. */
const REGION_TRUNK_PREFIX: Record<string, string> = {
  GB: '0',
  IE: '0',
  AU: '0',
  NZ: '0',
  ZA: '0',
};

export interface NormalizeResult {
  e164: string | null;
  /** Why normalisation failed, for logging. Null on success. */
  reason: string | null;
}

/**
 * Normalise to E.164.
 *
 * Must produce the same output as `public.normalize_phone()` in SQL for any input
 * that function accepts, because that function backs a unique index — a
 * disagreement between the two would create duplicate contacts.
 */
export function normalizePhone(raw: string | null | undefined, defaultRegion = 'GB'): NormalizeResult {
  if (!raw) return { e164: null, reason: 'empty' };

  const trimmed = raw.trim();
  if (trimmed === '') return { e164: null, reason: 'empty' };

  // Already international.
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) {
      return { e164: null, reason: `implausible length (${digits.length} digits)` };
    }
    if (digits.startsWith('0')) {
      return { e164: null, reason: 'country code cannot begin with 0' };
    }
    return { e164: `+${digits}`, reason: null };
  }

  // 00 as an international prefix (common in Europe).
  if (trimmed.startsWith('00')) {
    return normalizePhone(`+${trimmed.slice(2)}`, defaultRegion);
  }

  const digits = trimmed.replace(/\D/g, '');
  if (digits === '') return { e164: null, reason: 'no digits' };

  const dialCode = REGION_DIAL_CODES[defaultRegion.toUpperCase()];
  if (!dialCode) {
    return { e164: null, reason: `unknown default region ${defaultRegion}` };
  }

  const trunk = REGION_TRUNK_PREFIX[defaultRegion.toUpperCase()];
  let national = digits;

  if (trunk && national.startsWith(trunk)) {
    national = national.slice(trunk.length);
  } else if (national.startsWith(dialCode) && national.length > dialCode.length + 6) {
    // Someone typed "447700900123" without the plus.
    return { e164: `+${national}`, reason: null };
  }

  if (national.length < 6 || national.length > 14) {
    return { e164: null, reason: `implausible national length (${national.length} digits)` };
  }

  return { e164: `+${dialCode}${national}`, reason: null };
}

/** Throwing variant, for paths where an unusable number is a hard error. */
export function requirePhone(raw: string | null | undefined, defaultRegion = 'GB'): string {
  const { e164, reason } = normalizePhone(raw, defaultRegion);
  if (!e164) {
    throw new Error(`Cannot normalise phone number ${JSON.stringify(raw)}: ${reason}`);
  }
  return e164;
}

/** Loose plausibility check for an already-E.164 string. */
export function isValidE164(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value);
}

/**
 * Readable form for the dashboard. Grouping is approximate by design — a wrong
 * grouping is cosmetic, whereas a wrong digit would not be, so the digits are
 * never altered.
 */
export function formatPhoneForDisplay(e164: string | null | undefined): string {
  if (!e164) return '';
  if (!e164.startsWith('+')) return e164;

  // UK mobile: +447700900123 -> +44 7700 900123
  const uk = /^\+44(7\d{3})(\d{6})$/.exec(e164);
  if (uk) return `+44 ${uk[1]} ${uk[2]}`;

  // UK landline: +441134960001 -> +44 113 496 0001
  const ukLandline = /^\+44(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (ukLandline) return `+44 ${ukLandline[1]} ${ukLandline[2]} ${ukLandline[3]}`;

  // NANP: +14155550123 -> +1 (415) 555-0123
  const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (nanp) return `+1 (${nanp[1]}) ${nanp[2]}-${nanp[3]}`;

  return e164;
}

/** Last four digits, for referring to a caller in a notification without exposing the number. */
export function phoneTail(e164: string | null | undefined): string {
  if (!e164) return '';
  return e164.slice(-4);
}

/**
 * Postcode outward code ("LS6 2AH" -> "LS6"), used for the in-area check against
 * `service_areas.postcode_prefixes`.
 */
export function outwardCode(postcode: string | null | undefined): string | null {
  if (!postcode) return null;
  const cleaned = postcode.toUpperCase().replace(/\s+/g, '');
  const match = /^([A-Z]{1,2}\d{1,2}[A-Z]?)/.exec(cleaned);
  return match ? match[1]! : null;
}

/** Whether a postcode falls inside any configured service area. */
export function isInServiceArea(
  postcode: string | null | undefined,
  areas: Array<{ name: string; postcode_prefixes: string[] }>,
): { inArea: boolean; matchedArea: string | null } {
  const outward = outwardCode(postcode);
  if (!outward) return { inArea: false, matchedArea: null };

  for (const area of areas) {
    if (area.postcode_prefixes.some((prefix) => prefix.toUpperCase() === outward)) {
      return { inArea: true, matchedArea: area.name };
    }
  }

  return { inArea: false, matchedArea: null };
}
