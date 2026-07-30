import { generateWithRetry } from '../ai/index.ts';
import type { GenerateResult } from '../ai/provider.ts';
import { buildReceptionistSystemPrompt } from '../prompts/receptionist.ts';
import { getAdminClient } from '../supabase/admin.ts';
import type { BusinessContext, ConversationMemory } from '../types/domain.ts';
import { providerRefused } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';
import { redactObject } from '../utils/redact.ts';
import { cleanModelReply, measureSms, trimToSegments } from '../utils/sms.ts';

/**
 * AI Response engine.
 *
 * Builds the prompt, calls the tenant's chosen model, sanitises the output for
 * SMS, and records the call in `ai_logs`. It does not send anything — sending is
 * the messaging workflow's job — so this function stays pure enough to test and
 * to re-run against a finished conversation.
 */

export interface GenerateReplyInput {
  context: BusinessContext;
  memory: ConversationMemory;
  traceId?: string;
  now?: Date;
}

export interface GenerateReplyResult {
  /** The message to send. Empty when `refused` is set. */
  body: string;
  aiLogId: string | null;
  model: string;
  provider: string;
  latencyMs: number;
  costUsd: number | null;
  segments: number;
  wasTrimmed: boolean;
  /** Set when the provider's safety layer declined; the caller must escalate. */
  refused: { category: string | null; explanation: string | null } | null;
}

export async function generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult> {
  const { context, memory } = input;
  const settings = context.settings;
  const log = logger.child({
    traceId: input.traceId,
    businessId: context.business_id,
    conversationId: memory.conversation_id,
  });

  const system = buildReceptionistSystemPrompt({ context, memory, now: input.now });

  // Only the customer's and the business's actual turns go in. System messages
  // (delivery receipts, internal notes) would read as instructions to the model.
  const messages = memory.transcript
    .filter((m) => m.body && m.body.trim() !== '' && m.sender !== 'system')
    .map((m) => ({
      role: m.sender === 'customer' ? ('user' as const) : ('assistant' as const),
      content: m.body!.trim(),
    }));

  // A model cannot be asked to reply to nothing. This happens when a thread was
  // opened by a missed call and the customer has not yet said anything.
  if (messages.length === 0 || messages[messages.length - 1]!.role !== 'user') {
    messages.push({
      role: 'user',
      content: '(The customer has not sent a message yet. Open the conversation.)',
    });
  }

  let result: GenerateResult;
  try {
    result = await generateWithRetry(settings.ai_provider, {
      model: settings.ai_model,
      system,
      messages,
      // Thinking shares this budget on current Claude models, so the configured
      // value is well above what a two-sentence SMS needs.
      maxOutputTokens: settings.ai_max_output_tokens,
      effort: settings.ai_effort,
      temperature: settings.ai_temperature,
      timeoutMs: 45_000,
      traceId: input.traceId,
    });
  } catch (error) {
    // Log the failure against the tenant so a broken model config is visible in
    // the dashboard rather than only in server logs.
    await recordAiLog({
      businessId: context.business_id,
      conversationId: memory.conversation_id,
      purpose: 'reply',
      provider: settings.ai_provider,
      model: settings.ai_model,
      effort: settings.ai_effort,
      status: 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
      traceId: input.traceId,
    });
    throw error;
  }

  const aiLogId = await recordAiLog({
    businessId: context.business_id,
    conversationId: memory.conversation_id,
    purpose: 'reply',
    provider: settings.ai_provider,
    model: result.model,
    effort: settings.ai_effort,
    status: result.refusal ? 'refused' : 'ok',
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    cachedTokens: result.usage.cachedTokens,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    stopReason: result.stopReason,
    request: { system, messages },
    response: { text: result.text },
    traceId: input.traceId,
  });

  if (result.refusal) {
    log.warn('Model declined to answer; escalating to a human', {
      category: result.refusal.category,
    });
    return {
      body: '',
      aiLogId,
      model: result.model,
      provider: result.provider,
      latencyMs: result.latencyMs,
      costUsd: result.costUsd,
      segments: 0,
      wasTrimmed: false,
      refused: result.refusal,
    };
  }

  const cleaned = cleanModelReply(result.text);

  if (cleaned === '') {
    // Truncation is the usual cause: thinking consumed the whole token budget.
    // Surfacing it as a refusal-shaped outcome routes it to a human rather than
    // sending an empty SMS.
    log.error('Model produced no usable reply text', {
      stopReason: result.stopReason,
      truncated: result.truncated,
    });
    throw providerRefused({
      reason: result.truncated
        ? 'Response was truncated before any text was produced — ai_max_output_tokens is likely too low.'
        : 'Model returned an empty reply.',
      stopReason: result.stopReason,
    });
  }

  const { body, wasTrimmed, metrics } = trimToSegments(cleaned, settings.max_sms_segments);

  if (wasTrimmed) {
    log.info('Trimmed reply to fit the SMS segment budget', {
      maxSegments: settings.max_sms_segments,
      originalSegments: measureSms(cleaned).segments,
    });
  }

  return {
    body,
    aiLogId,
    model: result.model,
    provider: result.provider,
    latencyMs: result.latencyMs,
    costUsd: result.costUsd,
    segments: metrics.segments,
    wasTrimmed,
    refused: null,
  };
}

/**
 * Rolling summary.
 *
 * Called off the reply path once a thread outgrows the verbatim window. Keeping it
 * separate means a slow summarisation never delays a customer's answer — the worst
 * case is that one reply is generated from a slightly stale summary.
 */
export async function summariseConversation(input: {
  context: BusinessContext;
  memory: ConversationMemory;
  traceId?: string;
}): Promise<string | null> {
  const { context, memory } = input;

  const transcript = memory.transcript
    .filter((m) => m.body?.trim())
    .map((m) => `${m.sender === 'customer' ? 'Customer' : 'Business'}: ${m.body!.trim()}`)
    .join('\n');

  if (transcript === '') return null;

  const system = [
    'You maintain a running summary of a customer service conversation so that a colleague, or an assistant with no memory of the earlier messages, can pick it up cold.',
    '',
    'Write 3 to 5 sentences of plain prose covering: what the customer wants, what has been established, what has been promised to them, and what is still outstanding.',
    '',
    'Record only what was actually said. Do not speculate about intent, do not add advice, and do not invent detail. If a previous summary is supplied, extend it rather than starting over.',
    '',
    'Return the summary text only.',
  ].join('\n');

  const user = [
    memory.summary ? `## Previous summary\n\n${memory.summary}\n` : '',
    `## Recent messages\n\n${transcript}`,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const result = await generateWithRetry(context.settings.ai_provider, {
      model: context.settings.ai_model,
      system,
      messages: [{ role: 'user', content: user }],
      maxOutputTokens: 1024,
      effort: 'low',
      temperature: context.settings.ai_temperature,
      timeoutMs: 30_000,
      traceId: input.traceId,
    });

    await recordAiLog({
      businessId: context.business_id,
      conversationId: memory.conversation_id,
      purpose: 'summary',
      provider: context.settings.ai_provider,
      model: result.model,
      status: result.refusal ? 'refused' : 'ok',
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      traceId: input.traceId,
    });

    if (result.refusal) return null;

    const summary = cleanModelReply(result.text);
    if (summary === '') return null;

    await getAdminClient()
      .from('conversations')
      .update({ summary })
      .eq('id', memory.conversation_id);

    return summary;
  } catch (error) {
    // A failed summary degrades quality slightly; it must never fail the request.
    logger.warn('Summarisation failed; keeping the previous summary', {
      conversationId: memory.conversation_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// -----------------------------------------------------------------------------
// ai_logs
// -----------------------------------------------------------------------------

interface RecordAiLogInput {
  businessId: string;
  conversationId?: string | null;
  messageId?: string | null;
  purpose: 'reply' | 'extraction' | 'summary' | 'handover_check' | 'onboarding_extract' | 'embedding';
  provider: string;
  model: string;
  effort?: string | null;
  status: 'ok' | 'error' | 'timeout' | 'refused' | 'filtered';
  promptTokens?: number | null;
  completionTokens?: number | null;
  cachedTokens?: number | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  stopReason?: string | null;
  errorMessage?: string | null;
  request?: unknown;
  response?: unknown;
  traceId?: string | null;
}

/**
 * Write an `ai_logs` row.
 *
 * Prompts and responses go through `redactObject` first: this table is the
 * debugging surface, and it must not become a second unmanaged copy of every
 * customer's personal data.
 *
 * Never throws. A failure to log must not fail the customer's reply — the log
 * exists to explain the reply, not to gate it.
 */
export async function recordAiLog(input: RecordAiLogInput): Promise<string | null> {
  try {
    const { data, error } = await getAdminClient()
      .from('ai_logs')
      .insert({
        business_id: input.businessId,
        conversation_id: input.conversationId ?? null,
        message_id: input.messageId ?? null,
        purpose: input.purpose,
        provider: input.provider,
        model: input.model,
        effort: input.effort ?? null,
        prompt_tokens: input.promptTokens ?? null,
        completion_tokens: input.completionTokens ?? null,
        cached_tokens: input.cachedTokens ?? null,
        cost_usd: input.costUsd ?? null,
        latency_ms: input.latencyMs ?? null,
        status: input.status,
        stop_reason: input.stopReason ?? null,
        error_message: input.errorMessage ?? null,
        request: input.request === undefined ? null : redactObject(input.request),
        response: input.response === undefined ? null : redactObject(input.response),
        trace_id: input.traceId ?? null,
      })
      .select('id')
      .single();

    if (error) {
      logger.warn('Failed to write ai_logs row', { error: error.message });
      return null;
    }
    return (data as { id: string }).id;
  } catch (error) {
    logger.warn('Failed to write ai_logs row', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
