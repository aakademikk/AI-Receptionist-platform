import { createHmac, timingSafeEqual } from 'node:crypto';

import { serverEnv } from '../env.ts';
import { AppError, badRequest } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';

/**
 * Twilio integration.
 *
 * Uses the REST API over `fetch` rather than the `twilio` npm package. The SDK is
 * a large dependency that bundles a client for every Twilio product, and we use
 * exactly two endpoints. On a serverless runtime, cold-start size is a real cost.
 *
 * The signature validation below is the more important half of this file: without
 * it, the inbound webhook is an unauthenticated endpoint that will happily accept
 * a forged "customer message" from anyone who can guess a phone number, and bill
 * the tenant for the AI reply.
 */

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

export interface SendSmsInput {
  to: string;
  from: string;
  body: string;
  channel?: 'sms' | 'whatsapp';
  /** Twilio calls back here with delivery receipts. */
  statusCallbackUrl?: string;
  /**
   * Twilio's own idempotency: repeating this key will not send a second message.
   * Always set it on anything a workflow may retry.
   */
  idempotencyKey?: string;
}

export interface SendSmsResult {
  sid: string;
  status: string;
  segments: number | null;
  priceAmount: number | null;
  priceCurrency: string | null;
}

/**
 * Send a message.
 *
 * WhatsApp uses the same endpoint with a `whatsapp:` address prefix, which is why
 * one function serves both channels.
 */
export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  const accountSid = serverEnv.twilioAccountSid;
  const authToken = serverEnv.twilioAuthToken;

  const prefix = input.channel === 'whatsapp' ? 'whatsapp:' : '';

  const form = new URLSearchParams({
    To: `${prefix}${input.to}`,
    Body: input.body,
  });

  // A Messaging Service handles sender pools and sticky sender for us; without one
  // we fall back to the explicit From number.
  const messagingServiceSid = serverEnv.twilioMessagingServiceSid;
  if (messagingServiceSid && input.channel !== 'whatsapp') {
    form.set('MessagingServiceSid', messagingServiceSid);
  } else {
    form.set('From', `${prefix}${input.from}`);
  }

  if (input.statusCallbackUrl) form.set('StatusCallback', input.statusCallbackUrl);

  const headers: Record<string, string> = {
    authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (input.idempotencyKey) headers['I-Twilio-Idempotency-Token'] = input.idempotencyKey;

  const response = await fetch(`${TWILIO_API_BASE}/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(15_000),
  });

  const payload = (await response.json()) as Record<string, unknown>;

  if (!response.ok) {
    const message = typeof payload['message'] === 'string' ? payload['message'] : response.statusText;
    const code = payload['code'];

    throw new AppError(
      // 4xx from Twilio is our mistake (bad number, unverified sender) and must not
      // be retried; 5xx is theirs and should be.
      response.status >= 500 ? 'provider_error' : 'unprocessable',
      response.status >= 500 ? 502 : 422,
      `Twilio send failed (${code ?? response.status}): ${message}`,
      { details: { twilioCode: code }, publicMessage: 'The message could not be sent.' },
    );
  }

  return {
    sid: String(payload['sid']),
    status: String(payload['status']),
    segments: toNumber(payload['num_segments']),
    // Twilio reports price as a negative string ("-0.0075"); store the magnitude.
    priceAmount: payload['price'] === null ? null : Math.abs(toNumber(payload['price']) ?? 0),
    priceCurrency: typeof payload['price_unit'] === 'string' ? payload['price_unit'] : null,
  };
}

/**
 * TwiML for the missed-call flow.
 *
 * The voice webhook returns this when a call comes in: it tries the business's own
 * line first, and only if that goes unanswered does the `action` callback fire and
 * trigger the SMS. `Dial` handles the "was it actually missed?" question for us,
 * which is far more reliable than inferring it from call status transitions.
 */
export function buildMissedCallTwiml(options: {
  forwardTo: string | null;
  timeoutSeconds?: number;
  actionUrl: string;
  greetingUrl?: string | null;
  recordCall?: boolean;
}): string {
  const timeout = options.timeoutSeconds ?? 20;
  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>'];

  if (options.greetingUrl) {
    parts.push(`  <Play>${escapeXml(options.greetingUrl)}</Play>`);
  }

  if (options.forwardTo) {
    parts.push(
      `  <Dial timeout="${timeout}" action="${escapeXml(options.actionUrl)}" method="POST"` +
        `${options.recordCall ? ' record="record-from-answer-dual"' : ''}>` +
        `${escapeXml(options.forwardTo)}</Dial>`,
    );
  } else {
    // No forwarding configured: treat every call as missed and go straight to SMS.
    parts.push(`  <Redirect method="POST">${escapeXml(options.actionUrl)}</Redirect>`);
  }

  parts.push('</Response>');
  return parts.join('\n');
}

/** Empty TwiML. Ends the call politely once the follow-up SMS is queued. */
export function buildHangupTwiml(message?: string): string {
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>'];
  if (message) parts.push(`  <Say voice="Polly.Amy">${escapeXml(message)}</Say>`);
  parts.push('  <Hangup/>', '</Response>');
  return parts.join('\n');
}

/**
 * Validate `X-Twilio-Signature`.
 *
 * Twilio's scheme: HMAC-SHA1 over the full request URL followed by every POST
 * parameter, sorted by key, concatenated as `key + value` with no separators —
 * then base64. Implemented here rather than pulled from the SDK so the one
 * security-critical function in the inbound path is visible and testable.
 *
 * Two details that are easy to get wrong and both break validation silently:
 *   * the URL must be exactly what Twilio called, including query string and the
 *     original scheme — behind a proxy that terminates TLS, `req.url` often says
 *     `http` and every signature then fails;
 *   * the comparison must be constant-time.
 */
export function validateTwilioSignature(input: {
  signature: string | null | undefined;
  url: string;
  params: Record<string, string>;
  authToken?: string;
}): boolean {
  if (!input.signature) return false;

  const authToken = input.authToken ?? serverEnv.twilioAuthToken;

  const sortedKeys = Object.keys(input.params).sort();
  let payload = input.url;
  for (const key of sortedKeys) {
    payload += key + input.params[key];
  }

  const expected = createHmac('sha1', authToken).update(Buffer.from(payload, 'utf8')).digest('base64');

  const presented = Buffer.from(input.signature, 'utf8');
  const computed = Buffer.from(expected, 'utf8');
  if (presented.length !== computed.length) return false;

  return timingSafeEqual(presented, computed);
}

/**
 * Rebuild the public URL Twilio signed.
 *
 * The signature covers the exact URL configured in the Twilio console, so validation
 * has to reproduce it byte for byte. Two things get in the way, and both are handled
 * here rather than at each call site:
 *
 *  * **TLS termination.** A proxy or tunnel forwards the original scheme and host in
 *    `x-forwarded-*`; without those, `request.url` reports `http://localhost:3000`
 *    and every signature fails in a way that looks like a bad auth token.
 *  * **A tunnel that rewrites Host to the origin**, which is what a quick tunnel does
 *    by default. Nothing in the headers can recover a value that was never sent, so
 *    `TWILIO_WEBHOOK_BASE_URL` supplies it explicitly and wins when set.
 *
 * The origin is rebuilt rather than patched onto the existing URL. Assigning to
 * `url.host` leaves the current port in place when the new value has none — so a
 * request that arrived on `localhost:3000` keeps `:3000` in the reconstructed public
 * URL, producing `https://tunnel.example.com:3000/...` against a signature computed
 * over a URL with no port at all. Building from a fresh origin cannot do that, and a
 * host that legitimately carries a port still keeps it.
 */
export function reconstructTwilioUrl(input: {
  requestUrl: string;
  forwardedProto?: string | null;
  forwardedHost?: string | null;
  host?: string | null;
  baseUrlOverride?: string | null;
}): string {
  const original = new URL(input.requestUrl);

  if (input.baseUrlOverride) {
    try {
      const base = new URL(input.baseUrlOverride);
      return withOrigin(original, base.protocol, base.host);
    } catch {
      logger.warn('TWILIO_WEBHOOK_BASE_URL is not a valid URL; falling back to headers', {
        value: input.baseUrlOverride,
      });
    }
  }

  // A proxy chain appends rather than replaces, so the client-supplied value is first.
  const firstOf = (value: string | null | undefined): string | undefined =>
    value ? value.split(',')[0]!.trim() || undefined : undefined;

  const protocol = firstOf(input.forwardedProto);
  const host = firstOf(input.forwardedHost) ?? firstOf(input.host);

  return withOrigin(
    original,
    protocol ? `${protocol}:` : original.protocol,
    host ?? original.host,
  );
}

function withOrigin(original: URL, protocol: string, host: string): string {
  const rebuilt = new URL(`${protocol}//${host}`);
  rebuilt.pathname = original.pathname;
  rebuilt.search = original.search;
  return rebuilt.toString();
}

/**
 * Throwing wrapper for route handlers.
 *
 * 403 rather than 401: the caller did present a credential, it simply did not
 * verify, and there is no challenge we could return that would help it try again.
 * It is also what Twilio's own helper libraries answer, so the status matches what
 * anyone debugging against their docs will expect.
 *
 * The route must map this to a response — `withTwilioWebhook` does. An unmapped
 * throw becomes a 500, which tells Twilio to *retry* a request that can never
 * succeed.
 */
export function requireValidTwilioSignature(input: Parameters<typeof validateTwilioSignature>[0]): void {
  if (!validateTwilioSignature(input)) {
    /*
     * Three things can cause this, and the URL alone does not tell them apart, so log
     * enough to distinguish them without printing anything secret:
     *
     *   * the reconstructed URL differs from the one configured in Twilio — compare
     *     `url` below against the console field;
     *   * the auth token is wrong, truncated or padded — `authTokenLength` is 32 for a
     *     real one, and any other number identifies the problem immediately;
     *   * the number belongs to a subaccount, which signs with its own token.
     *
     * A length is not a secret and cannot be worked backwards; it is the single most
     * diagnostic thing available here.
     */
    const authToken = serverEnv.twilioAuthToken;
    logger.warn('Rejected a Twilio webhook with an invalid signature', {
      url: input.url,
      authTokenLength: authToken.length,
      signaturePresent: Boolean(input.signature),
      paramCount: Object.keys(input.params).length,
      hint:
        authToken.length === 32
          ? 'Token length looks right — check the URL matches Twilio exactly, and that the number is not on a subaccount with its own token.'
          : `Expected a 32-character auth token, got ${authToken.length}. Check TWILIO_AUTH_TOKEN for a truncated paste or stray whitespace.`,
    });
    throw new AppError('forbidden', 403, 'Invalid Twilio signature', {
      publicMessage: 'Signature verification failed.',
    });
  }
}

/**
 * Parse an inbound Twilio webhook body.
 *
 * Twilio posts `application/x-www-form-urlencoded`. The raw text is needed for
 * signature validation, so the caller reads the body once as text and passes it
 * here — reading it twice is not possible on a streamed request.
 */
export function parseTwilioForm(rawBody: string): Record<string, string> {
  const params = new URLSearchParams(rawBody);
  const output: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    output[key] = value;
  }
  return output;
}

export interface InboundMessagePayload {
  messageSid: string;
  from: string;
  to: string;
  body: string;
  numMedia: number;
  media: Array<{ url: string; contentType: string }>;
  channel: 'sms' | 'whatsapp';
}

export function parseInboundMessage(params: Record<string, string>): InboundMessagePayload {
  const messageSid = params['MessageSid'] ?? params['SmsMessageSid'] ?? params['SmsSid'];
  const from = params['From'];
  const to = params['To'];

  if (!messageSid || !from || !to) {
    throw badRequest('Twilio message webhook is missing MessageSid, From or To');
  }

  const numMedia = Number.parseInt(params['NumMedia'] ?? '0', 10) || 0;
  const media: InboundMessagePayload['media'] = [];
  for (let index = 0; index < numMedia; index += 1) {
    const url = params[`MediaUrl${index}`];
    const contentType = params[`MediaContentType${index}`];
    if (url) media.push({ url, contentType: contentType ?? 'application/octet-stream' });
  }

  // WhatsApp addresses arrive as `whatsapp:+447700900123`; strip the scheme so the
  // rest of the system only ever deals in E.164.
  const isWhatsApp = from.startsWith('whatsapp:');

  return {
    messageSid,
    from: from.replace('whatsapp:', ''),
    to: to.replace('whatsapp:', ''),
    body: params['Body'] ?? '',
    numMedia,
    media,
    channel: isWhatsApp ? 'whatsapp' : 'sms',
  };
}

export interface InboundCallPayload {
  callSid: string;
  from: string;
  to: string;
  callStatus: string;
  /** Populated on the `action` callback of a <Dial>. */
  dialCallStatus: string | null;
  /** True when the call went unanswered and the follow-up SMS should fire. */
  isMissed: boolean;
  duration: number | null;
}

export function parseInboundCall(params: Record<string, string>): InboundCallPayload {
  const callSid = params['CallSid'];
  const from = params['From'];
  const to = params['To'];

  if (!callSid || !from || !to) {
    throw badRequest('Twilio voice webhook is missing CallSid, From or To');
  }

  const dialCallStatus = params['DialCallStatus'] ?? null;
  const callStatus = params['CallStatus'] ?? 'unknown';

  // `DialCallStatus` is authoritative when present (it describes the forwarding
  // leg). Absent it, fall back to the parent call's status — which is the case when
  // no forwarding number is configured and we redirected straight through.
  const missedStatuses = ['no-answer', 'busy', 'failed', 'canceled'];
  const isMissed = dialCallStatus
    ? missedStatuses.includes(dialCallStatus)
    : missedStatuses.includes(callStatus);

  return {
    callSid,
    from: from.replace('whatsapp:', ''),
    to: to.replace('whatsapp:', ''),
    callStatus,
    dialCallStatus,
    isMissed,
    duration: toNumber(params['DialCallDuration'] ?? params['CallDuration']),
  };
}

/** Map a Twilio delivery status onto our `message_status` enum. */
export function mapTwilioStatus(status: string): string {
  switch (status) {
    case 'queued':
    case 'accepted':
    case 'scheduled':
      return 'queued';
    case 'sending':
      return 'sending';
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'undelivered':
      return 'undelivered';
    case 'failed':
    case 'canceled':
      return 'failed';
    case 'received':
      return 'received';
    default:
      return 'sent';
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
