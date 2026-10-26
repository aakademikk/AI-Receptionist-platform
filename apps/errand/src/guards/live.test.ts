import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { MAX_CALL_S } from '../config.ts';
import { appendEvent, newErrand, writeOutcome } from '../store.ts';
import { sampleBrief, tempDir } from '../testing/fixtures.ts';
import { checkNoLiveErrand } from './live.ts';

const T0 = new Date('2026-10-27T14:12:00Z');
const after = (ms: number): Date => new Date(T0.getTime() + ms);

let home: string;
let cleanup: () => void;
beforeEach(() => ({ dir: home, cleanup } = tempDir()));
afterEach(() => cleanup());

describe('checkNoLiveErrand', () => {
  it('passes with no errands, and with errands never dialled', () => {
    assert.deepEqual(checkNoLiveErrand(T0, { home }), { ok: true });
    newErrand(sampleBrief(), T0, home);
    assert.deepEqual(checkNoLiveErrand(T0, { home }), { ok: true });
  });

  it('refuses a second errand while one is live, naming it (Done-means 5)', () => {
    const first = newErrand(sampleBrief(), T0, home).id;
    appendEvent(first, { kind: 'dialled', callSid: 'CA12...cdef' }, T0, home);
    newErrand(sampleBrief({ business: 'Second' }), after(60_000), home);
    assert.deepEqual(checkNoLiveErrand(after(60_000), { home }), { ok: false, reason: `errand ${first} is live` });
  });

  it('passes once the live errand has an outcome', () => {
    const first = newErrand(sampleBrief(), T0, home).id;
    appendEvent(first, { kind: 'dialled' }, T0, home);
    writeOutcome(first, { kind: 'not_reached', reason: 'no answer', source: 'status', at: after(40_000).toISOString() }, home);
    assert.deepEqual(checkNoLiveErrand(after(60_000), { home }), { ok: true });
  });

  it('stops counting an errand dialled more than the maximum length plus 5 minutes ago', () => {
    const first = newErrand(sampleBrief(), T0, home).id;
    appendEvent(first, { kind: 'dialled' }, T0, home);
    const limit = MAX_CALL_S * 1000 + 5 * 60_000;
    assert.equal(checkNoLiveErrand(after(limit - 1), { home }).ok, false);
    assert.deepEqual(checkNoLiveErrand(after(limit), { home }), { ok: true });
  });
});
