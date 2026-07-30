import { getAdminClient, unwrap, unwrapMaybe } from '../supabase/admin.ts';
import type {
  BusinessContext,
  ConversationMemory,
  KnowledgeItemContext,
  KnownLeadFields,
  TranscriptMessage,
} from '../types/domain.ts';
import { notFound } from '../utils/errors.ts';

/**
 * Business Loader and Conversation Memory.
 *
 * Between them these two functions are everything the AI knows. They are the
 * n8n "Business Loader" and "Conversation Memory" workflows, implemented here
 * rather than as chains of HTTP nodes so that the shape of a prompt input is
 * defined once, in a typed place, and covered by tests.
 */

/**
 * How many recent messages are sent verbatim.
 *
 * Beyond this the older turns are represented by the rolling summary. 20 covers
 * the overwhelming majority of SMS threads in full; the cap exists so a
 * pathological 400-message thread cannot silently grow the prompt (and the bill)
 * without bound.
 */
const TRANSCRIPT_WINDOW = 20;

/** Summarisation kicks in once a thread is longer than the verbatim window. */
export const SUMMARY_TRIGGER_MESSAGES = TRANSCRIPT_WINDOW + 6;

/**
 * Load the full prompt context for a business.
 *
 * Reads the `business_ai_context` view — a single round trip that returns the
 * profile, settings, services, areas, hours, published knowledge and numbers
 * pre-aggregated. Six separate queries here would add ~40ms to a path where a
 * customer is waiting on an SMS.
 */
export async function loadBusinessContext(businessId: string): Promise<BusinessContext> {
  const supabase = getAdminClient();

  const context = unwrapMaybe(
    await supabase
      .from('business_ai_context')
      .select('*')
      .eq('business_id', businessId)
      .single<BusinessContext>(),
    'loadBusinessContext',
  );

  if (!context) throw notFound(`Business ${businessId}`);
  return context;
}

/** Resolve by slug or custom domain, for white-label routing. */
export async function loadBusinessContextBySlug(slug: string): Promise<BusinessContext | null> {
  const supabase = getAdminClient();
  return unwrapMaybe(
    await supabase
      .from('business_ai_context')
      .select('*')
      .eq('slug', slug)
      .single<BusinessContext>(),
    'loadBusinessContextBySlug',
  );
}

/**
 * Load conversation memory.
 *
 * Reads the conversation row, the recent transcript, and the current lead in
 * parallel — they are independent, and serialising three round trips for no
 * reason is the kind of thing that turns a 300ms webhook into a second.
 */
export async function loadConversationMemory(conversationId: string): Promise<ConversationMemory> {
  const supabase = getAdminClient();

  const [conversationResult, messagesResult, leadResult] = await Promise.all([
    supabase
      .from('conversations')
      .select(
        `id, business_id, contact_id, channel, status, customer_phone, customer_name,
         summary, current_topic, lead_status, ai_enabled, ai_turn_count,
         confusion_count, message_count`,
      )
      .eq('id', conversationId)
      .single(),
    supabase
      .from('messages')
      .select('id, direction, sender, body, created_at')
      .eq('conversation_id', conversationId)
      // Newest-first with a limit, then reversed below. Ordering ascending with a
      // limit would return the *oldest* N, which is the opposite of what a model
      // needs.
      .order('created_at', { ascending: false })
      .limit(TRANSCRIPT_WINDOW),
    supabase
      .from('leads')
      .select('name, phone, email, postcode, service_text, enquiry, urgency, callback_text')
      .eq('conversation_id', conversationId)
      .maybeSingle(),
  ]);

  const conversation = unwrapMaybe(conversationResult, 'loadConversationMemory');
  if (!conversation) throw notFound(`Conversation ${conversationId}`);

  const messages = unwrap(messagesResult, 'loadConversationMemory.messages');
  const lead = unwrapMaybe(leadResult, 'loadConversationMemory.lead');

  const transcript: TranscriptMessage[] = (messages as TranscriptMessage[])
    .slice()
    .reverse(); // back to chronological order for the model

  const known: KnownLeadFields = {
    name: lead?.name ?? conversation.customer_name ?? null,
    phone: lead?.phone ?? conversation.customer_phone ?? null,
    email: lead?.email ?? null,
    postcode: lead?.postcode ?? null,
    service: lead?.service_text ?? null,
    enquiry: lead?.enquiry ?? null,
    urgency: lead?.urgency ?? null,
    callback: lead?.callback_text ?? null,
  };

  // A contact with more than one conversation has been here before. Cheap to
  // derive, and it lets the AI acknowledge a returning caller.
  let isReturning = false;
  if (conversation.contact_id) {
    const { count } = await supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('contact_id', conversation.contact_id);
    isReturning = (count ?? 0) > 1;
  }

  return {
    conversation_id: conversation.id,
    business_id: conversation.business_id,
    channel: conversation.channel,
    status: conversation.status,
    customer_phone: conversation.customer_phone,
    customer_name: conversation.customer_name,
    summary: conversation.summary,
    current_topic: conversation.current_topic,
    lead_status: conversation.lead_status,
    ai_enabled: conversation.ai_enabled,
    ai_turn_count: conversation.ai_turn_count,
    confusion_count: conversation.confusion_count,
    message_count: conversation.message_count,
    transcript,
    known,
    is_returning_contact: isReturning,
  };
}

/**
 * Knowledge retrieval.
 *
 * `business_ai_context` already carries the published knowledge base, which for a
 * typical small business (a few dozen FAQs) is small enough to include wholesale —
 * and wholesale beats retrieval, because a missed retrieval means the AI says "I
 * don't know" about something the business explicitly documented.
 *
 * This function exists for the tenants where that stops being true. It ranks by
 * trigram similarity, which needs no embedding pipeline and no vector spend, and
 * is a genuinely good fit for FAQ matching where the query and the stored question
 * share vocabulary. Vector search is available (the column and index exist) for
 * tenants whose corpus outgrows this.
 */
export async function searchKnowledge(
  businessId: string,
  query: string,
  limit = 8,
): Promise<KnowledgeItemContext[]> {
  const supabase = getAdminClient();

  const cleaned = query.trim();
  if (cleaned.length < 3) return [];

  const rows = unwrap(
    await supabase
      .from('knowledge_items')
      .select('id, kind, title, content')
      .eq('business_id', businessId)
      .eq('is_published', true)
      .eq('needs_review', false)
      // Match either the question or the body. `or` with two ilike terms is
      // enough to hit the trigram indexes on both columns.
      .or(`title.ilike.%${escapeLike(cleaned)}%,content.ilike.%${escapeLike(cleaned)}%`)
      .limit(limit),
    'searchKnowledge',
  );

  return rows as KnowledgeItemContext[];
}

/**
 * Escape PostgREST `ilike` metacharacters.
 *
 * Without this, a customer message containing `%` matches everything, and one
 * containing a comma would break out of the `or()` filter list entirely — a
 * filter-injection bug, not just a bad result.
 */
function escapeLike(value: string): string {
  return value.replace(/[%_,()\\]/g, '');
}

/**
 * Should this conversation's history be compacted into a summary?
 *
 * Kept as a predicate rather than done inline so the decision is testable and so
 * the summarisation call can be moved off the reply path (it does not need to
 * block the customer's answer).
 */
export function needsSummarisation(memory: ConversationMemory): boolean {
  return memory.message_count > SUMMARY_TRIGGER_MESSAGES;
}
