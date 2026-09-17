import {
  buildHangupTwiml,
  getAdminClient,
  loadBusinessContext,
  logger,
  normalizePhone,
  parseInboundCall,
  parseTwilioForm,
  renderVoiceGreeting,
  requireValidTwilioSignature,
} from '@atwood/core';

import { conversationRelayTwiml } from '@/lib/conversation-relay';
import { reconstructUrl, twiml, withTwilioWebhook } from '@/lib/twilio-webhook';

/**
 * POST /api/webhooks/twilio/voice/relay
 *
 * Answers an inbound call with the assistant, unconditionally.
 *
 * **This route is now the exception, not the mechanism.** `phone_numbers.answer_mode`
 * is how a number is put on the conversational path, and that decision is made inside
 * `/api/webhooks/twilio/voice` — the Voice URL every number already carries. Renaming
 * this route to `/relay` means the mode column decides, not the URL, and a number never
 * has to be repointed to change how it answers.
 *
 * It is kept because pointing a number straight here is still a legitimate way to force
 * the assistant on for one number without touching its config — a test line, or a demo
 * where the row must not be edited. It resolves the same tenant the same way and builds
 * identical TwiML from `conversationRelayTwiml`, so the two paths cannot drift.
 *
 * The route does exactly four things — verify, resolve the tenant, read that tenant's
 * greeting, emit TwiML — because the caller is listening to silence until it answers. All
 * speech, recognition and turn taking happen on the socket.
 */
export const POST = withTwilioWebhook(async (request: Request): Promise<Response> => {
  const raw = await request.text();
  const params = parseTwilioForm(raw);

  const url = reconstructUrl(request);
  requireValidTwilioSignature({
    signature: request.headers.get('x-twilio-signature'),
    url,
    params,
  });

  const call = parseInboundCall(params);
  const toNumber = normalizePhone(call.to).e164;

  if (!toNumber) {
    logger.warn('Relay webhook received an unparseable To number', { to: call.to });
    return twiml(buildHangupTwiml('Sorry, we could not connect this call. Goodbye.'));
  }

  const { data, error } = await getAdminClient()
    .from('phone_numbers')
    .select('business_id')
    .eq('e164', toNumber)
    .is('released_at', null)
    .maybeSingle();

  if (error) throw new Error(`Could not resolve number ${toNumber}: ${error.message}`);

  const number = data as { business_id: string } | null;

  if (!number) {
    /*
     * Same rule as the missed-call route: an unprovisioned number must not be answered
     * by an assistant that does not know whose it is. It also must not say so — "this
     * number is not ours" tells a stranger the number is unmonitored.
     */
    logger.warn('Call to an unprovisioned number on the relay path', { to: toNumber });
    return twiml(buildHangupTwiml('Sorry, we could not connect this call. Goodbye.'));
  }

  logger.info('Relay call answered', {
    businessId: number.business_id,
    callSid: call.callSid,
    to: toNumber,
  });

  /*
   * The greeting is read here, before the TwiML, because it has to be inside the TwiML —
   * see `conversationRelayTwiml`. Throwing on failure is deliberate and matches the
   * number lookup above: a tenant whose context cannot be read is a tenant whose
   * assistant cannot answer a single turn, so the call is failing either way and a fault
   * Twilio records is worth more than a caller being strung along.
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
});
