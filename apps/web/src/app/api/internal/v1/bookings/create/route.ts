import { NextResponse } from 'next/server';

import {
  bookAppointment,
  enqueueNotification,
  loadBusinessContext,
  loadConversationMemory,
} from '@atwood/core';

import {
  assertBusinessScope,
  optionalString,
  readJson,
  requireString,
  withInternalAuth,
} from '@/lib/internal-auth';

/**
 * POST /api/internal/v1/bookings/create
 *
 * Book an appointment: write the calendar event, record the row, move the lead to
 * `booked`, and tell the owner.
 *
 * Availability is re-checked inside `bookAppointment`. Between the AI offering a
 * slot and the customer accepting it, minutes pass and someone else may have taken
 * it — trusting the earlier check is how you double-book an owner's morning.
 */
export const POST = withInternalAuth(async (request, auth) => {
  const body = await readJson<{
    conversation_id?: unknown;
    start?: unknown;
    end?: unknown;
    service_id?: unknown;
    customer_name?: unknown;
    customer_email?: unknown;
    notes?: unknown;
    created_by?: unknown;
  }>(request);

  const conversationId = requireString(body.conversation_id, 'conversation_id');
  const start = requireString(body.start, 'start');
  const end = requireString(body.end, 'end');

  const memory = await loadConversationMemory(conversationId);
  assertBusinessScope(auth, memory.business_id);

  const context = await loadBusinessContext(memory.business_id);

  const result = await bookAppointment({
    context,
    conversationId,
    serviceId: optionalString(body.service_id),
    start,
    end,
    // Prefer what the caller passes, fall back to what the conversation already
    // knows — the AI should not have to restate details we hold.
    customerName: optionalString(body.customer_name) ?? memory.known.name,
    customerPhone: memory.customer_phone,
    customerEmail: optionalString(body.customer_email) ?? memory.known.email,
    notes: optionalString(body.notes) ?? memory.summary,
    createdBy: body.created_by === 'user' ? 'user' : 'ai',
  });

  await enqueueNotification({
    businessId: memory.business_id,
    event: 'appointment_booked',
    subject: 'Appointment booked',
    body: `${result.label} — ${memory.known.name ?? 'a customer'}.`,
    payload: {
      customer_name: memory.known.name,
      customer_phone: memory.customer_phone,
      summary: result.label,
      conversation_id: conversationId,
    },
    conversationId,
    appointmentId: result.appointmentId,
    dedupeKey: `appointment_booked:${result.appointmentId}`,
  });

  return NextResponse.json({
    trace_id: auth.traceId,
    appointment_id: result.appointmentId,
    provider_event_id: result.providerEventId,
    starts_at: result.startsAt,
    label: result.label,
    // The AI should confirm using this exact wording rather than reformatting the
    // date itself, which is a reliable source of confident mistakes.
    confirmation_text: `That's booked in for ${result.label}. You'll get a reminder beforehand.`,
  });
});
