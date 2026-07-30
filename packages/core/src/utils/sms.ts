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
 * Trim a reply to at most `maxSegments`, cutting at a sentence boundary where
 * possible so the result still reads as a finished thought rather than a
 * mid-word truncation.
 */
export function trimToSegments(body: string, maxSegments: number): TrimResult {
  const initial = measureSms(body);
  if (initial.segments <= maxSegments) {
    return { body, wasTrimmed: false, metrics: initial };
  }

  const limit = charBudgetForSegments(initial.encoding, maxSegments);
  const chars = [...body];
  let candidate = chars.slice(0, limit).join('');

  // Prefer the last sentence end, but only if it keeps a useful amount of the
  // message — cutting 200 characters back to 20 is worse than a clean hard cut.
  const lastSentenceEnd = Math.max(
    candidate.lastIndexOf('. '),
    candidate.lastIndexOf('? '),
    candidate.lastIndexOf('! '),
  );
  if (lastSentenceEnd > limit * 0.5) {
    candidate = candidate.slice(0, lastSentenceEnd + 1);
  } else {
    const lastSpace = candidate.lastIndexOf(' ');
    if (lastSpace > limit * 0.7) candidate = `${candidate.slice(0, lastSpace)}…`;
  }

  const trimmed = candidate.trim();
  return { body: trimmed, wasTrimmed: true, metrics: measureSms(trimmed) };
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
