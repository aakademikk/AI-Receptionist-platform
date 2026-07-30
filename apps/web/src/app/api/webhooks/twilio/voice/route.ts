import {
  buildMissedCallTwiml,
  getAdminClient,
  logger,
  normalizePhone,
  parseInboundCall,
  parseTwilioForm,
  requireValidTwilioSignature,
} from '@atwood/core';

import { reconstructUrl, withTwilioWebhook } from '@/lib/twilio-webhook';

/**
 * POST /api/webhooks/twilio/voice
 *
 * The inbound-call webhook. Returns TwiML that tries the business's own line and,
 * if that goes unanswered, calls the `action` URL — which is what triggers the SMS.
 *
 * Letting `<Dial>` decide whether the call was missed is far more reliable than
 * inferring it from call-status transitions: Twilio tells us the outcome of the
 * forwarding leg directly, and it is the same signal whether the line was busy,
 * rang out, or failed.
 *
 * This must respond fast and synchronously — the caller is listening to silence
 * until it does — so it does the minimum: verify, resolve the number, return TwiML.
 * Everything else happens on the action callback.
 */
export const POST = withTwilioWebhook(async (request: Request): Promise<Response> => {
  const raw = await request.text();
  const params = parseTwilioForm(raw);

  // The URL must match what Twilio signed. Behind a TLS-terminating proxy,
  // `request.url` often reports http, which would fail every signature — so the
  // forwarded headers win where present.
  const url = reconstructUrl(request);

  requireValidTwilioSignature({
    signature: request.headers.get('x-twilio-signature'),
    url,
    params,
  });

  const call = parseInboundCall(params);
  const toNumber = normalizePhone(call.to).e164;

  const actionUrl = `${new URL(url).origin}/api/webhooks/twilio/voice/missed`;

  if (!toNumber) {
    logger.warn('Voice webhook received an unparseable To number', { to: call.to });
    return twiml(buildMissedCallTwiml({ forwardTo: null, actionUrl }));
  }

  // One indexed read. A globally unique e164 is what makes routing this cheap.
  const { data } = await getAdminClient()
    .from('phone_numbers')
    .select('business_id, forward_to, voice_greeting_url, missed_call_enabled')
    .eq('e164', toNumber)
    .is('released_at', null)
    .maybeSingle();

  const number = data as {
    business_id: string;
    forward_to: string | null;
    voice_greeting_url: string | null;
    missed_call_enabled: boolean;
  } | null;

  if (!number) {
    // An unprovisioned number should not ring out silently — but nor should it leak
    // that the number is unknown. Forward nowhere and let the action callback log it.
    logger.warn('Call to an unprovisioned number', { to: toNumber });
    return twiml(buildMissedCallTwiml({ forwardTo: null, actionUrl }));
  }

  logger.info('Inbound call', {
    businessId: number.business_id,
    callSid: call.callSid,
    to: toNumber,
  });

  return twiml(
    buildMissedCallTwiml({
      forwardTo: number.forward_to,
      actionUrl,
      greetingUrl: number.voice_greeting_url,
      timeoutSeconds: 20,
    }),
  );
});

function twiml(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/xml; charset=utf-8' },
  });
}
