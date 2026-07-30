import { GoogleGenAI, type GenerateContentConfig, type GenerateContentResponse } from '@google/genai';

import {
  estimateCostUsd,
  ProviderError,
  type AiProvider,
  type GenerateRequest,
  type GenerateResult,
} from './provider.ts';

/**
 * Google Gemini adapter.
 *
 * Two shape differences from the other two providers:
 *
 *  * The system prompt is `config.systemInstruction`, not a message with a
 *    `system` role.
 *  * Structured output is `responseMimeType: 'application/json'` plus
 *    `responseJsonSchema`. Since @google/genai v1.9 the plain `responseSchema`
 *    field expects Google's own Schema type, while raw JSON Schema belongs in
 *    `responseJsonSchema` — using the wrong one silently degrades to unconstrained
 *    output, which is exactly the failure the extractor cannot tolerate.
 */
export class GoogleProvider implements AiProvider {
  readonly name = 'google' as const;
  private readonly client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();

    const config: GenerateContentConfig = {
      systemInstruction: request.system,
      maxOutputTokens: request.maxOutputTokens,
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
    const usage = {
      promptTokens: usageMeta?.promptTokenCount ?? null,
      completionTokens: usageMeta?.candidatesTokenCount ?? null,
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
