/**
 * SMS length handling.
 *
 * Twilio bills per segment, not per message, so an AI that writes 500-character
 * replies quietly quadruples a tenant's messaging bill. Worse, a message split
 * across segments can arrive out of order on some carriers, which makes a
 * two-part reply read as nonsense.
 *
 * The prompt asks for brevity; this enforces a ceiling regardless of what the
 * model actually produced.
 */

/** Characters outside GSM-03.38 force the whole message to UCS-2 (fewer chars/segment). */
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

/** These occupy two GSM septets each. */
const GSM_EXTENDED = '^{}\\[~]|€';

export type SmsEncoding = 'GSM-7' | 'UCS-2';

export interface SmsMetrics {
  encoding: SmsEncoding;
  characters: number;
  segments: number;
}

export function measureSms(body: string): SmsMetrics {
  const chars = [...body];

  let isGsm = true;
  let septets = 0;

  for (const char of chars) {
    if (GSM_BASIC.includes(char)) {
      septets += 1;
    } else if (GSM_EXTENDED.includes(char)) {
      septets += 2;
    } else {
      isGsm = false;
      break;
    }
  }

  if (isGsm) {
    // Single segment holds 160 septets; concatenated messages give up 7 to the
    // UDH header, leaving 153.
    const segments = septets <= 160 ? 1 : Math.ceil(septets / 153);
    return { encoding: 'GSM-7', characters: septets, segments: Math.max(segments, 1) };
  }

  // UCS-2: emoji and other astral-plane characters take two code units, so count
  // units rather than code points or the estimate is low.
  const units = [...body].reduce((total, char) => total + (char.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  const segments = units <= 70 ? 1 : Math.ceil(units / 67);
  return { encoding: 'UCS-2', characters: units, segments: Math.max(segments, 1) };
}

export interface TrimResult {
  body: string;
  wasTrimmed: boolean;
  metrics: SmsMetrics;
}

/**
 * What `char` costs in `encoding`, counted the way measureSms counts: septets
 * for GSM-7 (two for the extended set), UTF-16 code units for UCS-2 (two for
 * an astral character such as an emoji).
 */
function unitCost(char: string, encoding: SmsEncoding): number {
  if (encoding === 'UCS-2') return char.codePointAt(0)! > 0xffff ? 2 : 1;
  if (GSM_BASIC.includes(char)) return 1;
  return GSM_EXTENDED.includes(char) ? 2 : 0;
}

/**
 * The longest prefix of `body` that still costs `budget` units or fewer.
 *
 * This walks code points instead of slicing by count, because the two are not
 * the same thing: an emoji is one code point but two UCS-2 units, so a
 * `[...body].slice(0, budget)` overruns the budget on any body containing one.
 */
function takeWithin(body: string, budget: number, encoding: SmsEncoding): string {
  let used = 0;
  let taken = '';
  for (const char of body) {
    const cost = unitCost(char, encoding);
    if (used + cost > budget) break;
    used += cost;
    taken += char;
  }
  return taken;
}

/**
 * Trim a reply to at most `maxSegments`, cutting at a sentence boundary where
 * possible so the result still reads as a finished thought rather than a
 * mid-word truncation.
 */
export function trimToSegments(body: string, maxSegments: number): TrimResult {
  const initial = measureSms(body);
  const cap = Math.max(maxSegments, 1);

  if (initial.segments <= cap) {
    return { body, wasTrimmed: false, metrics: initial };
  }

  const limit = charBudgetForSegments(initial.encoding, cap);

  // The ellipsis has to be paid for out of the budget it is appended to, and it
  // has to be a character the encoding can already carry. U+2026 is not in
  // GSM-7, so appending it to a GSM-7 body re-encodes the entire message to
  // UCS-2 — 67 units per segment instead of 153 — and a body trimmed to fit two
  // segments arrives as five. Three ASCII dots cost two extra septets and keep
  // the message in GSM-7, which is much the cheaper trade.
  const ellipsis = initial.encoding === 'GSM-7' ? '...' : '…';
  const headroom = Math.max(limit - ellipsis.length, 0);

  const candidate = takeWithin(body, headroom, initial.encoding);

  // Prefer the last sentence end, but only if it keeps a useful amount of the
  // message — cutting 200 characters back to 20 is worse than a clean hard cut.
  // Both thresholds are measured against the candidate's own budget, so they
  // describe the fraction of the message kept rather than an absolute length.
  const lastSentenceEnd = Math.max(
    candidate.lastIndexOf('. '),
    candidate.lastIndexOf('? '),
    candidate.lastIndexOf('! '),
  );

  let trimmed: string;
  if (lastSentenceEnd > headroom * 0.5) {
    trimmed = candidate.slice(0, lastSentenceEnd + 1);
  } else {
    const lastSpace = candidate.lastIndexOf(' ');
    if (lastSpace > headroom * 0.7) {
      trimmed = `${candidate.slice(0, lastSpace)}${ellipsis}`;
    } else {
      // Neither a sentence end nor a usable word break in the back half. The
      // remaining case is one long unbroken run — a URL, a reference number — so
      // the cut lands mid-token. Mark it: without the ellipsis the customer gets a
      // text that simply stops mid-word and has no way to know it was cut, which is
      // the failure this whole function exists to avoid.
      trimmed = `${candidate}${ellipsis}`;
    }
  }

  // Every branch above returns a body costing limit units or fewer — a prefix of
  // the candidate costs no more than the candidate, and the ellipsis was paid for
  // out of the same budget — so the result cannot exceed the cap. The tests
  // assert that rather than trusting this comment.
  const result = trimmed.trim();
  return { body: result, wasTrimmed: true, metrics: measureSms(result) };
}

function charBudgetForSegments(encoding: SmsEncoding, segments: number): number {
  if (segments <= 1) return encoding === 'GSM-7' ? 160 : 70;
  return encoding === 'GSM-7' ? 153 * segments : 67 * segments;
}

/**
 * Strip artefacts a model sometimes wraps around a reply despite being told not
 * to. Cheap insurance: the alternative is a customer receiving a text that starts
 * `Here is the message to send:`.
 */
export function cleanModelReply(raw: string): string {
  let body = raw.trim();

  // Whole reply wrapped in matching quotes.
  if (
    (body.startsWith('"') && body.endsWith('"')) ||
    (body.startsWith('“') && body.endsWith('”')) ||
    (body.startsWith("'") && body.endsWith("'"))
  ) {
    body = body.slice(1, -1).trim();
  }

  // Leading label the model added.
  body = body.replace(
    /^(?:reply|response|message|sms|here(?:'s| is)(?: the)? (?:reply|response|message))\s*[:\-–]\s*/i,
    '',
  );

  // Any XML-ish block that escaped from the prompt scaffolding. Notably includes
  // <thinking>, which can leak when thinking is disabled on some models.
  body = body.replace(/<\/?(?:thinking|reasoning|scratchpad|answer|reply|message)>/gi, '');

  return body.replace(/\n{3,}/g, '\n\n').trim();
}
