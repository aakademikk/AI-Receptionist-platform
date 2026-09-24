import type { CommsChannel } from '../types/domain.ts';

/**
 * The `source` a new conversation is opened with, and so the one its lead inherits.
 *
 * `upsert_lead` copies `conversations.source` onto `leads.source`, and
 * `resolve_inbound` sets that once, from this, when it opens the thread. Before this
 * existed every channel but WhatsApp read `inbound_sms`, so a lead taken on a phone
 * call was indistinguishable from one taken by text.
 *
 * Unanswered calls are not this function's business: `record_missed_call` opens its
 * own conversation with `missed_call`, and that stays as it is.
 */
export function sourceForChannel(channel: CommsChannel): string {
  switch (channel) {
    case 'whatsapp':
      return 'whatsapp';
    case 'voice':
      return 'voice_call';
    default:
      return 'inbound_sms';
  }
}
