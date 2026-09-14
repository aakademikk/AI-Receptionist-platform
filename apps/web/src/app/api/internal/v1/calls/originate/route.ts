import { NextResponse } from 'next/server';

import {
  badRequest,
  conflict,
  getAdminClient,
  loadBusinessContext,
  logger,
  normalizePhone,
  notFound,
  placeCall,
  unprocessable,
} from '@atwood/core';

import {
  assertBusinessScope,
  readJson,
  requireString,
  withInternalAuth,
  type InternalAuthContext,
} from '@/lib/internal-auth';
import { publicOrigin } from '@/lib/twilio-webhook';

/**
 * POST /api/internal/v1/calls/originate
 *
 * Place an outbound call. The first path in the platform that *initiates* rather
 * than reacts — everything else here answers something Twilio or a customer has
 * already done.
 *
 * Phase B: DTMF confirmation only. `appointment_confirmation` is the single purpose
 * implemented, and it is the single purpose this route accepts. The database's check
 * constraint allows three more; they are not implemented and this route refuses them
 * rather than pretending otherwise.
 *
 * The order of operations below is the design, not an accident:
 *
 *   1. **Resolve the contact and check suppression, before anything is dialled.**
 *      A caller who asked not to be rung must not be rung, and checking after the
 *      call has been placed is a check that has already failed.
 *   2. **Write the `calls` row before placing the call.** If the row is written after
 *      a successful originate and that write fails, we have placed a call the system
 *      has no record of — a customer's phone rings for reasons the dashboard cannot
 *      explain. The reverse failure (a row with no call) is visible and harmless.
 *   3. **Place the call.** Twilio returns as soon as it has accepted it; what happens
 *      on the call arrives later at the TwiML URL and the gather callback.
 */
export const POST = withInternalAuth(async (request: Request, auth: InternalAuthContext) => {
  const body = await readJson<{
    business_id?: unknown;
    contact_id?: unknown;
    appointment_id?: unknown;
    purpose?: unknown;
  }>(request);

  const businessId = requireString(body.business_id, 'business_id');
  const contactId = requireString(body.contact_id, 'contact_id');
  const appointmentId = requireString(body.appointment_id, 'appointment_id');
  const purpose = requireString(body.purpose, 'purpose');

  assertBusinessScope(auth, businessId);

  if (purpose !== 'appointment_confirmation') {
    throw badRequest(
      `"purpose" must be "appointment_confirmation" — the only outbound purpose implemented`,
      { received: purpose },
    );
  }

  const supabase = getAdminClient();

  // Contact and appointment together, in parallel: independent reads, and this sits
  // on a path where someone is waiting for a phone to ring.
  const [contactResult, appointmentResult] = await Promise.all([
    supabase
      .from('contacts')
      .select('id, business_id, phone, full_name, voice_opt_out, voice_opt_out_at')
      .eq('id', contactId)
      .maybeSingle(),
    supabase
      .from('appointments')
      .select('id, business_id, contact_id, customer_phone, customer_name, starts_at, timezone, status')
      .eq('id', appointmentId)
      .maybeSingle(),
  ]);

  if (contactResult.error) throw badRequest(`Could not load the contact: ${contactResult.error.message}`);
  if (appointmentResult.error) {
    throw badRequest(`Could not load the appointment: ${appointmentResult.error.message}`);
  }
  if (!contactResult.data) throw notFound(`Contact ${contactId}`);
  if (!appointmentResult.data) throw notFound(`Appointment ${appointmentId}`);

  const contact = contactResult.data as {
    id: string;
    business_id: string;
    phone: string | null;
    full_name: string | null;
    voice_opt_out: boolean;
    voice_opt_out_at: string | null;
  };

  const appointment = appointmentResult.data as {
    id: string;
    business_id: string;
    contact_id: string | null;
    customer_phone: string | null;
    customer_name: string | null;
    starts_at: string;
    timezone: string;
    status: string;
  };

  if (appointment.business_id !== businessId) {
    throw badRequest('The appointment belongs to a different business');
  }
  if (appointment.contact_id && appointment.contact_id !== contact.id) {
    throw badRequest('The appointment belongs to a different contact');
  }

  /*
   * The suppression check. A 409 rather than a 4xx the caller might retry: this is
   * not a transient refusal and it will not stop being true, so a retry loop here
   * would be a system ringing someone who has asked it not to.
   */
  if (contact.voice_opt_out) {
    logger.warn('Refused to place an outbound call to a contact who opted out', {
      traceId: auth.traceId,
      businessId,
      contactId,
    });
    throw conflict('This contact has opted out of voice calls', {
      voice_opt_out_at: contact.voice_opt_out_at,
    });
  }

  if (appointment.status === 'cancelled' || appointment.status === 'completed') {
    throw conflict(`The appointment is ${appointment.status} — there is nothing to confirm`);
  }

  // Prefer the appointment's own snapshot of the number: it is what the customer
  // gave when they booked, and it survives the contact being edited afterwards.
  const rawNumber = appointment.customer_phone ?? contact.phone;
  const toNumber = rawNumber ? normalizePhone(rawNumber).e164 : null;
  if (!toNumber) {
    // A configuration fault, not a bad request: there is nothing about the caller's
    // request to change, and retrying with the same data fails identically.
    throw unprocessable('This contact has no usable phone number to dial', {
      contact_id: contact.id,
    });
  }

  const context = await loadBusinessContext(businessId);

  const voiceNumbers = context.phone_numbers.filter((number) => number.channels.includes('voice'));
  const fromNumber = (voiceNumbers.find((number) => number.is_primary) ?? voiceNumbers[0])?.e164;

  if (!fromNumber) {
    throw unprocessable('No voice-capable number is configured for this business', {
      business_id: businessId,
    });
  }

  /*
   * Both TwiML URLs carry the call id in the query string rather than relying on
   * Twilio's CallSid, because the row has to exist *before* we dial and therefore
   * before a SID does. The query string is covered by the signature, so it cannot
   * be swapped for another call's id in flight.
   *
   * The public origin — `publicOrigin` holds the full reasoning. The short version:
   * Twilio fetches these URLs from the open internet, and behind the tunnel
   * `request.url` is `localhost:3001`, which it cannot reach and which is not the URL
   * the callbacks are signed against. This route had it right first; the SMS routes
   * now share the helper rather than each re-deriving it.
   */
  const origin = publicOrigin(request);

  const { data: inserted, error: insertError } = await supabase
    .from('calls')
    .insert({
      business_id: businessId,
      phone_number_id: null,
      contact_id: contact.id,
      provider: 'twilio',
      direction: 'outbound',
      from_number: fromNumber,
      to_number: toNumber,
      call_status: 'queued',
      purpose,
      appointment_id: appointment.id,
      started_at: new Date().toISOString(),
      metadata: { originated_by: auth.actor, trace_id: auth.traceId },
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    throw badRequest(`Could not record the call: ${insertError?.message ?? 'no row returned'}`);
  }

  const callId = (inserted as { id: string }).id;

  try {
    const placed = await placeCall({
      to: toNumber,
      from: fromNumber,
      // The TwiML Twilio fetches the moment the call is answered.
      twimlUrl: `${origin}/api/webhooks/twilio/voice/outbound?call_id=${callId}`,
      // Call lifecycle, not message delivery — a different route. Without it, a call
      // that rings out leaves this row at `queued` with no outcome forever.
      statusCallbackUrl: `${origin}/api/webhooks/twilio/voice/status`,
      timeoutSeconds: 25,
      // The call row id is a natural idempotency key: a retry that reuses it cannot
      // put a second call on the same number.
      idempotencyKey: `originate:${callId}`,
    });

    await supabase
      .from('calls')
      .update({ provider_call_sid: placed.sid, call_status: placed.status })
      .eq('id', callId);

    logger.info('Outbound call placed', {
      traceId: auth.traceId,
      businessId,
      callId,
      appointmentId: appointment.id,
      callSid: placed.sid,
    });

    return NextResponse.json({
      trace_id: auth.traceId,
      call_id: callId,
      call_sid: placed.sid,
      status: placed.status,
      to_number: toNumber,
      from_number: fromNumber,
    });
  } catch (error) {
    /*
     * The call never went out, so the row must not sit at `queued` pretending it
     * might. Marking it failed keeps the outbound log truthful, and the caller gets
     * Twilio's error unchanged so n8n can branch on it.
     */
    await supabase
      .from('calls')
      .update({
        call_status: 'failed',
        outcome: 'failed',
        ended_at: new Date().toISOString(),
        metadata: {
          originated_by: auth.actor,
          trace_id: auth.traceId,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      .eq('id', callId);

    throw error;
  }
});
