import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { OPENING_LINE, TURN_CAP } from './config.ts';
import { FAILED_LINE, type ModelFn, PAYMENT_LINE, googleModel, newTurnState, nextTurn } from './turn.ts';
import { sampleBrief } from './testing/fixtures.ts';

/** A fake model that replays decisions in order (the last one repeats) and counts its calls. */
function scripted(...decisions: unknown[]): ModelFn & { calls: number } {
  const fn: ModelFn & { calls: number } = Object.assign(
    async () => {
      const decision = decisions[Math.min(fn.calls, decisions.length - 1)];
      fn.calls += 1;
      return decision;
    },
    { calls: 0 },
  );
  return fn;
}

describe('nextTurn: disclosure (must-do 8)', () => {
  it("prefixes the opening line to Amy's first spoken line when the model leaves it out", async () => {
    const state = newTurnState(sampleBrief());
    const result = await nextTurn(state, "Hello, Luigi's.", { model: scripted({ say: "I'd like to book a table for two on Wednesday." }) });
    assert.ok(result.say.startsWith(OPENING_LINE), result.say);
    assert.equal(result.end, undefined);
  });

  it('does not double the opening line, and only the first line carries it', async () => {
    const state = newTurnState(sampleBrief());
    const model = scripted({ say: `${OPENING_LINE} I'd like to book a table.` }, { say: 'Half seven, please.' });
    const first = await nextTurn(state, "Hello, Luigi's.", { model });
    assert.equal(first.say.split(OPENING_LINE).length - 1, 1);
    const second = await nextTurn(state, 'What time?', { model });
    assert.equal(second.say, 'Half seven, please.');
  });

  it('answers "are you a real person?" with "automated assistant"', async () => {
    const state = newTurnState(sampleBrief());
    state.spoken = true;
    const result = await nextTurn(state, 'Sorry, are you a real person?', { model: scripted({ say: "No, but I can book the table for Colin." }) });
    assert.match(result.say, /automated assistant/);
  });
});

describe('nextTurn: the window (must-do 9)', () => {
  it('an outside time then an inside time ends "booked" with the inside time', async () => {
    const state = newTurnState(sampleBrief());
    state.spoken = true;
    const model = scripted(
      { say: 'Six works for us.', agreedTime: '18:00', offeredTimes: ['18:00'] },
      { say: 'Lovely, half seven it is. Thank you, goodbye.', agreedTime: '19:30', done: 'booked', nameBookedUnder: 'Colin Wood', reference: 'LU42' },
    );
    const first = await nextTurn(state, 'We can do six?', { model });
    assert.equal(first.end, undefined);
    assert.match(first.say, /18:00 doesn't work for Colin/);
    assert.deepEqual(first.guarded, ['window']);
    const second = await nextTurn(state, 'Or half seven?', { model });
    assert.deepEqual(second.end, { kind: 'booked', agreedTime: '19:30', date: '2026-10-28', nameBookedUnder: 'Colin Wood', reference: 'LU42' });
    assert.deepEqual(state.offeredTimes, ['18:00']);
  });

  it('only outside times offered: "not booked" with the offered times, no second goal tried', async () => {
    const state = newTurnState(sampleBrief());
    state.spoken = true;
    const model = scripted({ say: "Thank you, I'll let Colin know. Goodbye.", offeredTimes: ['17:30', '21:30'], done: 'not_booked' });
    const result = await nextTurn(state, 'We only have half five or half nine.', { model });
    assert.deepEqual(result.end, { kind: 'not_booked', reason: 'only times outside the window were offered', offeredTimes: ['17:30', '21:30'] });
  });

  it('a "booked" with no agreed time inside the window does not end the call as booked', async () => {
    const state = newTurnState(sampleBrief());
    state.spoken = true;
    const result = await nextTurn(state, 'Booked at six.', { model: scripted({ say: 'Thanks!', agreedTime: '18:00', done: 'booked' }) });
    assert.equal(result.end, undefined);
  });
});

describe('nextTurn: limits (must-do 12)', () => {
  it(`the ${TURN_CAP}th turn ends "turn cap"`, async () => {
    const state = newTurnState(sampleBrief());
    const model = scripted({ say: 'Could you say that again?' });
    for (let turn = 1; turn < TURN_CAP; turn += 1) {
      assert.equal((await nextTurn(state, `line ${turn}`, { model })).end, undefined, `turn ${turn}`);
    }
    const last = await nextTurn(state, 'line 20', { model });
    assert.deepEqual(last.end, { kind: 'ended_early', limit: 'turn cap', offeredTimes: [] });
  });

  it('two cannotPlace turns in a row end "confused"; one between clear turns does not', async () => {
    const state = newTurnState(sampleBrief());
    const model = scripted({ say: 'Sorry?', cannotPlace: true }, { say: 'Thanks.' }, { say: 'Sorry?', cannotPlace: true }, { say: 'Sorry?', cannotPlace: true });
    assert.equal((await nextTurn(state, 'mumble', { model })).end, undefined);
    assert.equal((await nextTurn(state, 'clear', { model })).end, undefined);
    assert.equal((await nextTurn(state, 'mumble', { model })).end, undefined);
    assert.deepEqual((await nextTurn(state, 'mumble', { model })).end, { kind: 'ended_early', limit: 'confused', offeredTimes: [] });
  });

  it('a model that takes 9 seconds ends "failed" with the fixed line at 8 seconds', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const state = newTurnState(sampleBrief());
      state.spoken = true;
      const slow: ModelFn = () => new Promise((resolve) => setTimeout(() => resolve({ say: 'too late' }), 9000));
      const pending = nextTurn(state, 'Hello?', { model: slow });
      mock.timers.tick(8000);
      const result = await pending;
      assert.equal(result.say, FAILED_LINE);
      assert.deepEqual(result.end, { kind: 'failed', reason: 'model timed out or failed' });
    } finally {
      mock.timers.reset();
    }
  });

  it('a model error or a malformed reply ends "failed"', async () => {
    for (const model of [(async () => { throw new Error('503'); }) as ModelFn, scripted({ words: 'no say field' })]) {
      const state = newTurnState(sampleBrief());
      assert.equal((await nextTurn(state, 'Hello?', { model })).end?.kind, 'failed');
    }
  });
});

describe('nextTurn: payment and guardrails (must-dos 11, 15)', () => {
  it('a payment ask ends the call before the model is called', async () => {
    const state = newTurnState(sampleBrief());
    state.spoken = true;
    const model = scripted({ say: 'Sure, it is 4929...' });
    const result = await nextTurn(state, 'Can I take a card number to hold it?', { model });
    assert.equal(model.calls, 0);
    assert.equal(result.say, PAYMENT_LINE);
    assert.deepEqual(result.end, { kind: 'ended_early', limit: 'payment asked', reason: 'asked for card' });
  });

  it('replaces a line giving the robot number or agreeing an extra', async () => {
    const state = newTurnState(sampleBrief());
    state.spoken = true;
    const robot = await nextTurn(state, 'A callback number?', { model: scripted({ say: 'Yes, +447861926390.' }) });
    assert.equal(robot.say, 'Colin will give that to you directly.');
    const extra = await nextTurn(state, 'Want to join our membership?', { model: scripted({ say: 'Sure, sign him up for the membership.' }) });
    assert.equal(extra.say, 'I can only book the table today, thank you.');
  });
});

describe('nextTurn: menus (must-do 13)', () => {
  it('digits "1w#" become "1#", the rest is reported, and the turn counts towards the cap', async () => {
    const state = newTurnState(sampleBrief());
    const result = await nextTurn(state, 'Press 1 for bookings.', { model: scripted({ say: '', digits: '1w#' }) });
    assert.equal(result.digits, '1#');
    assert.equal(result.droppedDigits, 'w');
    assert.equal(result.say, '');
    assert.equal(state.turns, 1);
    assert.equal(state.spoken, false, 'a keys-only turn is not Amy speaking');
  });
});

describe('googleModel', () => {
  it("asks Amy's Gemini flash at low effort for the structured decision, with the 8-second limit", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const provider = {
      generate: async (request: Record<string, unknown>) => {
        requests.push(request);
        return { json: { say: 'hi' }, truncated: false } as never;
      },
    };
    const model = googleModel('test-key', provider as never);
    assert.deepEqual(await model({ system: 's', messages: [{ role: 'user', content: 'hello' }] }), { say: 'hi' });
    assert.equal(requests[0]!.model, 'gemini-3.8-flash');
    assert.equal(requests[0]!.effort, 'low');
    assert.equal(requests[0]!.timeoutMs, 8000);
    assert.equal((requests[0]!.jsonSchema as { name: string }).name, 'errand_turn');
  });
});
