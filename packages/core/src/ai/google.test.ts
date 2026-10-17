import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GenerateContentResponse } from '@google/genai';

import { GoogleProvider } from './google.ts';
import type { GenerateRequest } from './provider.ts';

/**
 * The streamed path must hand back exactly what the whole-response path does. Each
 * fixture is given to a fake `models` object once as one `generateContent` response and
 * again split into 1, 2 and 5 stream chunks, with the finish reason and usage on the
 * final chunk only (as the live API sends them).
 */
interface Fixture {
  name: string;
  /** Pieces of visible text, in order. */
  pieces: string[];
  finishReason: string;
  finishMessage?: string;
  usage: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    thoughtsTokenCount: number;
    cachedContentTokenCount: number;
  };
}

const USAGE = {
  promptTokenCount: 1200,
  candidatesTokenCount: 18,
  thoughtsTokenCount: 40,
  cachedContentTokenCount: 800,
};

const FIXTURES: Fixture[] = [
  {
    name: 'STOP with text',
    pieces: ['Yes, we cover Rayleigh. ', 'Would you like a callback ', 'tomorrow morning?  '],
    finishReason: 'STOP',
    usage: USAGE,
  },
  {
    name: 'SAFETY',
    pieces: [],
    finishReason: 'SAFETY',
    finishMessage: 'Blocked for safety.',
    usage: { ...USAGE, candidatesTokenCount: 0, thoughtsTokenCount: 0 },
  },
  {
    name: 'PROHIBITED_CONTENT',
    pieces: [],
    finishReason: 'PROHIBITED_CONTENT',
    finishMessage: 'Prohibited content.',
    usage: { ...USAGE, candidatesTokenCount: 0 },
  },
  {
    name: 'MAX_TOKENS with partial text',
    pieces: ['We can come out on ', 'Tuesday or', ' Wed'],
    finishReason: 'MAX_TOKENS',
    usage: { ...USAGE, candidatesTokenCount: 600, thoughtsTokenCount: 512 },
  },
  {
    name: 'empty output',
    pieces: [],
    finishReason: 'STOP',
    usage: { ...USAGE, candidatesTokenCount: 0, thoughtsTokenCount: 0 },
  },
];

function candidate(reason?: string, message?: string) {
  return reason ? { finishReason: reason, finishMessage: message } : {};
}

/** A response object shaped like the SDK's, with the `text` getter flattened to a value. */
function response(text: string, f?: Fixture): GenerateContentResponse {
  return {
    text,
    candidates: [candidate(f?.finishReason, f?.finishMessage)],
    usageMetadata: f?.usage,
  } as unknown as GenerateContentResponse;
}

/** Split the pieces into `n` chunks (the last one empty-text if there is nothing to split). */
function chunksOf(f: Fixture, n: number): GenerateContentResponse[] {
  const full = f.pieces.join('');
  const size = Math.ceil(full.length / n) || 1;
  const chunks: GenerateContentResponse[] = [];
  for (let i = 0; i < n; i += 1) {
    const text = full.slice(i * size, (i + 1) * size);
    chunks.push(i === n - 1 ? response(text, f) : response(text));
  }
  return chunks;
}

class FakeModels {
  streamCalls = 0;
  wholeCalls = 0;
  lastParams: unknown;

  private readonly whole: GenerateContentResponse;
  private readonly chunks: GenerateContentResponse[];

  constructor(whole: GenerateContentResponse, chunks: GenerateContentResponse[]) {
    this.whole = whole;
    this.chunks = chunks;
  }

  async generateContent(params: unknown) {
    this.wholeCalls += 1;
    this.lastParams = params;
    return this.whole;
  }

  async generateContentStream(params: unknown) {
    this.streamCalls += 1;
    this.lastParams = params;
    const chunks = this.chunks;
    return (async function* () {
      for (const chunk of chunks) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        yield chunk;
      }
    })();
  }
}

const REQUEST: GenerateRequest = {
  system: 'You are Amy.',
  messages: [{ role: 'user', content: 'Do you cover Rayleigh?' }],
  model: 'gemini-3.8-flash',
  maxOutputTokens: 200,
  effort: 'low',
};

function provider(models: FakeModels) {
  return new GoogleProvider('test-key', models as never);
}

describe('GoogleProvider streaming', () => {
  for (const fixture of FIXTURES) {
    for (const n of [1, 2, 5]) {
      it(`${fixture.name}: ${n} chunk(s) equals the whole response`, async () => {
        const whole = response(fixture.pieces.join(''), fixture);
        const wholeResult = await provider(new FakeModels(whole, [])).generate(REQUEST);

        const models = new FakeModels(whole, chunksOf(fixture, n));
        const streamed = await provider(models).generate({ ...REQUEST, stream: true });

        assert.equal(models.streamCalls, 1);
        assert.equal(models.wholeCalls, 0);
        assert.equal(streamed.text, wholeResult.text);
        assert.equal(streamed.stopReason, wholeResult.stopReason);
        assert.equal(streamed.truncated, wholeResult.truncated);
        assert.deepEqual(streamed.refusal, wholeResult.refusal);
        assert.equal(streamed.usage.promptTokens, wholeResult.usage.promptTokens);
        assert.equal(streamed.usage.completionTokens, wholeResult.usage.completionTokens);
        assert.equal(streamed.usage.cachedTokens, wholeResult.usage.cachedTokens);
        assert.equal(streamed.usage.visibleTokens, wholeResult.usage.visibleTokens);
        assert.equal(streamed.usage.thinkingTokens, wholeResult.usage.thinkingTokens);
        assert.equal(streamed.costUsd, wholeResult.costUsd);

        assert.equal(wholeResult.timing, undefined);
        assert.ok(streamed.timing);
        assert.ok(streamed.timing.lastTokenMs >= 0);
        if (streamed.timing.firstTokenMs !== null) {
          assert.ok(streamed.timing.firstTokenMs <= streamed.timing.lastTokenMs);
        }
        const hasText = fixture.pieces.join('') !== '';
        assert.equal(streamed.timing.firstTokenMs === null, !hasText);
      });
    }
  }

  it('folds thinking into completion tokens and splits them out', async () => {
    const whole = response('Hello.', FIXTURES[0]!);
    const result = await provider(new FakeModels(whole, [])).generate(REQUEST);
    assert.equal(result.usage.completionTokens, 58);
    assert.equal(result.usage.visibleTokens, 18);
    assert.equal(result.usage.thinkingTokens, 40);
  });

  it('never streams a jsonSchema request', async () => {
    const whole = response('{"a":1}', { ...FIXTURES[0]!, pieces: ['{"a":1}'] });
    const models = new FakeModels(whole, chunksOf(FIXTURES[0]!, 2));
    const result = await provider(models).generate({
      ...REQUEST,
      stream: true,
      jsonSchema: { name: 'x', schema: { type: 'object' } },
    });
    assert.equal(models.streamCalls, 0);
    assert.equal(models.wholeCalls, 1);
    assert.deepEqual(result.json, { a: 1 });
    assert.equal(result.timing, undefined);
  });

  it('does not stream unless asked', async () => {
    const whole = response('Hi.', FIXTURES[0]!);
    const models = new FakeModels(whole, chunksOf(FIXTURES[0]!, 2));
    await provider(models).generate(REQUEST);
    assert.equal(models.streamCalls, 0);
  });
});
