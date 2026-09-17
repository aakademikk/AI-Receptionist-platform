import {
  buildMissedCallTwiml,
  getAdminClient,
  loadBusinessContext,
  logger,
  markMissedRedirect,
  normalizePhone,
  parseInboundCall,
  parseTwilioForm,
  renderVoiceGreeting,
  requireValidTwilioSignature,
} from '@atwood/core';

import { conversationRelayTwiml } from '@/lib/conversation-relay';
import { reconstructUrl, withTwilioWebhook } from '@/lib/twilio-webhook';

/**
 * POST /api/webhooks/twilio/voice
 *
 * The inbound-call webhook, and the only Voice URL the platform needs.
 *
 * It answers one of two ways, decided by `phone_numbers.answer_mode` rather than by
 * which URL the number points at:
 *
 *  - `dial_through` (the default, and every number's behaviour before 0012) — return
 *    TwiML that tries the business's own line and, if that goes unanswered, calls the
 *    `action` URL, which is what triggers the SMS.
 *  - `conversational` — hand the call to the ConversationRelay socket and let the
 *    assistant hold it. `forward_to` is not consulted; nothing is dialled.
 *
 * Letting `<Dial>` decide whether the call was missed is far more reliable than
 * inferring it from call-status transitions: Twilio tells us the outcome of the
 * forwarding leg directly, and it is the same signal whether the line was busy,
 * rang out, or failed.
 *
 * This must respond fast and synchronously — the caller is listening to silence
 * until it does — so it does the minimum: verify, resolve the number, and on the
 * conversational branch read the tenant's greeting to say first. Everything else happens
 * on the action callback or on the socket.
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
    .select('business_id, forward_to, voice_greeting_url, missed_call_enabled, answer_mode')
    .eq('e164', toNumber)
    .is('released_at', null)
    .maybeSingle();

  const number = data as {
    business_id: string;
    forward_to: string | null;
    voice_greeting_url: string | null;
    missed_call_enabled: boolean;
    answer_mode: string;
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
    answerMode: number.answer_mode,
  });

  /*
   * The one branch that decides how the call is answered.
   *
   * Checked positively for `conversational` rather than negatively for `dial_through`, so
   * that anything unexpected falls through to dialling the business's own line. That is
   * the safe direction: the worst case is a call that rings a human who was expecting the
   * assistant, rather than an automated voice on a line that was supposed to ring a human.
   * The check constraint on the column means the other value is unreachable anyway.
   */
  if (number.answer_mode === 'conversational') {
    /*
     * A second read on the answer path, and the cost is accepted rather than overlooked:
     * the caller is listening to silence while it happens. It buys the tenant's own
     * greeting — their words, their business name — as the first thing the caller hears,
     * and the alternative is copy in this file that belongs to the customer. The view is
     * one round trip, and the whole branch still answers well inside Twilio's timeout.
     *
     * A failure here throws, which fails the call. That is deliberate: if the tenant
     * context is unreachable the socket will fail every turn anyway, so the choice is
     * between a fault Twilio records against the call and the caller being talked at by
     * an assistant that cannot answer anything.
     */
    const context = await loadBusinessContext(number.business_id);

    return twiml(
      conversationRelayTwiml({
        request,
        businessId: number.business_id,
        callSid: call.callSid,
        to: toNumber,
        greeting: renderVoiceGreeting(context),
      }),
    );
  }

  return twiml(
    buildMissedCallTwiml({
      forwardTo: number.forward_to,
      // With nowhere to forward to, every call is missed — and a `<Redirect>` cannot
      // say so for itself, because Twilio sends no `DialCallStatus` and the parent
      // call is still live. Marking the URL is how the action callback finds out.
      //
      // The two unprovisioned branches above deliberately do *not* mark: a call to a
      // number we do not own must never trigger a follow-up SMS.
      actionUrl: number.forward_to ? actionUrl : markMissedRedirect(actionUrl),
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
