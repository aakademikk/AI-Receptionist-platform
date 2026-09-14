import {
  buildGatherTwiml,
  buildHangupTwiml,
  getAdminClient,
  logger,
  parseTwilioForm,
  requireValidTwilioSignature,
} from '@atwood/core';

import { reconstructUrl, twiml, withTwilioWebhook } from '@/lib/twilio-webhook';

/**
 * POST /api/webhooks/twilio/voice/outbound?call_id=…
 *
 * The TwiML for a call *we* placed. Twilio fetches this the instant the call is
 * answered, so it has to answer fast — the person who picked up is holding a silent
 * phone until it does.
 *
 * The `call_id` is our own row id, not Twilio's CallSid, because the row is written
 * before the call is placed and therefore exists before a SID does. It is in the
 * query string, which the signature covers, so it cannot be swapped in flight for
 * another call's id.
 *
 * This route contains no model and no speech recognition. That is the point of
 * Phase B: the prompt is fixed, the only accepted input is a keypad digit, and a
 * caller who asks something unexpected cannot send it anywhere off-script.
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

  const callId = new URL(url).searchParams.get('call_id');
  if (!callId) {
    logger.warn('Outbound voice TwiML was fetched without a call_id', { url });
    return twiml(buildHangupTwiml());
  }

  const { data, error } = await getAdminClient()
    .from('calls')
    .select(
      `id, business_id, purpose, direction,
       appointments (id, starts_at, timezone),
       businesses (name)`,
    )
    .eq('id', callId)
    .maybeSingle();

  if (error) throw new Error(`Could not load call ${callId}: ${error.message}`);

  const call = data as {
    id: string;
    business_id: string;
    purpose: string | null;
    direction: string;
    appointments: { id: string; starts_at: string; timezone: string } | null;
    businesses: { name: string } | null;
  } | null;

  if (!call || call.direction !== 'outbound') {
    logger.warn('Outbound voice TwiML was fetched for an unknown or inbound call', { callId });
    return twiml(buildHangupTwiml());
  }

  if (call.purpose !== 'appointment_confirmation' || !call.appointments) {
    /*
     * The call was placed for something this route cannot script. Saying nothing and
     * hanging up is the safe answer: an unscripted purpose must not fall through to
     * a generic prompt that might ask the wrong question about the wrong thing.
     */
    logger.error('Outbound call has no scripted prompt for its purpose', {
      callId,
      businessId: call.business_id,
      purpose: call.purpose,
    });
    return twiml(
      buildHangupTwiml('Sorry, we could not complete this call. Please contact us directly.'),
    );
  }

  const businessName = call.businesses?.name ?? 'your appointment';
  const timezone = call.appointments.timezone || 'Europe/London';

  const actionUrl = `${new URL(url).origin}/api/webhooks/twilio/voice/gather?call_id=${callId}`;

  logger.info('Outbound call answered', {
    callId,
    businessId: call.business_id,
    appointmentId: call.appointments.id,
  });

  return twiml(
    buildGatherTwiml({
      prompt: buildConfirmationPrompt({
        businessName,
        startsAt: call.appointments.starts_at,
        timezone,
      }),
      actionUrl,
      numDigits: 1,
      timeoutSeconds: 6,
      /*
       * Plays only when the gather timed out with nothing pressed — an answering
       * machine, or a person who put the phone down. Without it the call ends in
       * silence, which reads as a dropped call rather than as a message.
       */
      fallbackMessage:
        'We did not receive a response, so your appointment is unchanged. ' +
        'Please call us if anything has changed. Goodbye.',
    }),
  );
});

/**
 * The spoken prompt.
 *
 * Three things are deliberate:
 *
 *  * **It opens by saying it is automated.** A person being recorded and answered by
 *    software is entitled to know which, and a confirmation call that pretends to be
 *    a human is the version that generates complaints.
 *  * **The date and time are formatted for speech, not for a screen.** "Wednesday 10
 *    September at 2:30 pm" is read correctly; an ISO timestamp is read out digit by
 *    digit.
 *  * **The two options are the last thing said**, so a caller who stops listening
 *    after the pleasantries still hears what to press.
 */
function buildConfirmationPrompt(options: {
  businessName: string;
  startsAt: string;
  timezone: string;
}): string {
  const startsAt = new Date(options.startsAt);

  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: options.timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(startsAt);

  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: options.timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(startsAt);

  return (
    `Hello. This is an automated assistant calling on behalf of ${options.businessName}. ` +
    `This is a quick call to confirm your appointment on ${date} at ${time}. ` +
    `Press 1 to confirm it, or press 2 if you need to cancel.`
  );
}
