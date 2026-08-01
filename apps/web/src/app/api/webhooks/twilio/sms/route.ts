import { after } from 'next/server';

import {
  describeFetchError,
  logger,
  parseInboundMessage,
  parseTwilioForm,
  requireValidTwilioSignature,
  serverEnv,
} from '@atwood/core';

import { reconstructUrl, withTwilioWebhook } from '@/lib/twilio-webhook';

/**
 * POST /api/webhooks/twilio/sms
 *
 * The inbound SMS and WhatsApp webhook.
 *
 * Acknowledges immediately and does the work in `after()`. The pipeline involves a
 * model call, which can take several seconds — comfortably longer than Twilio's
 * 15-second webhook timeout allows for once queuing is included. A timeout would
 * make Twilio retry, and a retried webhook that arrives while the first is still
 * generating is how you send a customer two different replies.
 *
 * Empty TwiML rather than a `<Message>` response: the reply is sent through the REST
 * API instead, so that it is recorded, priced and idempotency-keyed like every other
 * outbound message.
 */
export const POST = withTwilioWebhook(async (request: Request): Promise<Response> => {
  const raw = await request.text();
  const params = parseTwilioForm(raw);
  const url = reconstructUrl(request);

  /*
   * The body exactly as it arrived, before parsing.
   *
   * Every other input to signature validation has been eliminated, and this is the
   * one nobody has looked at. It distinguishes the remaining possibilities at a
   * glance: whether phone numbers arrive percent-encoded (`From=%2B44…`) or already
   * decoded (`From=+44…`, which standard form parsing then turns into a space and
   * silently corrupts), whether the body is truncated, and whether the charset is
   * what the parser assumes.
   *
   * Debug level, so off by default -- it contains the message body.
   */
  logger.debug('Twilio raw body', {
    raw,
    rawLength: raw.length,
    contentType: request.headers.get('content-type'),
    contentLength: request.headers.get('content-length'),
  });

  requireValidTwilioSignature({
    signature: request.headers.get('x-twilio-signature'),
    url,
    params,
  });

  const message = parseInboundMessage(params);

  logger.info('Inbound message received', {
    messageSid: message.messageSid,
    channel: message.channel,
  });

  const n8nBase = serverEnv.n8nWebhookBaseUrl;
  const target = n8nBase
    ? `${n8nBase}/webhook/atwood/incoming-message`
    : `${new URL(url).origin}/api/internal/v1/messages/inbound`;

  after(async () => {
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-atwood-secret': serverEnv.internalApiSecret,
        },
        body: JSON.stringify({
          to_number: message.to,
          from_number: message.from,
          body: message.body,
          channel: message.channel,
          // Twilio's own message id. The pipeline's idempotency key, so a replayed
          // webhook is recognised rather than answered twice.
          provider_message_id: message.messageSid,
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        throw new Error(`${n8nBase ? 'n8n' : 'internal API'} returned ${response.status}`);
      }
    } catch (error) {
      // The message is not lost — the pipeline records it before replying, and the
      // customer's next message re-triggers everything. But a silent failure here
      // means an unanswered customer, so it is logged as an error.
      logger.error('Inbound message could not be dispatched', {
        messageSid: message.messageSid,
        via: n8nBase ? 'n8n' : 'in-process',
        target,
        error: describeFetchError(error),
      });
    }
  });

  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
    status: 200,
    headers: { 'content-type': 'text/xml; charset=utf-8' },
  });
});
