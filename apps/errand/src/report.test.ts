import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { renderOutcome, reportOnce } from './report.ts';
import type { Outcome } from './store.ts';
import { newErrand, readEvents, readOutcome, writeOutcome } from './store.ts';
import { COLIN_MOBILE, sampleBrief, tempDir } from './testing/fixtures.ts';

const brief = sampleBrief();
const at = '2026-10-27T14:20:00.000Z';
const o = (outcome: Omit<Outcome, 'source' | 'at'>): Outcome => ({ ...outcome, source: 'session', at });

describe('renderOutcome (must-do 16)', () => {
  it('booked: date, time, name booked under and the reference', () => {
    const { title, body } = renderOutcome(o({ kind: 'booked', date: '2026-10-28', agreedTime: '19:30', nameBookedUnder: 'Colin Wood', reference: 'LU42' }), brief);
    assert.equal(title, "Errand: Luigi's: booked");
    assert.equal(body, 'Booked for Wed 28 Oct at 19:30, under Colin Wood. Reference LU42.');
  });

  it('not booked: why, and the times offered', () => {
    const { title, body } = renderOutcome(o({ kind: 'not_booked', reason: 'only times outside the window were offered', offeredTimes: ['17:30', '21:30'] }), brief);
    assert.equal(title, "Errand: Luigi's: not booked");
    assert.equal(body, 'Not booked: only times outside the window were offered. Times offered: 17:30, 21:30.');
  });

  it('voicemail left', () => {
    assert.equal(renderOutcome(o({ kind: 'voicemail_left' }), brief).body, `Voicemail left, asking them to call Colin back on ${COLIN_MOBILE}.`);
  });

  it('not reached: no answer, busy, failed', () => {
    for (const reason of ['no answer', 'busy', 'call failed', 'failed to place']) {
      const { title, body } = renderOutcome(o({ kind: 'not_reached', reason }), brief);
      assert.equal(title, "Errand: Luigi's: not reached");
      assert.equal(body, `Not reached: ${reason}.`);
    }
  });

  it('ended early: each limit', () => {
    for (const limit of ['payment asked', 'confused', 'turn cap', 'maximum length'] as const) {
      assert.equal(renderOutcome(o({ kind: 'ended_early', limit }), brief).body, `Ended early: ${limit}.`);
    }
  });

  it('failed, with the errand id appended when given', () => {
    assert.equal(renderOutcome(o({ kind: 'failed', reason: 'model timed out or failed' }), brief, 'x').body, 'Failed: model timed out or failed.\nErrand x');
  });
});

describe('reportOnce', () => {
  let home: string;
  let cleanup: () => void;
  let id: string;
  beforeEach(() => {
    ({ dir: home, cleanup } = tempDir());
    id = newErrand(brief, new Date('2026-10-27T14:12:00Z'), home).id;
  });
  afterEach(() => cleanup());

  it('sends nothing without an outcome', async () => {
    const sent: string[][] = [];
    assert.equal(await reportOnce(id, { home, notify: async (args) => (sent.push(args), 0) }), false);
    assert.equal(sent.length, 0);
  });

  it('sends exactly once with title, body and --full', async () => {
    writeOutcome(id, o({ kind: 'voicemail_left' }), home);
    const sent: string[][] = [];
    const notify = async (args: string[]) => (sent.push(args), 0);
    assert.equal(await reportOnce(id, { home, notify }), true);
    assert.equal(await reportOnce(id, { home, notify }), false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]![0], "Errand: Luigi's: voicemail left");
    assert.equal(sent[0]![2], '--full');
  });

  it('records a notifier failure and keeps the outcome on disk', async () => {
    writeOutcome(id, o({ kind: 'failed', reason: 'x' }), home);
    await reportOnce(id, { home, notify: async () => 4 });
    assert.equal(readEvents(id, home).find((event) => event.kind === 'reported')?.notifyExit, 4);
    assert.ok(readOutcome(id, home));
    await reportOnce(id, { home, notify: async () => { throw new Error('spawn ENOENT'); } });
    assert.equal(readEvents(id, home).filter((event) => event.kind === 'reported').length, 1);
  });
});
