import OpenAI from 'openai';

import {
  estimateCostUsd,
  ProviderError,
  type AiProvider,
  type GenerateRequest,
  type GenerateResult,
  type JsonSchema,
} from './provider.ts';

/**
 * OpenAI adapter.
 *
 * Uses Chat Completions rather than the Responses API: this adapter only ever
 * needs one turn of text or one JSON object, and Chat Completions is the surface
 * with the widest model compatibility for exactly that.
 *
 * Structured output uses `response_format: json_schema` with `strict: true`,
 * which requires every property to be listed in `required` and
 * `additionalProperties: false` on every object. Our extraction schema is built
 * that way (see prompts/extraction.ts) — `strict` is the difference between
 * "usually valid JSON" and "always valid JSON", and the whole point of the
 * extractor is that the dashboard can trust its output.
 */
export class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const;
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, maxRetries: 2 });
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();

    const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: request.model,
      max_completion_tokens: request.maxOutputTokens,
      messages: [
        { role: 'system', content: request.system },
        ...request.messages.map((m) => ({ role: m.role, content: m.content }) as const),
      ],
    };

    if (typeof request.temperature === 'number') {
      body.temperature = request.temperature;
    }

    if (request.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: request.jsonSchema.name,
          strict: true,
          schema: request.jsonSchema.schema as Record<string, unknown>,
        },
      };
    }

    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(body, {
        timeout: request.timeoutMs ?? 60_000,
      });
    } catch (error) {
      throw toProviderError(error);
    }

    const choice = completion.choices[0];
    const usage = {
      promptTokens: completion.usage?.prompt_tokens ?? null,
      completionTokens: completion.usage?.completion_tokens ?? null,
      cachedTokens: completion.usage?.prompt_tokens_details?.cached_tokens ?? null,
    };

    const text = (choice?.message.content ?? '').trim();

    // A `content_filter` finish is the OpenAI analogue of a refusal, and the
    // SDK also exposes an explicit `refusal` field on the message. Either way the
    // caller must escalate rather than retry.
    const refused = choice?.finish_reason === 'content_filter' || Boolean(choice?.message.refusal);

    return {
      provider: this.name,
      model: completion.model ?? request.model,
      text: refused ? '' : text,
      json: !refused && request.jsonSchema ? parseJson(text) : undefined,
      usage,
      costUsd: estimateCostUsd(completion.model ?? request.model, usage),
      latencyMs: Date.now() - started,
      stopReason: choice?.finish_reason ?? null,
      truncated: choice?.finish_reason === 'length',
      ...(refused
        ? {
            refusal: {
              category: choice?.finish_reason ?? 'content_filter',
              explanation: choice?.message.refusal ?? null,
            },
          }
        : {}),
    };
  }
}

/**
 * OpenAI's strict mode rejects schemas that omit `additionalProperties: false` or
 * that leave any property out of `required`. Rather than maintaining a second
 * hand-written copy of every schema, normalise ours on the way in.
 */
export function toStrictSchema(schema: JsonSchema): JsonSchema {
  if (schema['type'] !== 'object') return schema;

  const properties = (schema['properties'] ?? {}) as Record<string, JsonSchema>;
  const normalisedProperties: Record<string, JsonSchema> = {};
  for (const [key, value] of Object.entries(properties)) {
    normalisedProperties[key] = toStrictSchema(value);
  }

  return {
    ...schema,
    properties: normalisedProperties,
    required: Object.keys(normalisedProperties),
    additionalProperties: false,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ProviderError('openai', 'Structured output was not valid JSON', {
      retryable: true,
      cause,
    });
  }
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof OpenAI.APIError) {
    return new ProviderError('openai', error.message, { status: error.status, cause: error });
  }
  if (error instanceof Error) {
    return new ProviderError('openai', error.message, { cause: error });
  }
  return new ProviderError('openai', String(error));
}
