import {
  GoogleGenAI,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type GenerateContentResponseUsageMetadata,
} from '@google/genai';

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
/** What the whole and the streamed paths both reduce a Gemini reply to. */
interface RawReply {
  text: string;
  finishReason: string | null;
  finishMessage: string | null;
  usageMeta: GenerateContentResponseUsageMetadata | undefined;
}

type GoogleModels = Pick<GoogleGenAI['models'], 'generateContent' | 'generateContentStream'>;

export class GoogleProvider implements AiProvider {
  readonly name = 'google' as const;
  private readonly models: GoogleModels;

  /** `models` is injectable so a test can pass a fake; production uses the SDK's. */
  constructor(apiKey: string, models?: GoogleModels) {
    this.models = models ?? new GoogleGenAI({ apiKey }).models;
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

    const params = {
      model: request.model,
      // Gemini has no assistant/user distinction at the top level — it uses
      // 'model' for its own turns.
      contents: request.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      config,
    };

    // Structured output stays on the whole-response call: partial JSON is useless.
    if (request.stream && !request.jsonSchema) {
      let raw: RawReply = { text: '', finishReason: null, finishMessage: null, usageMeta: undefined };
      let firstTokenMs: number | null = null;
      try {
        const stream = await this.models.generateContentStream(params);
        let text = '';
        for await (const chunk of stream) {
          const piece = chunk.text ?? '';
          if (piece !== '') {
            if (firstTokenMs === null) firstTokenMs = Date.now() - started;
            text += piece;
          }
          // The finish reason and usage normally arrive on the last chunk only, so
          // keep the last chunk that carries each.
          const candidate = chunk.candidates?.[0];
          if (candidate?.finishReason) {
            raw.finishReason = candidate.finishReason;
            raw.finishMessage = candidate.finishMessage ?? null;
          }
          if (chunk.usageMetadata) raw.usageMeta = chunk.usageMetadata;
        }
        raw.text = text;
      } catch (error) {
        throw toProviderError(error);
      }
      // A body that closed cleanly part-way through would otherwise be spoken as a whole
      // reply (no finish reason means the truncation guards never fire). The whole-response
      // path cannot do this, so treat it as a failed attempt and let the caller retry.
      if (raw.finishReason === null && raw.text !== '') {
        throw new ProviderError('google', 'stream ended without finish reason', { retryable: true });
      }
      const lastTokenMs = Date.now() - started;
      return {
        ...this.buildResult(request, started, raw),
        timing: { firstTokenMs, lastTokenMs },
      };
    }

    let response: GenerateContentResponse;
    try {
      response = await this.models.generateContent(params);
    } catch (error) {
      throw toProviderError(error);
    }

    const candidate = response.candidates?.[0];
    return this.buildResult(request, started, {
      text: response.text ?? '',
      finishReason: candidate?.finishReason ?? null,
      finishMessage: candidate?.finishMessage ?? null,
      usageMeta: response.usageMetadata,
    });
  }

  /** The one place a reply becomes a `GenerateResult`, so the two paths cannot drift. */
  private buildResult(request: GenerateRequest, started: number, raw: RawReply): GenerateResult {
    const usageMeta = raw.usageMeta;
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
      visibleTokens,
      thinkingTokens,
    };

    const finishReason = raw.finishReason;
    // SAFETY / PROHIBITED_CONTENT are Gemini's refusal equivalents.
    const refused = finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT';

    const text = raw.text.trim();

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
              explanation: raw.finishMessage,
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
