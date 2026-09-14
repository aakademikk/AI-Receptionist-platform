/**
 * Self-addressed messages — the platform talking to itself.
 *
 * Twilio will deliver a message from a number to that same number. That matters
 * twice over:
 *
 *  - **It is an accidental infinite loop.** The AI replies to the number it
 *    received from, so a self-addressed message produces a reply that travels
 *    back as an inbound message, which produces another reply, and so on —
 *    billing a segment pair on every turn, indefinitely, with nothing in the log
 *    that reads like a fault. A customer cannot trigger it (they cannot send
 *    *from* our number), but a misconfiguration can — and the watchdog below
 *    deliberately does.
 *  - **The watchdog needs it.** The only way to prove the whole chain — Twilio
 *    signature, tunnel, tenant resolution, model call, outbound send — without a
 *    human is to text the number from the number. So a self-addressed message is
 *    dropped *unless* it carries an explicit probe marker. The AI's reply never
 *    carries the marker, so the loop is broken at the first hop while the probe
 *    itself still gets one genuine round trip.
 */

/**
 * Marks a deliberate self-addressed probe.
 *
 * Deliberately a string no model would emit unprompted: it is not language, it
 * has no reason to appear in a reply about property management, and no customer
 * could send it, because sending it requires being the number itself.
 */
export const WATCHDOG_PROBE_MARKER = '[atwood-watchdog-probe]';

export type SelfMessageVerdict =
  /** From and To differ — an ordinary inbound message. */
  | 'normal'
  /** Addressed to itself, carrying the probe marker — process it, once. */
  | 'probe'
  /** Addressed to itself without the marker — the loop. Drop it. */
  | 'loop';

/** Strip Twilio's channel prefixes (`whatsapp:`, `sms:` …) before comparing. */
function bareNumber(value: string): string {
  return value.replace(/^[a-z]+:/i, '').replace(/\D/g, '');
}

/**
 * Whether two numbers are the same line, ignoring channel prefix and formatting.
 *
 * Digits only: the `+`, spacing, and the `whatsapp:` prefix all vary by channel,
 * and none of them change which line is being addressed.
 */
export function isSamePhoneNumber(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const left = bareNumber(a);
  return left !== '' && left === bareNumber(b);
}

/**
 * Decide what to do with an inbound message that may be addressed to our own number.
 *
 * A false positive here silently drops a real customer's message, so the loop
 * branch requires To *and* From to be present and equal — an absent or malformed
 * number can never be mistaken for a self-addressed message.
 */
export function classifySelfMessage(
  toNumber: string | null | undefined,
  fromNumber: string | null | undefined,
  body: string,
): SelfMessageVerdict {
  if (!isSamePhoneNumber(toNumber, fromNumber)) return 'normal';
  return body.includes(WATCHDOG_PROBE_MARKER) ? 'probe' : 'loop';
}
