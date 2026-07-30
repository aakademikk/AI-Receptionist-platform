import Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/messages';

import {
  estimateCostUsd,
  ProviderError,
  rejectsSamplingParams,
  type AiProvider,
  type GenerateRequest,
  type GenerateResult,
} from './provider.ts';

/**
 * Anthropic adapter — the platform default.
 *
 * Three model-generation details are handled here so no caller has to know them:
 *
 *  1. `temperature` / `top_p` / `top_k` are rejected outright by Claude Opus 5,
 *     Sonnet 5, Opus 4.7/4.8 and Fable 5. A tenant may still have a temperature
 *     saved from when they were on an older model, so we drop it rather than
 *     letting a stale setting 400 every reply.
 *
 *  2. Thinking is on by default on Opus 5. We leave it on and control spend with
 *     `output_config.effort` instead of disabling it — disabling thinking on this
 *     generation can cause tool calls to be written as plain prose and `<thinking>`
 *     tags to leak into the reply, both of which would reach a customer by SMS.
 *     Because thinking shares the `max_tokens` budget with the reply, callers must
 *     size `maxOutputTokens` above what the visible answer needs.
 *
 *  3. `stop_reason: 'refusal'` is an HTTP 200. Reading `content[0]` without
 *     checking it would throw on exactly the requests we most need to handle
 *     gracefully, so refusals are surfaced as a normal result for the caller to
 *     escalate to a human.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2 });
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();

    const params: MessageCreateParams = {
      model: request.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    };

    // Effort and structured output both live under output_config.
    const outputConfig: NonNullable<MessageCreateParams['output_config']> = {};
    if (request.effort) outputConfig.effort = request.effort;
    if (request.jsonSchema) {
      outputConfig.format = { type: 'json_schema', schema: request.jsonSchema.schema };
    }
    if (Object.keys(outputConfig).length > 0) params.output_config = outputConfig;

    // See (1) above.
    if (typeof request.temperature === 'number' && !rejectsSamplingParams(request.model)) {
      params.temperature = request.temperature;
    }

    let response: Awaited<ReturnType<typeof this.client.messages.create>>;
    try {
      response = await this.client.messages.create(params, {
        timeout: request.timeoutMs ?? 60_000,
      });
    } catch (error) {
      throw toProviderError(error);
    }

    // A streaming response would not have `content`; we never request one here.
    if (!('content' in response)) {
      throw new ProviderError('anthropic', 'Unexpected streaming response', {
        retryable: false,
      });
    }

    const usage = {
      promptTokens: response.usage.input_tokens ?? null,
      completionTokens: response.usage.output_tokens ?? null,
      cachedTokens: response.usage.cache_read_input_tokens ?? null,
    };

    const base = {
      provider: this.name,
      model: response.model ?? request.model,
      usage,
      costUsd: estimateCostUsd(response.model ?? request.model, usage),
      latencyMs: Date.now() - started,
      stopReason: response.stop_reason ?? null,
    };

    // See (3). Check before touching content.
    if (response.stop_reason === 'refusal') {
      return {
        ...base,
        text: '',
        truncated: false,
        refusal: {
          category: response.stop_details?.category ?? null,
          explanation: response.stop_details?.explanation ?? null,
        },
      };
    }

    // Thinking blocks precede text blocks; concatenating only `text` blocks keeps
    // reasoning out of anything we might send to a customer.
    const text = response.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    return {
      ...base,
      text,
      json: request.jsonSchema ? parseJson(text, this.name) : undefined,
      // Thinking shares the max_tokens budget, so truncation here usually means
      // the caller under-sized maxOutputTokens rather than that the model rambled.
      truncated: response.stop_reason === 'max_tokens',
    };
  }
}

function parseJson(text: string, provider: 'anthropic'): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ProviderError(
      provider,
      'Structured output was requested but the response was not valid JSON',
      { retryable: true, cause },
    );
  }
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof Anthropic.APIError) {
    return new ProviderError('anthropic', error.message, {
      status: error.status,
      cause: error,
    });
  }
  if (error instanceof Error) {
    return new ProviderError('anthropic', error.message, { cause: error });
  }
  return new ProviderError('anthropic', String(error));
}
