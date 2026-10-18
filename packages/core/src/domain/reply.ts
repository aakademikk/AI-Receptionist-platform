import { AsyncLocalStorage } from 'node:async_hooks';

import { generateWithRetry } from '../ai/index.ts';
import type { GenerateResult } from '../ai/provider.ts';
import { buildReceptionistSystemPrompt } from '../prompts/receptionist.ts';
import { getAdminClient } from '../supabase/admin.ts';
import type { BusinessContext, ConversationMemory } from '../types/domain.ts';
import { providerRefused } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';
import { redactObject } from '../utils/redact.ts';
import { cleanModelReply, measureSms, trimToSegments } from '../utils/sms.ts';
import { limitForSpeech, MAX_SPOKEN_CHARS } from '../utils/speech.ts';
import { timed, type TurnTimer } from './turn-timings.ts';

/**
 * AI Response engine.
 *
 * Builds the prompt, calls the tenant's chosen model, sanitises the output for the
 * channel it is going out on, and records the call in `ai_logs`. It does not send
 * anything — sending is the messaging workflow's job — so this function stays pure
 * enough to test and to re-run against a finished conversation.
 */

/**
 * Carries a voice call's model override from `replyToCaller` down to `generateReply`.
 *
 * Between the two sits `handleInboundMessage`, which builds the `generateReply` input and
 * serves every channel; the speed test must not change it, so the override travels as
 * async context instead of a new field on the pipeline. It is set only by `replyToCaller`,
 * for the span of one voice turn, so no SMS, WhatsApp or web chat reply can ever see one.
 * An explicit `modelOverride` on the input wins over it.
 */
export const modelOverrideScope = new AsyncLocalStorage<string>();

export interface GenerateReplyInput {
  context: BusinessContext;
  memory: ConversationMemory;
  traceId?: string;
  now?: Date;
  /** Voice only: collects stage timings; see `turn-timings.ts`. Observational. */
  timer?: TurnTimer;
  /**
   * Voice only: a model name that replaces the tenant's `ai_model` for this reply, with the
   * provider unchanged. It exists for the Amy speed test, which must try another model on
   * phone calls without writing `business_settings`, because that row also drives SMS,
   * WhatsApp and web chat. Absent means the tenant's model, exactly as before. The caller
   * is responsible for having validated the name; `ai_logs` records `result.model`, so the
   * override shows there with no new column.
   */
  modelOverride?: string;
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
  /** Streamed voice replies only: first and last token times, for stage timing. */
  timing?: GenerateResult['timing'];
  /** Google only: the visible answer and hidden reasoning split of the completion tokens. */
  visibleTokens?: number | null;
  thinkingTokens?: number | null;
}

export async function generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult> {
  const { context, memory } = input;
  const settings = context.settings;
  const log = logger.child({
    traceId: input.traceId,
    businessId: context.business_id,
    conversationId: memory.conversation_id,
  });

  const { system, messages } = await timed(input.timer, 'prompt_build', () => {
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

    return { system, messages };
  });

  const model = input.modelOverride ?? modelOverrideScope.getStore() ?? settings.ai_model;

  let result: GenerateResult;
  try {
    result = await generateWithRetry(settings.ai_provider, {
      model,
      system,
      messages,
      // Thinking shares this budget on current Claude models, so the configured
      // value is well above what a two-sentence SMS needs.
      maxOutputTokens: settings.ai_max_output_tokens,
      effort: settings.ai_effort,
      temperature: settings.ai_temperature,
      timeoutMs: 45_000,
      // A voice turn streams internally so the first token can be timed; the
      // reply it hands back is still the whole text.
      stream: memory.channel === 'voice',
      traceId: input.traceId,
    });
  } catch (error) {
    // Log the failure against the tenant so a broken model config is visible in
    // the dashboard rather than only in server logs.
    await timed(input.timer, 'record_ai_log', () =>
      recordAiLog({
        businessId: context.business_id,
        conversationId: memory.conversation_id,
        purpose: 'reply',
        provider: settings.ai_provider,
        model,
        effort: settings.ai_effort,
        status: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
        traceId: input.traceId,
      }),
    );
    throw error;
  }

  // Timings come from the streamed call (voice) and the usage block; absent stays absent.
  if (input.timer) {
    if (result.timing) {
      if (result.timing.firstTokenMs !== null) input.timer.set('gemini_first_token', result.timing.firstTokenMs);
      input.timer.set('gemini_last_token', result.timing.lastTokenMs);
    }
    input.timer.note('prompt_tokens', result.usage.promptTokens ?? null);
    input.timer.note('visible_tokens', result.usage.visibleTokens ?? null);
    input.timer.note('thinking_tokens', result.usage.thinkingTokens ?? null);
  }

  const aiLogId = await timed(input.timer, 'record_ai_log', () =>
    recordAiLog({
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
    }),
  );

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
      timing: result.timing,
      visibleTokens: result.usage.visibleTokens,
      thinkingTokens: result.usage.thinkingTokens,
    };
  }

  const cleaned = cleanModelReply(result.text);

  // Truncation is not only an empty-reply problem. A model that runs out of tokens
  // mid-sentence still returns text that reads like a reply, and the customer has
  // no way to tell it was cut off — half a sentence is worse than none, because
  // they will act on it. Escalate either way and let a person finish the thought.
  if (result.truncated) {
    log.error('Model reply was truncated; escalating instead of sending part of a message', {
      stopReason: result.stopReason,
      producedText: cleaned !== '',
    });
    throw providerRefused({
      reason: 'Response was truncated before it finished — ai_max_output_tokens is likely too low.',
      stopReason: result.stopReason,
    });
  }

  if (cleaned === '') {
    // A model can also return nothing at all. Surfacing it as a refusal-shaped
    // outcome routes it to a human rather than sending an empty SMS.
    log.error('Model produced no usable reply text', { stopReason: result.stopReason });
    throw providerRefused({
      reason: 'Model returned an empty reply.',
      stopReason: result.stopReason,
    });
  }

  /*
   * Trim to suit the channel, not to suit SMS on both.
   *
   * `memory.channel` is already here, so this costs no new input and cannot be forgotten
   * by a caller: a reply composed for a phone call is shaped for a phone call. The two
   * limits measure different things — septets against a carrier's segment boundary, or
   * characters against how long somebody will listen — and using the SMS one on a call
   * would cut a caller off at a sentence the model never ended.
   */
  const spoken = memory.channel === 'voice';

  const { body, wasTrimmed } = spoken
    ? limitForSpeech(cleaned, MAX_SPOKEN_CHARS)
    : trimToSegments(cleaned, settings.max_sms_segments);

  if (wasTrimmed) {
    log.info('Trimmed the reply to fit the channel', {
      channel: memory.channel,
      ...(spoken
        ? { maxChars: MAX_SPOKEN_CHARS, originalLength: cleaned.length }
        : { maxSegments: settings.max_sms_segments, originalSegments: measureSms(cleaned).segments }),
    });
  }

  return {
    body,
    aiLogId,
    model: result.model,
    provider: result.provider,
    latencyMs: result.latencyMs,
    costUsd: result.costUsd,
    // Still a true statement about the text on both channels — it is simply no longer
    // the measurement that governed the trim once the reply is going to be spoken.
    segments: measureSms(body).segments,
    wasTrimmed,
    refused: null,
    timing: result.timing,
    visibleTokens: result.usage.visibleTokens,
    thinkingTokens: result.usage.thinkingTokens,
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
