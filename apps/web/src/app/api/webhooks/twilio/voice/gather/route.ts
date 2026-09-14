import {
  buildHangupTwiml,
  getAdminClient,
  logger,
  parseInboundCall,
  parseTwilioForm,
  requireValidTwilioSignature,
} from '@atwood/core';

import { reconstructUrl, twiml, withTwilioWebhook } from '@/lib/twilio-webhook';

/**
 * POST /api/webhooks/twilio/voice/gather?call_id=…
 *
 * Where the pressed digit lands. The `action` URL of the `<Gather>` built in the
 * outbound TwiML, and — because that gather sets `actionOnEmptyResult` — this route
 * fires whether or not anything was pressed. A caller who says nothing is an
 * outcome, not a missing callback.
 *
 * The update to the appointment is guarded on its current status rather than being
 * applied unconditionally. A confirmation call can arrive after reception has
 * already moved the booking, and a keypress from yesterday's dial list must not
 * reopen a booking that a human has since changed.
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
  const callId = new URL(url).searchParams.get('call_id');

  /*
   * Three outcomes, and the distinction between them is the reason the digits are
   * stored raw alongside the conclusion:
   *
   *   * a digit we offered, which means something;
   *   * no digit at all — the gather timed out, which is what an answering machine
   *     and a person who walked away both look like;
   *   * a digit we did not offer. The caller pressed something, so they are there and
   *     trying to respond, but we do not know to what. Treating that as "no response"
   *     would hide a real caller behind the same word used for a machine.
   */
  const digits = call.digits;
  const outcome = digits === '1' ? 'confirmed' : digits === '2' ? 'cancelled' : digits ? 'unrecognised' : 'no_input';

  if (!callId) {
    logger.warn('Gather callback arrived without a call_id', { callSid: call.callSid });
    return twiml(buildHangupTwiml('Thank you. Goodbye.'));
  }

  const supabase = getAdminClient();

  const { data, error } = await supabase
    .from('calls')
    .select('id, business_id, appointment_id, metadata, appointments (id, status)')
    .eq('id', callId)
    .maybeSingle();

  if (error) throw new Error(`Could not load call ${callId}: ${error.message}`);

  const row = data as {
    id: string;
    business_id: string;
    appointment_id: string | null;
    metadata: Record<string, unknown> | null;
    appointments: { id: string; status: string } | null;
  } | null;

  if (!row) {
    logger.warn('Gather callback arrived for an unknown call', { callId, callSid: call.callSid });
    return twiml(buildHangupTwiml('Thank you. Goodbye.'));
  }

  // Exactly one of these three branches changes anything; the rest only record.
  let appointmentUpdated = false;
  let spoken: string;

  if (outcome === 'confirmed') {
    /*
     * Only a *pending* appointment is confirmed. Re-confirming one already confirmed
     * is a no-op rather than a fresh timestamp, which also makes a Twilio retry of
     * this callback harmless.
     */
    appointmentUpdated = await applyAppointmentChange(row.appointment_id, { status: 'pending' }, {
      status: 'confirmed',
      confirmed_at: new Date().toISOString(),
    });
    spoken = appointmentUpdated
      ? 'Thank you. Your appointment is confirmed. Goodbye.'
      : 'We could not update your appointment automatically. Please contact us directly. Goodbye.';
  } else if (outcome === 'cancelled') {
    appointmentUpdated = await applyAppointmentChange(
      row.appointment_id,
      { status: ['pending', 'confirmed'] },
      {
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancelled_by: 'customer',
        cancel_reason: 'Cancelled by keypad during an outbound confirmation call.',
      },
    );
    spoken = appointmentUpdated
      ? 'Your appointment has been cancelled. Please call us if you would like to rebook. Goodbye.'
      : 'We could not update your appointment automatically. Please contact us directly. Goodbye.';
  } else if (outcome === 'unrecognised') {
    spoken = 'Sorry, we did not recognise that. Your appointment is unchanged. Goodbye.';
  } else {
    spoken = 'We did not receive a response, so your appointment is unchanged. Goodbye.';
  }

  await supabase
    .from('calls')
    .update({
      outcome,
      digits_pressed: digits,
      call_status: call.callStatus,
      duration_seconds: call.duration,
      ended_at: new Date().toISOString(),
      /*
       * The caller's keypress is recorded as the outcome whether or not it changed
       * anything, because the keypress is a fact about what they did. Whether it was
       * *applied* is a different fact, and it is kept here rather than folded into
       * `outcome` — an outcome of `confirmed` against an appointment that reception
       * had already cancelled is exactly the case someone will need to reconstruct.
       */
      metadata: {
        // Spread, not replaced: the origination route wrote the actor and trace id
        // here, and losing them at the first callback would break the one link
        // between the call and the request that asked for it.
        ...(row.metadata ?? {}),
        appointment_updated: appointmentUpdated,
        appointment_status_at_callback: row.appointments?.status ?? null,
        call_sid: call.callSid,
      },
    })
    .eq('id', callId);

  logger.info('Outbound call outcome recorded', {
    callId,
    businessId: row.business_id,
    appointmentId: row.appointment_id,
    outcome,
    digits,
    appointmentUpdated,
  });

  return twiml(buildHangupTwiml(spoken));
});

/**
 * Apply a status change to an appointment, but only from the statuses where it makes
 * sense.
 *
 * Returns whether a row actually changed. A false is not an error: it means the
 * booking had already moved on, and the caller is told so rather than being read a
 * confirmation that is not true.
 */
async function applyAppointmentChange(
  appointmentId: string | null,
  from: { status: string | string[] },
  update: Record<string, unknown>,
): Promise<boolean> {
  if (!appointmentId) return false;

  const query = getAdminClient().from('appointments').update(update).eq('id', appointmentId);

  const { data, error } = await (Array.isArray(from.status)
    ? query.in('status', from.status)
    : query.eq('status', from.status)
  ).select('id');

  if (error) throw new Error(`Could not update appointment ${appointmentId}: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}
