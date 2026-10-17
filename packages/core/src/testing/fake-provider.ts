import {
  ProviderError,
  type AiProvider,
  type GenerateRequest,
  type GenerateResult,
  type ProviderName,
} from '../ai/provider.ts';

/**
 * A scripted `AiProvider` for tests. Install it with `setProviderForTests` from
 * `ai/index.ts`; nothing here touches an SDK, a key or the network.
 *
 * Each call to `generate` consumes the next script entry (the last entry repeats once the
 * script runs out, so a single entry serves a test that makes any number of calls). An
 * entry is either a result, given as overrides on a plain "ok" result, or a
 * `ProviderError` to throw. Every request is recorded, in order, for the test to inspect.
 *
 * Leave room for streaming: T13 adds a streaming variant next to `generate`, and the
 * script and the request log are shared, so a streamed turn reads the same entries.
 */
export type ScriptedReply = Partial<GenerateResult> | ProviderError;

export class FakeProvider implements AiProvider {
  readonly name: ProviderName;
  /** Every request received, oldest first. */
  readonly requests: GenerateRequest[] = [];
  private readonly script: ScriptedReply[];
  private next = 0;

  constructor(script: ScriptedReply | ScriptedReply[], name: ProviderName = 'google') {
    this.name = name;
    this.script = Array.isArray(script) ? script : [script];
    if (this.script.length === 0) throw new Error('FakeProvider needs at least one scripted reply');
  }

  /** The next scripted entry; the last one repeats. */
  protected take(request: GenerateRequest): ScriptedReply {
    this.requests.push(request);
    const entry = this.script[Math.min(this.next, this.script.length - 1)]!;
    this.next += 1;
    return entry;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const entry = this.take(request);
    if (entry instanceof ProviderError) throw entry;
    return fakeResult(this.name, request, entry);
  }
}

/** A plain successful result, with anything the test cares about overridden. */
export function fakeResult(
  provider: ProviderName,
  request: GenerateRequest,
  overrides: Partial<GenerateResult> = {},
): GenerateResult {
  return {
    provider,
    model: request.model,
    text: '',
    usage: { promptTokens: 100, completionTokens: 20, cachedTokens: 0 },
    costUsd: null,
    latencyMs: 1,
    stopReason: 'stop',
    truncated: false,
    ...overrides,
  };
}
