/**
 * The provider-agnostic model interface.
 *
 * Every tenant picks a provider (`anthropic` | `openai` | `google`). The rest of
 * the platform must not care which — so the differences are absorbed here rather
 * than leaking into prompt code, workflows or the dashboard.
 *
 * The interface is deliberately narrow. We need exactly two things from a model:
 * a conversational reply, and a JSON object matching a schema. Anything wider
 * would be surface area we never exercise but still have to keep working across
 * three SDKs.
 */

// `ProviderName` and `Effort` are declared once, in types/domain.ts, and
// re-exported here so the AI layer reads as self-contained without creating a
// second competing declaration of the same union.
import type { Effort, ProviderName } from '../types/domain.ts';

export type { Effort, ProviderName };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A JSON Schema object. Kept loose because each SDK types it differently. */
export type JsonSchema = Record<string, unknown>;

export interface GenerateRequest {
  /** System prompt. Built by packages/core/src/prompts. */
  system: string;
  messages: ChatMessage[];
  model: string;
  maxOutputTokens: number;
  effort?: Effort;
  /**
   * Only forwarded to providers that accept it. Claude Opus 5 and its
   * generation reject `temperature` with a 400, so the Anthropic adapter drops
   * it rather than letting a tenant's stored setting break every reply.
   */
  temperature?: number | null;
  /**
   * When set, the model is constrained to emit JSON matching this schema. Used by
   * the lead extractor and the onboarding extractor.
   */
  jsonSchema?: { name: string; schema: JsonSchema };
  timeoutMs?: number;
  /** Correlation id, threaded through to ai_logs for cross-system tracing. */
  traceId?: string;
}

export interface TokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
}

export interface GenerateResult {
  provider: ProviderName;
  model: string;
  /** Reply text. Empty string when the model produced only structured output. */
  text: string;
  /** Parsed object when `jsonSchema` was requested. */
  json?: unknown;
  usage: TokenUsage;
  /** Null when we have no verified price for the model — never a guess. */
  costUsd: number | null;
  latencyMs: number;
  stopReason: string | null;
  /**
   * Populated when the provider's safety layer declined the request. This is a
   * successful HTTP response, not an error, and must be handled as a content
   * outcome: hand the conversation to a human rather than retrying.
   */
  refusal?: { category: string | null; explanation: string | null };
  /** True when output was cut off — the caller should not treat text as complete. */
  truncated: boolean;
}

export interface AiProvider {
  readonly name: ProviderName;
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

/**
 * Raised for provider faults we can retry or fall back on (timeouts, 5xx, rate
 * limits). A refusal is *not* one of these — it comes back as a normal result.
 */
export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    provider: ProviderName,
    message: string,
    options: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = options.status;
    // 408/409/429 and 5xx are worth another attempt; a 400 is our bug.
    this.retryable =
      options.retryable ??
      (options.status === undefined
        ? true
        : options.status === 408 ||
          options.status === 409 ||
          options.status === 429 ||
          options.status >= 500);
  }
}

/**
 * Published per-million-token prices, input/output.
 *
 * Only models whose pricing we have actually verified are listed. An unlisted
 * model yields `costUsd: null` rather than a plausible-looking fabrication —
 * a wrong number in a billing dashboard is worse than a blank one.
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export function estimateCostUsd(
  model: string,
  usage: TokenUsage,
): number | null {
  const price = PRICE_PER_MTOK[model];
  if (!price) return null;

  const promptTokens = usage.promptTokens ?? 0;
  const completionTokens = usage.completionTokens ?? 0;
  const cachedTokens = usage.cachedTokens ?? 0;

  // Cached reads bill at roughly a tenth of the input rate. Treat the cached
  // portion separately so a heavily-cached workload isn't over-reported.
  const uncachedPrompt = Math.max(promptTokens - cachedTokens, 0);
  const cost =
    (uncachedPrompt / 1_000_000) * price.input +
    (cachedTokens / 1_000_000) * price.input * 0.1 +
    (completionTokens / 1_000_000) * price.output;

  return Number(cost.toFixed(6));
}

/** True for the Claude generations that reject sampling parameters with a 400. */
export function rejectsSamplingParams(model: string): boolean {
  return (
    /^claude-(fable|mythos)-5/.test(model) ||
    /^claude-opus-(5|4-7|4-8)/.test(model) ||
    /^claude-sonnet-5/.test(model)
  );
}
