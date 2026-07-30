import { createEvent, getBusyPeriods } from '../integrations/google-calendar.ts';
import { getAdminClient } from '../supabase/admin.ts';
import type { BusinessContext } from '../types/domain.ts';
import { notConfigured, unprocessable } from '../utils/errors.ts';
import { isOpenNow } from '../utils/hours.ts';
import { logger } from '../utils/logger.ts';

/**
 * Booking Engine.
 *
 * Optional per tenant. When enabled, the AI may offer slots — but only ones this
 * module has returned. That constraint is the whole design: a model asked to
 * "suggest a time" will confidently invent one, and a customer told "Thursday at
 * 2" for a slot that does not exist is worse than no booking feature at all.
 *
 * So the flow is: this module computes real availability → the workflow puts those
 * exact slots in the prompt → the AI picks from them → this module writes the
 * booking. The model never generates a time.
 */

export interface AvailableSlot {
  start: string;
  end: string;
  /** Pre-formatted in the tenant's timezone, so the AI never does date arithmetic. */
  label: string;
}

export interface FindSlotsInput {
  context: BusinessContext;
  serviceId?: string | null;
  /** Search from here. Defaults to now. */
  from?: Date;
  maxSlots?: number;
}

/**
 * Compute genuinely bookable slots.
 *
 * Applies, in order: minimum notice, opening hours, existing calendar busy blocks,
 * and the inter-appointment buffer. Anything that survives all four is real.
 */
export async function findAvailableSlots(input: FindSlotsInput): Promise<AvailableSlot[]> {
  const { context } = input;
  const settings = context.settings;

  if (!settings.booking_enabled) throw notConfigured('Booking');
  if (!settings.booking_calendar_id) throw notConfigured('A booking calendar');

  const maxSlots = input.maxSlots ?? 4;
  const now = input.from ?? new Date();

  // Minimum notice: nobody wants a booking 10 minutes from now.
  const searchStart = new Date(now.getTime() + settings.booking_min_notice_hours * 3_600_000);
  const searchEnd = new Date(now.getTime() + settings.booking_max_days_ahead * 86_400_000);

  const duration = resolveDurationMinutes(context, input.serviceId ?? null);

  const busy = await getBusyPeriods({
    businessId: context.business_id,
    calendarId: settings.booking_calendar_id,
    from: searchStart,
    to: searchEnd,
  });

  const busyRanges = busy.map((period) => ({
    start: new Date(period.start).getTime(),
    end: new Date(period.end).getTime(),
  }));

  const slots: AvailableSlot[] = [];
  const stepMs = settings.booking_slot_minutes * 60_000;
  const durationMs = duration * 60_000;
  const bufferMs = settings.booking_buffer_minutes * 60_000;

  // Align to the slot grid so offered times are :00/:30 rather than :07.
  let cursor = new Date(Math.ceil(searchStart.getTime() / stepMs) * stepMs);

  // Hard iteration cap: a tenant with a 90-day window and 15-minute slots would
  // otherwise loop ~8,600 times on every message.
  let iterations = 0;
  const MAX_ITERATIONS = 2_000;

  while (slots.length < maxSlots && cursor < searchEnd && iterations < MAX_ITERATIONS) {
    iterations += 1;
    const slotStart = cursor.getTime();
    const slotEnd = slotStart + durationMs;
    cursor = new Date(slotStart + stepMs);

    // Must be inside opening hours at both ends — a 90-minute job cannot start ten
    // minutes before closing.
    if (!isOpenNow(context.opening_hours, new Date(slotStart), context.timezone)) continue;
    if (!isOpenNow(context.opening_hours, new Date(slotEnd - 60_000), context.timezone)) continue;

    // Buffer is applied to the candidate, not the existing events, so back-to-back
    // bookings keep their gap regardless of which side was booked first.
    const conflicts = busyRanges.some(
      (range) => slotStart - bufferMs < range.end && slotEnd + bufferMs > range.start,
    );
    if (conflicts) continue;

    slots.push({
      start: new Date(slotStart).toISOString(),
      end: new Date(slotEnd).toISOString(),
      label: formatSlotLabel(new Date(slotStart), context.timezone),
    });
  }

  if (iterations >= MAX_ITERATIONS) {
    logger.warn('Slot search hit its iteration cap', { businessId: context.business_id });
  }

  return slots;
}

export interface BookAppointmentInput {
  context: BusinessContext;
  conversationId: string;
  leadId?: string | null;
  contactId?: string | null;
  serviceId?: string | null;
  start: string;
  end: string;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  notes?: string | null;
  createdBy?: 'ai' | 'user';
}

export interface BookAppointmentResult {
  appointmentId: string;
  providerEventId: string | null;
  startsAt: string;
  label: string;
}

/**
 * Book an appointment.
 *
 * Re-validates availability before writing. Between the AI offering a slot and the
 * customer accepting it there may be two minutes and one other booking — trusting
 * the earlier check would double-book the owner's morning.
 *
 * Order of writes matters: the calendar event is created first, then the row. If
 * the calendar call fails we have no appointment and no row, which is consistent.
 * The reverse order could leave a confirmed row with nothing in the diary.
 */
export async function bookAppointment(input: BookAppointmentInput): Promise<BookAppointmentResult> {
  const { context } = input;
  const settings = context.settings;

  if (!settings.booking_enabled) throw notConfigured('Booking');

  const start = new Date(input.start);
  const end = new Date(input.end);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw unprocessable('Invalid appointment start or end time');
  }
  if (end <= start) throw unprocessable('Appointment end must be after its start');
  if (start.getTime() < Date.now()) throw unprocessable('Cannot book an appointment in the past');

  if (settings.booking_calendar_id) {
    const busy = await getBusyPeriods({
      businessId: context.business_id,
      calendarId: settings.booking_calendar_id,
      from: start,
      to: end,
    });

    if (busy.length > 0) {
      throw unprocessable('That time has just been taken', { conflicts: busy.length });
    }
  }

  const service = input.serviceId
    ? context.services.find((candidate) => candidate.id === input.serviceId)
    : undefined;

  const summary = [service?.name ?? 'Appointment', input.customerName].filter(Boolean).join(' — ');

  let providerEventId: string | null = null;

  if (settings.booking_calendar_id) {
    const event = await createEvent({
      businessId: context.business_id,
      calendarId: settings.booking_calendar_id,
      summary,
      description: [
        input.notes,
        input.customerPhone ? `Phone: ${input.customerPhone}` : null,
        `Booked by the AI receptionist.`,
      ]
        .filter(Boolean)
        .join('\n'),
      start,
      end,
      timezone: context.timezone,
      attendeeEmail: input.customerEmail ?? null,
      // Derived from the conversation and start time, so a retry is idempotent.
      requestId: `${input.conversationId}${start.getTime()}`,
    });
    providerEventId = event.eventId;
  }

  const { data, error } = await getAdminClient()
    .from('appointments')
    .insert({
      business_id: context.business_id,
      conversation_id: input.conversationId,
      lead_id: input.leadId ?? null,
      contact_id: input.contactId ?? null,
      service_id: input.serviceId ?? null,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      timezone: context.timezone,
      status: settings.booking_requires_confirmation ? 'pending' : 'confirmed',
      customer_name: input.customerName ?? null,
      customer_phone: input.customerPhone ?? null,
      customer_email: input.customerEmail ?? null,
      notes: input.notes ?? null,
      provider: settings.booking_provider ?? null,
      calendar_id: settings.booking_calendar_id ?? null,
      provider_event_id: providerEventId,
      created_by: input.createdBy ?? 'ai',
      confirmed_at: settings.booking_requires_confirmation ? null : new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) {
    // The calendar event exists but the row does not. Log loudly with the event id
    // so it can be reconciled — silently swallowing this would leave a ghost
    // booking in the owner's diary with nothing in the dashboard to explain it.
    logger.error('Appointment row insert failed after the calendar event was created', {
      businessId: context.business_id,
      providerEventId,
      error: error.message,
    });
    throw unprocessable(`Could not record the appointment: ${error.message}`);
  }

  return {
    appointmentId: (data as { id: string }).id,
    providerEventId,
    startsAt: start.toISOString(),
    label: formatSlotLabel(start, context.timezone),
  };
}

/**
 * Render slots for the prompt.
 *
 * Numbered, labelled, and accompanied by an explicit instruction, because the
 * failure mode being defended against is the model helpfully offering a time that
 * is not on the list.
 */
export function renderSlotsForPrompt(slots: AvailableSlot[]): string {
  if (slots.length === 0) {
    return [
      '## Availability',
      '',
      'There is no availability to offer right now. Do not suggest any times. Take their details and say a colleague will confirm a time with them.',
    ].join('\n');
  }

  return [
    '## Availability',
    '',
    'These are the only times you may offer. They are real and currently free:',
    '',
    ...slots.map((slot, index) => `${index + 1}. ${slot.label}`),
    '',
    'Offer two or three of them, not the whole list. If none suit, say you will have a colleague find another time — do not invent alternatives.',
  ].join('\n');
}

function resolveDurationMinutes(context: BusinessContext, serviceId: string | null): number {
  if (serviceId) {
    const service = context.services.find((candidate) => candidate.id === serviceId);
    if (service?.duration_minutes) return service.duration_minutes;
  }
  return context.settings.booking_slot_minutes;
}

/**
 * Format a slot in the tenant's timezone.
 *
 * Formatting here rather than in the prompt means the model never has to reason
 * about dates — a reliable source of confident errors, especially across DST.
 */
function formatSlotLabel(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}
