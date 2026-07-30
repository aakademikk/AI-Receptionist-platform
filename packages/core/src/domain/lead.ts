import { generateWithRetry } from '../ai/index.ts';
import {
  buildExtractionSystemPrompt,
  buildExtractionUserMessage,
  scoreLead,
  LEAD_EXTRACTION_SCHEMA,
  LEAD_EXTRACTION_SCHEMA_NAME,
} from '../prompts/extraction.ts';
import { getAdminClient } from '../supabase/admin.ts';
import type {
  BusinessContext,
  ConversationMemory,
  LeadExtraction,
} from '../types/domain.ts';
import { logger } from '../utils/logger.ts';
import { normalizePhone } from '../utils/phone.ts';
import { recordAiLog } from './reply.ts';

/**
 * Lead Extractor.
 *
 * Runs as its own model call after every inbound message, and writes through
 * `public.upsert_lead()` so the merge semantics live in one transactional place:
 * a later extraction that fails to restate the postcode must not erase it.
 *
 * The model's output is treated as untrusted input. It is schema-constrained at
 * the provider, then validated and coerced here, because a schema guarantees
 * shape and says nothing about whether "urgency" came back as "very urgent!!".
 */

export interface ExtractLeadInput {
  context: BusinessContext;
  memory: ConversationMemory;
  traceId?: string;
}

export interface ExtractLeadResult {
  leadId: string | null;
  extraction: LeadExtraction | null;
  score: number;
  aiLogId: string | null;
  /** True when the model declined; the caller should not treat this as a failure. */
  refused: boolean;
}

export async function extractLead(input: ExtractLeadInput): Promise<ExtractLeadResult> {
  const { context, memory } = input;
  const settings = context.settings;
  const log = logger.child({
    traceId: input.traceId,
    businessId: context.business_id,
    conversationId: memory.conversation_id,
  });

  // Nothing the customer has said yet means nothing to extract. Calling the model
  // on an empty transcript wastes a request and produces an all-empty record that
  // would overwrite nothing but still churn the row.
  const hasCustomerInput = memory.transcript.some(
    (m) => m.sender === 'customer' && m.body?.trim(),
  );
  if (!hasCustomerInput) {
    return { leadId: null, extraction: null, score: 0, aiLogId: null, refused: false };
  }

  const system = buildExtractionSystemPrompt(context);
  const user = buildExtractionUserMessage(memory);

  const result = await generateWithRetry(settings.extraction_provider, {
    model: settings.extraction_model,
    system,
    messages: [{ role: 'user', content: user }],
    // Extraction output is bounded by the schema; the budget only needs to cover
    // the JSON plus (on thinking models) the reasoning that precedes it.
    maxOutputTokens: 2048,
    effort: 'low',
    temperature: settings.ai_temperature,
    jsonSchema: { name: LEAD_EXTRACTION_SCHEMA_NAME, schema: LEAD_EXTRACTION_SCHEMA },
    timeoutMs: 45_000,
    traceId: input.traceId,
  });

  const aiLogId = await recordAiLog({
    businessId: context.business_id,
    conversationId: memory.conversation_id,
    purpose: 'extraction',
    provider: settings.extraction_provider,
    model: result.model,
    status: result.refusal ? 'refused' : 'ok',
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    cachedTokens: result.usage.cachedTokens,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    stopReason: result.stopReason,
    request: { system, user },
    response: result.json ?? { text: result.text },
    traceId: input.traceId,
  });

  if (result.refusal) {
    log.warn('Extraction was declined by the provider');
    return { leadId: null, extraction: null, score: 0, aiLogId, refused: true };
  }

  const extraction = coerceExtraction(result.json, memory);
  if (!extraction) {
    log.warn('Extraction returned an unusable payload', { stopReason: result.stopReason });
    return { leadId: null, extraction: null, score: 0, aiLogId, refused: false };
  }

  const score = scoreLead(extraction);

  // upsert_lead owns the merge, the service match and the status guard.
  const { data, error } = await getAdminClient().rpc('upsert_lead', {
    p_conversation_id: memory.conversation_id,
    p_extraction: extraction,
    p_extraction_version: 1,
  });

  if (error) {
    // Losing an extraction is recoverable — the next inbound message re-runs it —
    // so this is logged loudly but not thrown, to avoid failing the customer reply.
    log.error('upsert_lead failed', { error: error.message });
    return { leadId: null, extraction, score, aiLogId, refused: false };
  }

  const leadId = typeof data === 'string' ? data : null;

  if (leadId) {
    await getAdminClient().from('leads').update({ score }).eq('id', leadId);
  }

  return { leadId, extraction, score, aiLogId, refused: false };
}

/**
 * Validate and coerce the model's JSON.
 *
 * Everything here is defence against a well-formed-but-wrong payload:
 *  * unknown enum values are dropped rather than passed to Postgres (which would
 *    raise, though `upsert_lead` also guards);
 *  * the phone number falls back to the channel identity, which we know is real;
 *  * strings are trimmed and length-capped, because a model that decides to write
 *    an essay in `summary` should not be able to bloat the row.
 */
function coerceExtraction(raw: unknown, memory: ConversationMemory): LeadExtraction | null {
  if (raw === null || typeof raw !== 'object') return null;

  const record = raw as Record<string, unknown>;
  const str = (key: string, maxLength = 500): string => {
    const value = record[key];
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLength);
  };

  const URGENCIES = ['low', 'normal', 'high', 'emergency'] as const;
  const STATUSES = [
    'new',
    'qualifying',
    'qualified',
    'booked',
    'nurture',
    'unqualified',
    'lost',
    'won',
  ] as const;

  const rawUrgency = str('urgency', 32).toLowerCase();
  const urgency = (URGENCIES as readonly string[]).includes(rawUrgency)
    ? (rawUrgency as LeadExtraction['urgency'])
    : '';

  const rawStatus = str('lead_status', 32).toLowerCase();
  const leadStatus = (STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as LeadExtraction['lead_status'])
    : '';

  // The number the message arrived from is more trustworthy than anything the
  // model transcribed, so it is the fallback rather than the override.
  const extractedPhone = str('phone', 32);
  const normalised = extractedPhone
    ? normalizePhone(extractedPhone, memory.customer_phone ? 'GB' : 'GB').e164
    : null;

  return {
    name: str('name', 120),
    phone: normalised ?? memory.customer_phone ?? '',
    email: str('email', 254).toLowerCase(),
    postcode: str('postcode', 16).toUpperCase(),
    service: str('service', 160),
    summary: str('summary', 1000),
    enquiry: str('enquiry', 2000),
    urgency,
    lead_status: leadStatus,
    callback_time: str('callback_time', 120),
  };
}

/**
 * Which notification events this extraction should raise.
 *
 * Returned rather than dispatched so the caller decides ordering — the owner
 * should hear "qualified lead" after the reply has gone out, not before.
 */
export function leadNotificationEvents(
  extraction: LeadExtraction,
  previousStatus: string,
): Array<'lead_captured' | 'lead_qualified'> {
  const events: Array<'lead_captured' | 'lead_qualified'> = [];

  // First time we have anything worth calling a lead.
  if (previousStatus === 'new' && extraction.lead_status !== 'new') {
    events.push('lead_captured');
  }

  // Crossing into qualified is the event an owner actually cares about.
  const qualified = ['qualified', 'booked', 'won'];
  if (qualified.includes(extraction.lead_status) && !qualified.includes(previousStatus)) {
    events.push('lead_qualified');
  }

  return events;
}
