import { GoogleGenAI, type GenerateContentConfig, type GenerateContentResponse } from '@google/genai';

import {
  estimateCostUsd,
  ProviderError,
  type AiProvider,
  type Effort,
  type GenerateRequest,
  type GenerateResult,
} from './provider.ts';

/**
 * Google Gemini adapter.
 *
 * Three shape differences from the other two providers:
 *
 *  * The system prompt is `config.systemInstruction`, not a message with a
 *    `system` role.
 *  * Structured output is `responseMimeType: 'application/json'` plus
 *    `responseJsonSchema`. Since @google/genai v1.9 the plain `responseSchema`
 *    field expects Google's own Schema type, while raw JSON Schema belongs in
 *    `responseJsonSchema` — using the wrong one silently degrades to unconstrained
 *    output, which is exactly the failure the extractor cannot tolerate.
 *  * Thinking shares the `maxOutputTokens` budget and cannot be switched off on
 *    every model, so headroom is added rather than taken. See THINKING_BUDGET.
 */

/**
 * Hidden-reasoning allowance per effort level, and the headroom added on top of
 * the caller's `maxOutputTokens`.
 *
 * Measured against the live API rather than assumed, because every simpler design
 * is wrong on at least one current model:
 *
 *  * `thinkingLevel` is not portable. `MINIMAL` is a hard 400 on both
 *    `gemini-3.8-flash` and `gemini-pro-latest`, while `LOW` on `gemini-3.5-flash`
 *    reasons *more* than leaving thinking unset.
 *  * `thinkingBudget: 0` is a 400 on `gemini-pro-latest` — "This model only works
 *    in thinking mode" — so disabling thinking would break every reply for a
 *    tenant on a pro model. We never send 0.
 *  * The budget is advisory, not binding, on `gemini-3.5-flash` and
 *    `gemini-pro-latest`: a budget of 1 still spent 367 reasoning tokens.
 *
 * That last point is why this doubles as headroom. A cap alone cannot protect the
 * reply, because a model may ignore it — so `maxOutputTokens` is sent as the
 * caller's allowance *plus* this value, and the visible answer keeps its full
 * configured room whatever the model spends thinking. On `gemini-3.8-flash` a low
 * effort spends nothing at all and the reply completes in ~1s; on
 * `gemini-pro-latest`, which cannot stop thinking, the reply still completes.
 */
const THINKING_BUDGET: Record<Effort, number> = {
  low: 512,
  medium: 768,
  high: 1024,
  xhigh: 2048,
  max: 4096,
};
export class GoogleProvider implements AiProvider {
  readonly name = 'google' as const;
  private readonly client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();

    // See THINKING_BUDGET. The caller's allowance is what the visible answer may
    // use; the thinking allowance is added on top so the two cannot compete for
    // the same tokens.
    const thinkingBudget = THINKING_BUDGET[request.effort ?? 'low'];

    const config: GenerateContentConfig = {
      systemInstruction: request.system,
      maxOutputTokens: request.maxOutputTokens + thinkingBudget,
      thinkingConfig: { thinkingBudget },
      abortSignal: request.timeoutMs ? AbortSignal.timeout(request.timeoutMs) : undefined,
    };

    if (typeof request.temperature === 'number') {
      config.temperature = request.temperature;
    }

    if (request.jsonSchema) {
      config.responseMimeType = 'application/json';
      config.responseJsonSchema = request.jsonSchema.schema;
    }

    let response: GenerateContentResponse;
    try {
      response = await this.client.models.generateContent({
        model: request.model,
        // Gemini has no assistant/user distinction at the top level — it uses
        // 'model' for its own turns.
        contents: request.messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        config,
      });
    } catch (error) {
      throw toProviderError(error);
    }

    const usageMeta = response.usageMetadata;
    // Google bills thinking as output, but `candidatesTokenCount` counts only the
    // visible answer — so a pro-model reply that reasons for ~480 tokens would be
    // logged and priced as if it produced ~50. Fold the hidden tokens in, and stay
    // null only when the model reported no completion figures at all.
    const visibleTokens = usageMeta?.candidatesTokenCount ?? null;
    const thinkingTokens = usageMeta?.thoughtsTokenCount ?? null;
    const usage = {
      promptTokens: usageMeta?.promptTokenCount ?? null,
      completionTokens:
        visibleTokens === null && thinkingTokens === null
          ? null
          : (visibleTokens ?? 0) + (thinkingTokens ?? 0),
      cachedTokens: usageMeta?.cachedContentTokenCount ?? null,
    };

    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason ?? null;
    // SAFETY / PROHIBITED_CONTENT are Gemini's refusal equivalents.
    const refused = finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT';

    const text = (response.text ?? '').trim();

    return {
      provider: this.name,
      model: request.model,
      text: refused ? '' : text,
      json: !refused && request.jsonSchema ? parseJson(text) : undefined,
      usage,
      costUsd: estimateCostUsd(request.model, usage),
      latencyMs: Date.now() - started,
      stopReason: finishReason,
      truncated: finishReason === 'MAX_TOKENS',
      ...(refused
        ? {
            refusal: {
              category: finishReason,
              explanation: candidate?.finishMessage ?? null,
            },
          }
        : {}),
    };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ProviderError('google', 'Structured output was not valid JSON', {
      retryable: true,
      cause,
    });
  }
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof Error) {
    // The SDK surfaces HTTP status inside the message; pull it out so retry
    // classification still works.
    const match = /\b(4\d{2}|5\d{2})\b/.exec(error.message);
    const status = match ? Number.parseInt(match[1]!, 10) : undefined;
    return new ProviderError('google', error.message, { status, cause: error });
  }
  return new ProviderError('google', String(error));
}
