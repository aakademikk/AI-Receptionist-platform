import { serverEnv } from '../env.ts';
import { AnthropicProvider } from './anthropic.ts';
import { GoogleProvider } from './google.ts';
import { OpenAiProvider, toStrictSchema } from './openai.ts';
import {
  ProviderError,
  type AiProvider,
  type GenerateRequest,
  type GenerateResult,
  type JsonSchema,
  type ProviderName,
} from './provider.ts';

export * from './provider.ts';
export { AnthropicProvider } from './anthropic.ts';
export { OpenAiProvider, toStrictSchema } from './openai.ts';
export { GoogleProvider } from './google.ts';

/**
 * Provider registry.
 *
 * Clients are cached per provider because each SDK holds a connection pool, and
 * building a fresh one per request measurably increases latency on a warm Lambda.
 * The cache is keyed only by provider name — API keys are platform-level, so there
 * is no cross-tenant leak here. (Were we to support tenant-supplied keys, this
 * cache would need to be keyed by key fingerprint too.)
 */
const clients = new Map<ProviderName, AiProvider>();

export function getProvider(name: ProviderName): AiProvider {
  const cached = clients.get(name);
  if (cached) return cached;

  let provider: AiProvider;
  switch (name) {
    case 'anthropic': {
      const key = serverEnv.anthropicApiKey;
      if (!key) throw new ProviderError(name, 'ANTHROPIC_API_KEY is not configured', { retryable: false });
      provider = new AnthropicProvider(key);
      break;
    }
    case 'openai': {
      const key = serverEnv.openaiApiKey;
      if (!key) throw new ProviderError(name, 'OPENAI_API_KEY is not configured', { retryable: false });
      provider = new OpenAiProvider(key);
      break;
    }
    case 'google': {
      const key = serverEnv.googleApiKey;
      if (!key) throw new ProviderError(name, 'GOOGLE_API_KEY is not configured', { retryable: false });
      provider = new GoogleProvider(key);
      break;
    }
    default: {
      // Exhaustiveness: adding a provider to the union without handling it here
      // becomes a compile error rather than a runtime surprise.
      const exhaustive: never = name;
      throw new ProviderError('anthropic', `Unknown provider ${String(exhaustive)}`, {
        retryable: false,
      });
    }
  }

  clients.set(name, provider);
  return provider;
}

/**
 * Generate with a provider, normalising the schema for whichever one is selected.
 *
 * OpenAI's strict mode has schema requirements the other two don't, so the schema
 * is adapted at the call boundary. Keeping that here means the prompt modules
 * declare one schema and stay provider-agnostic.
 */
export async function generate(
  providerName: ProviderName,
  request: Omit<GenerateRequest, 'jsonSchema'> & {
    jsonSchema?: { name: string; schema: JsonSchema };
  },
): Promise<GenerateResult> {
  const provider = getProvider(providerName);

  const jsonSchema = request.jsonSchema
    ? {
        name: request.jsonSchema.name,
        schema:
          providerName === 'openai'
            ? toStrictSchema(request.jsonSchema.schema)
            : request.jsonSchema.schema,
      }
    : undefined;

  return provider.generate({ ...request, jsonSchema });
}

/**
 * Generate with one retry on a retryable fault.
 *
 * Deliberately shallow: the SDKs already retry transport errors internally, and an
 * SMS reply that arrives 90 seconds late is worse than one that never arrives —
 * the workflow's error branch escalates to a human instead. A refusal is not a
 * fault and is never retried.
 */
export async function generateWithRetry(
  providerName: ProviderName,
  request: Parameters<typeof generate>[1],
): Promise<GenerateResult> {
  try {
    return await generate(providerName, request);
  } catch (error) {
    if (error instanceof ProviderError && error.retryable) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      return generate(providerName, request);
    }
    throw error;
  }
}
