import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { setProviderForTests } from '../ai/index.ts';
import { setAdminClientForTests } from '../supabase/admin.ts';
import { FAKE_TO_NUMBER, FakeSupabase } from '../testing/fake-supabase.ts';
import { FakeProvider } from '../testing/fake-provider.ts';
import { replyToCaller, type VoiceTurnInput } from './voice.ts';

/**
 * A whole voice turn with a fake database and a fake model. The point of this file is
 * that the seams exist; later tickets build their timing and ordering tests on them.
 */
describe('replyToCaller (fake database, fake model)', () => {
  let db: FakeSupabase;
  let model: FakeProvider;

  beforeEach(() => {
    db = new FakeSupabase();
    model = new FakeProvider({ text: 'Yes, we cover Rayleigh.' });
    setAdminClientForTests(db.asClient());
    setProviderForTests('google', model);
  });

  afterEach(async () => {
    // The turn defers lead extraction until after the reply; let it finish against the
    // fakes before they are taken away, or it would reach for the real client.
    await new Promise((resolve) => setTimeout(resolve, 20));
    setAdminClientForTests(null);
    setProviderForTests('google', null);
  });

  it('answers from the model and records both halves of the turn', async () => {
    const result = await replyToCaller({
      callSid: 'CA1',
      toNumber: FAKE_TO_NUMBER,
      fromNumber: '+447700900123',
      heard: 'Do you cover Rayleigh?',
      turn: 1,
    });

    assert.equal(result.speak, 'Yes, we cover Rayleigh.');
    assert.equal(result.endCall, false);

    const appends = db.callsTo('rpc:append_message');
    const directions = appends.map((c) => c.args?.p_direction);
    assert.deepEqual(directions.slice(0, 2), ['inbound', 'outbound']);
    assert.equal(appends[1]!.args?.p_body, 'Yes, we cover Rayleigh.');
    assert.ok(model.requests.length >= 1);
  });
});

/**
 * The one timings line per turn. Read from the real logger output (a JSON line on stdout)
 * rather than a spy on `logger`, so the test also covers redaction and serialisation.
 */
describe('replyToCaller timings line', () => {
  const FROM = '+447700900123';
  const HEARD = 'Do you cover Rayleigh?';
  const REPLY = 'Yes, we cover Rayleigh and the surrounding villages.';
  const STAGES_ON_A_MODEL_TURN = [
    'resolve_inbound',
    'append_inbound',
    'load_context_memory',
    'prompt_build',
    'gemini_first_token',
    'gemini_last_token',
    'record_ai_log',
    'record_assistant_turn',
    'total',
  ];

  let db: FakeSupabase;
  let model: FakeProvider;
  let lines: string[];

  beforeEach(() => {
    db = new FakeSupabase();
    model = new FakeProvider({
      text: REPLY,
      usage: { promptTokens: 1200, completionTokens: 40, cachedTokens: 0, visibleTokens: 15, thinkingTokens: 25 },
      timing: { firstTokenMs: 310, lastTokenMs: 420 },
    });
    setAdminClientForTests(db.asClient());
    setProviderForTests('google', model);
    lines = [];
    mock.method(console, 'log', (line: unknown) => {
      lines.push(String(line));
    });
  });

  afterEach(async () => {
    mock.restoreAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
    setAdminClientForTests(null);
    setProviderForTests('google', null);
  });

  const turn = (overrides: Partial<VoiceTurnInput> = {}): VoiceTurnInput => ({
    callSid: 'CA1234567890abcdef',
    toNumber: FAKE_TO_NUMBER,
    fromNumber: FROM,
    heard: HEARD,
    turn: 1,
    ...overrides,
  });

  function timingsLines(): Array<Record<string, any>> {
    return lines
      .map((l) => JSON.parse(l) as Record<string, any>)
      .filter((l) => l.message === 'Voice turn timings');
  }

  it('writes one line for a model turn with every stage, the tokens and kind model', async () => {
    await replyToCaller(turn());

    const found = timingsLines();
    assert.equal(found.length, 1);
    const line = found[0]!;
    assert.equal(line.kind, 'model');
    for (const stage of STAGES_ON_A_MODEL_TURN) {
      const ms = line.stages[stage];
      assert.ok(typeof ms === 'number' && Number.isFinite(ms) && ms >= 0, `${stage} is a finite number`);
    }
    assert.equal(line.stages.gemini_first_token, 310);
    assert.equal(line.stages.gemini_last_token, 420);
    assert.equal(line.tokens.prompt, 1200);
    assert.equal(line.tokens.visible, 15);
    assert.equal(line.tokens.thinking, 25);
    // Did not run on this turn, so absent rather than zero.
    assert.equal('confusion_update' in line.stages, false);
    assert.equal('callback_lookup' in line.stages, false);
    // The ids survive redaction unchanged.
    assert.equal(line.callSid, 'CA1234567890abcdef');
    assert.equal(line.turn, 1);
    assert.match(line.traceId, /^atw_/);
  });

  it('holds no caller words, reply text or phone number', async () => {
    await replyToCaller(turn());

    const raw = lines.find((l) => l.includes('Voice turn timings'))!;
    assert.ok(!raw.includes(HEARD));
    assert.ok(!raw.includes('Rayleigh'));
    assert.ok(!raw.includes(REPLY));
    assert.ok(!raw.includes(FROM));
    assert.ok(!raw.includes('4477009'));
  });

  it('marks a canned goodbye as canned, with no Gemini stages', async () => {
    const result = await replyToCaller(
      turn({ heard: 'No thanks, that is all', anythingElseAsked: true, anythingElseJustAsked: true }),
    );

    assert.equal(result.endCall, true);
    const found = timingsLines();
    assert.equal(found.length, 1);
    const line = found[0]!;
    assert.equal(line.kind, 'canned');
    assert.equal('gemini_first_token' in line.stages, false);
    assert.equal('gemini_last_token' in line.stages, false);
    assert.equal('prompt_build' in line.stages, false);
    // The reply was not asked of the model (deferred extraction may still call it).
    assert.ok(model.requests.every((r) => r.stream !== true));
    assert.ok(typeof line.stages.total === 'number');
  });

  it('marks a repeated turn as duplicate', async () => {
    await replyToCaller(turn());
    lines.length = 0;
    await replyToCaller(turn());

    const found = timingsLines();
    assert.equal(found.length, 1);
    assert.equal(found[0]!.kind, 'duplicate');
    assert.equal('prompt_build' in found[0]!.stages, false);
  });
});
