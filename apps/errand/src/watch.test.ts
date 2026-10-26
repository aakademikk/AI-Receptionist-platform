import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { appendEvent, newErrand, readAlert, readEvents, writeOutcome } from './store.ts';
import { sampleBrief, tempDir } from './testing/fixtures.ts';
import { watch } from './watch.ts';

const DIALLED = new Date('2026-10-27T14:13:00Z');
const after = (ms: number): Date => new Date(DIALLED.getTime() + ms);
const MIN = 60_000;

let home: string;
let cleanup: () => void;
let id: string;
let sent: string[][];
const notify = async (args: string[]) => (sent.push(args), 0);

beforeEach(() => {
  ({ dir: home, cleanup } = tempDir());
  id = newErrand(sampleBrief(), new Date('2026-10-27T14:12:00Z'), home).id;
  appendEvent(id, { kind: 'dialled', callSid: 'CA01...cdef' }, DIALLED, home);
  sent = [];
});
afterEach(() => cleanup());

describe('watch (Done-means 15, fake clock)', () => {
  it('19 minutes 59 seconds: no alert', async () => {
    assert.equal(await watch(id, after(19 * MIN + 59_000), { home, notify }), 'too early');
    assert.equal(sent.length, 0);
    assert.equal(readAlert(id, home), null);
  });

  it('20 minutes: one alert naming the errand and its dial time; a second run sends no second alert', async () => {
    assert.equal(await watch(id, after(20 * MIN), { home, notify }), 'alerted');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]![1], `Errand ${id} dialled at 14:13 has no outcome after 20 minutes`);
    assert.equal(readEvents(id, home).at(-1)?.kind, 'alert_sent');
    assert.equal(await watch(id, after(25 * MIN), { home, notify }), 'already alerted');
    assert.equal(sent.length, 1);
  });

  it('an outcome present: no alert', async () => {
    writeOutcome(id, { kind: 'not_reached', reason: 'no answer', source: 'status', at: after(MIN).toISOString() }, home);
    assert.equal(await watch(id, after(20 * MIN), { home, notify }), 'outcome present');
    assert.equal(sent.length, 0);
  });

  it('an errand never dialled: no alert', async () => {
    const other = newErrand(sampleBrief({ business: 'Other' }), new Date('2026-10-27T14:12:00Z'), home).id;
    assert.equal(await watch(other, after(60 * MIN), { home, notify }), 'not dialled');
    assert.equal(sent.length, 0);
  });
});
