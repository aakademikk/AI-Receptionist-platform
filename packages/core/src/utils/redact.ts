/**
 * Redaction for logs and AI call records.
 *
 * `ai_logs` stores the prompt and response of every model call, which makes it the
 * most useful table in the system for debugging and the most dangerous one for
 * privacy: a raw prompt contains the customer's name, number, postcode and
 * whatever else they typed. Storing that unredacted turns an observability table
 * into a second copy of the personal data — one that GDPR erasure would have to
 * chase, and that a support engineer browsing logs should never see.
 *
 * So: prompts are stored redacted, and `erase_contact()` deletes the rows
 * belonging to the subject anyway. Belt and braces, because logs leak.
 */

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const E164_RE = /\+\d[\d\s().-]{6,18}\d/g;
const UK_POSTCODE_RE = /\b[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}\b/gi;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;
const NI_RE = /\b[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]\b/gi;

/** Keys whose values are replaced wholesale, whatever they contain. */
const SECRET_KEYS = new Set([
  'authorization',
  'apikey',
  'api_key',
  'x-api-key',
  'secret',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'authtoken',
  'auth_token',
  'ciphertext',
  'key_hash',
  'service_role_key',
  'anon_key',
  'credentialencryptionkey',
  'credential_encryption_key',
  'internal_api_secret',
  'signature',
  'x-twilio-signature',
  'cookie',
  'set-cookie',
]);

/**
 * Redact PII from free text.
 *
 * Order matters: cards and IBANs are matched before phone numbers, because a
 * 16-digit card number also satisfies the phone pattern and mislabelling it
 * `[phone]` would leave a card number's shape visible in the logs.
 */
export function redactText(input: string): string {
  return input
    .replace(CARD_RE, (match) => (digitCount(match) >= 13 ? '[card]' : match))
    .replace(IBAN_RE, '[iban]')
    .replace(NI_RE, '[nino]')
    .replace(EMAIL_RE, '[email]')
    .replace(E164_RE, '[phone]')
    .replace(UK_POSTCODE_RE, '[postcode]');
}

/**
 * Redact a structure for storage in `ai_logs.request` / `.response`.
 *
 * Truncates long strings too: a 40KB prompt in a log row is rarely read in full
 * and quickly dominates table size.
 */
export function redactObject(value: unknown, options: { maxStringLength?: number } = {}): unknown {
  const maxStringLength = options.maxStringLength ?? 4_000;
  return walk(value, maxStringLength, 0, new WeakSet());
}

function walk(
  value: unknown,
  maxStringLength: number,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  // Depth bound guards against a pathological nested payload turning a log write
  // into a stack overflow.
  if (depth > 12) return '[depth-limit]';

  if (typeof value === 'string') {
    const redacted = redactText(value);
    return redacted.length > maxStringLength
      ? `${redacted.slice(0, maxStringLength)}…[truncated ${redacted.length - maxStringLength} chars]`
      : redacted;
  }

  if (value === null || typeof value !== 'object') return value;

  // Cyclic structures appear in SDK error objects that carry a request reference.
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    // Cap array length so a long transcript does not blow up the row.
    const capped = value.slice(0, 50).map((item) => walk(item, maxStringLength, depth + 1, seen));
    if (value.length > 50) capped.push(`[${value.length - 50} more items]`);
    return capped;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      output[key] = '[redacted]';
      continue;
    }
    output[key] = walk(item, maxStringLength, depth + 1, seen);
  }
  return output;
}

function digitCount(value: string): number {
  let count = 0;
  for (const char of value) {
    if (char >= '0' && char <= '9') count += 1;
  }
  return count;
}
