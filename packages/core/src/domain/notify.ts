import { sendEmail } from '../integrations/email.ts';
import { sendSms } from '../integrations/twilio.ts';
import { getAdminClient } from '../supabase/admin.ts';
import type { NotificationEvent } from '../types/domain.ts';
import { logger } from '../utils/logger.ts';
import { formatPhoneForDisplay, phoneTail } from '../utils/phone.ts';

/**
 * Notification Engine.
 *
 * Two halves, deliberately separated:
 *
 *   enqueue  — fan an event out to the tenant's subscribed recipients. Fast,
 *              transactional, deduplicated. Called inline from the message
 *              workflows, so it must never block on a third party.
 *   drain    — actually deliver. Called by a worker on a schedule.
 *
 * The reason for the split is that delivery is the flakiest thing in the system.
 * An email provider having a bad minute must not fail the customer's SMS reply, and
 * a retry must not re-send the reply. An outbox table decouples the two completely.
 */

export interface EnqueueNotificationInput {
  businessId: string;
  event: NotificationEvent;
  subject?: string;
  body?: string;
  payload?: Record<string, unknown>;
  conversationId?: string | null;
  leadId?: string | null;
  appointmentId?: string | null;
  /**
   * Idempotency key, namespaced per recipient by the SQL function. Always supply
   * one for anything a workflow might retry.
   */
  dedupeKey?: string;
}

/** Fan an event out to the outbox. Returns how many rows were created. */
export async function enqueueNotification(input: EnqueueNotificationInput): Promise<number> {
  const { data, error } = await getAdminClient().rpc('enqueue_notification', {
    p_business_id: input.businessId,
    p_event: input.event,
    p_subject: input.subject ?? null,
    p_body: input.body ?? null,
    p_payload: input.payload ?? {},
    p_conversation_id: input.conversationId ?? null,
    p_lead_id: input.leadId ?? null,
    p_appointment_id: input.appointmentId ?? null,
    p_dedupe_key: input.dedupeKey ?? null,
  });

  if (error) {
    // Never fatal: a missed notification is worse than nothing, but far better
    // than a failed customer reply.
    logger.error('enqueue_notification failed', {
      businessId: input.businessId,
      event: input.event,
      error: error.message,
    });
    return 0;
  }

  return typeof data === 'number' ? data : 0;
}

interface ClaimedNotification {
  id: string;
  business_id: string;
  event: NotificationEvent;
  channel: string;
  destination: string;
  subject: string | null;
  body: string | null;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface DrainResult {
  claimed: number;
  sent: number;
  failed: number;
  suppressed: number;
}

/**
 * Deliver a batch.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED` inside `claim_notifications()`, so
 * several workers can drain concurrently without double-sending. Each delivery is
 * isolated: one bad destination must not abort the batch.
 */
export async function drainNotifications(limit = 25): Promise<DrainResult> {
  const supabase = getAdminClient();

  const { data, error } = await supabase.rpc('claim_notifications', { p_limit: limit });
  if (error) {
    logger.error('claim_notifications failed', { error: error.message });
    return { claimed: 0, sent: 0, failed: 0, suppressed: 0 };
  }

  const batch = (data ?? []) as ClaimedNotification[];
  const result: DrainResult = { claimed: batch.length, sent: 0, failed: 0, suppressed: 0 };

  // Sequential rather than parallel: these hit rate-limited third parties, and a
  // burst of 25 concurrent sends is how you get throttled.
  for (const notification of batch) {
    try {
      const outcome = await deliver(notification);

      if (outcome === 'suppressed') {
        await supabase
          .from('notifications')
          .update({ status: 'suppressed', last_error: 'Channel not configured' })
          .eq('id', notification.id);
        result.suppressed += 1;
        continue;
      }

      await supabase
        .from('notifications')
        .update({ status: 'sent', sent_at: new Date().toISOString(), last_error: null })
        .eq('id', notification.id);
      result.sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // `claim_notifications` only picks up rows under 5 attempts, so leaving the
      // row `pending` is the retry; past that it stays pending and stops being
      // claimed, which is visible in the dashboard as a stuck notification.
      const exhausted = notification.attempts >= 5;

      await supabase
        .from('notifications')
        .update({ status: exhausted ? 'failed' : 'pending', last_error: message })
        .eq('id', notification.id);

      logger.warn('Notification delivery failed', {
        businessId: notification.business_id,
        notificationId: notification.id,
        channel: notification.channel,
        attempts: notification.attempts,
        error: message,
      });
      result.failed += 1;
    }
  }

  return result;
}

async function deliver(notification: ClaimedNotification): Promise<'sent' | 'suppressed'> {
  switch (notification.channel) {
    case 'email':
      await sendEmail({
        to: notification.destination,
        subject: notification.subject ?? defaultSubject(notification.event),
        text: notification.body ?? '',
      });
      return 'sent';

    case 'sms':
    case 'whatsapp': {
      // Owner alerts are sent from the tenant's own number so a reply lands
      // somewhere sensible rather than at an unmonitored shortcode.
      const from = await primaryNumberFor(notification.business_id, notification.channel);
      if (!from) return 'suppressed';

      await sendSms({
        to: notification.destination,
        from,
        body: composeSmsBody(notification),
        channel: notification.channel === 'whatsapp' ? 'whatsapp' : 'sms',
      });
      return 'sent';
    }

    case 'webhook':
    case 'slack': {
      const response = await fetch(notification.destination, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: notification.event,
          subject: notification.subject,
          body: notification.body,
          ...notification.payload,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`Webhook returned ${response.status}`);
      }
      return 'sent';
    }

    case 'dashboard':
      // In-app notifications are already delivered by existing in the table; the
      // dashboard reads them directly. `claim_notifications` excludes this channel,
      // so reaching here means a config change mid-flight.
      return 'sent';

    case 'push':
      // Push requires a device-token registry, which is Phase 4 work. Suppress
      // rather than fail so the row does not retry forever.
      return 'suppressed';

    default:
      return 'suppressed';
  }
}

async function primaryNumberFor(
  businessId: string,
  channel: string,
): Promise<string | null> {
  const wanted = channel === 'whatsapp' ? 'whatsapp' : 'sms';

  const { data } = await getAdminClient()
    .from('phone_numbers')
    .select('e164, channels, is_primary')
    .eq('business_id', businessId)
    .is('released_at', null)
    .order('is_primary', { ascending: false });

  const rows = (data ?? []) as Array<{ e164: string; channels: string[] }>;
  return rows.find((row) => row.channels.includes(wanted))?.e164 ?? null;
}

/**
 * SMS body for an owner alert.
 *
 * Kept to one segment where possible and deliberately identifier-light: the
 * caller's number is reduced to its last four digits because an owner alert may
 * land on a shared phone, and the full number is one tap away in the dashboard.
 */
function composeSmsBody(notification: ClaimedNotification): string {
  const payload = notification.payload as {
    customer_name?: string;
    customer_phone?: string;
    summary?: string;
    urgency?: string;
  };

  const who =
    payload.customer_name ??
    (payload.customer_phone ? `caller ending ${phoneTail(payload.customer_phone)}` : 'a caller');

  switch (notification.event) {
    case 'handover_required':
      return `${payload.urgency === 'emergency' ? 'URGENT: ' : ''}${who} needs a person. ${payload.summary ?? ''}`.trim();
    case 'lead_qualified':
      return `New qualified lead: ${who}. ${payload.summary ?? ''}`.trim();
    case 'lead_captured':
      return `New enquiry from ${who}. ${payload.summary ?? ''}`.trim();
    case 'missed_call':
      return `Missed call from ${payload.customer_phone ? formatPhoneForDisplay(payload.customer_phone) : 'an unknown number'}. We've texted them.`;
    case 'appointment_booked':
      return `Appointment booked with ${who}. ${payload.summary ?? ''}`.trim();
    default:
      return notification.body ?? defaultSubject(notification.event);
  }
}

function defaultSubject(event: NotificationEvent): string {
  switch (event) {
    case 'missed_call':
      return 'Missed call';
    case 'new_conversation':
      return 'New conversation';
    case 'new_message':
      return 'New message';
    case 'lead_captured':
      return 'New enquiry';
    case 'lead_qualified':
      return 'New qualified lead';
    case 'handover_required':
      return 'A conversation needs you';
    case 'appointment_booked':
      return 'Appointment booked';
    case 'appointment_cancelled':
      return 'Appointment cancelled';
    case 'daily_digest':
      return 'Your daily summary';
    case 'weekly_digest':
      return 'Your weekly summary';
    default:
      return 'Notification';
  }
}

/**
 * Compose the human-readable body for a handover alert.
 *
 * Front-loads what the owner needs to decide whether to drop everything: why it
 * escalated, and what the customer actually said.
 */
export function composeHandoverBody(input: {
  businessName: string;
  customerName: string | null;
  customerPhone: string | null;
  reason: string;
  note: string | null;
  summary: string | null;
  lastMessage: string | null;
  conversationUrl: string;
}): string {
  const lines = [
    `A conversation on ${input.businessName} needs a person.`,
    '',
    `Reason: ${input.reason}${input.note ? ` — ${input.note}` : ''}`,
    '',
    `Customer: ${input.customerName ?? 'unknown'}${
      input.customerPhone ? ` (${formatPhoneForDisplay(input.customerPhone)})` : ''
    }`,
  ];

  if (input.lastMessage) {
    lines.push('', 'Their last message:', `  "${input.lastMessage}"`);
  }

  if (input.summary) {
    lines.push('', 'Conversation so far:', `  ${input.summary}`);
  }

  lines.push(
    '',
    'The assistant has stopped replying and is waiting for you.',
    '',
    `Open it: ${input.conversationUrl}`,
  );

  return lines.join('\n');
}
