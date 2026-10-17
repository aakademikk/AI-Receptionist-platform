import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTurnTimer, timed } from './turn-timings.ts';

/** A clock that advances by the given steps, one per reading. */
function clock(...readings: number[]): () => number {
  let i = 0;
  return () => readings[Math.min(i++, readings.length - 1)]!;
}

describe('createTurnTimer', () => {
  it('records the elapsed time of a stage and returns what it produced', async () => {
    const timer = createTurnTimer(clock(10, 35));
    const value = await timer.time('resolve_inbound', async () => 'ok');
    assert.equal(value, 'ok');
    assert.deepEqual(timer.snapshot().stages, { resolve_inbound: 25 });
  });

  it('records the time even when the stage throws, and rethrows', async () => {
    const timer = createTurnTimer(clock(0, 7));
    await assert.rejects(
      timer.time('append_inbound', async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(timer.snapshot().stages.append_inbound, 7);
  });

  it('keeps stages that did not run out of the snapshot, and holds set values and notes', () => {
    const timer = createTurnTimer();
    timer.set('gemini_first_token', 300);
    timer.note('kind', 'model');
    timer.note('prompt_tokens', 900);
    timer.note('thinking_tokens', null);
    const snap = timer.snapshot();
    assert.deepEqual(snap.stages, { gemini_first_token: 300 });
    assert.deepEqual(snap.notes, { kind: 'model', prompt_tokens: 900, thinking_tokens: null });
  });

  it('timed() runs the function with no timer', async () => {
    assert.equal(await timed(undefined, 'total', () => 5), 5);
  });
});
