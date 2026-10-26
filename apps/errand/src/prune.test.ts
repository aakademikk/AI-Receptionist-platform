import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { describePrune, prune } from './prune.ts';
import { appendEvent, listErrands, newErrand, writeOutcome } from './store.ts';
import { sampleBrief, tempDir } from './testing/fixtures.ts';

const NOW = new Date('2026-10-27T04:40:00Z');
const daysAgo = (days: number): Date => new Date(Date.UTC(2026, 9, 27 - days, 12, 0));

let home: string;
let cleanup: () => void;
beforeEach(() => ({ dir: home, cleanup } = tempDir()));
afterEach(() => cleanup());

function errandAged(days: number, business: string): string {
  const { id } = newErrand(sampleBrief({ business }), daysAgo(days), home);
  writeOutcome(id, { kind: 'voicemail_left', source: 'session', at: daysAgo(days).toISOString() }, home);
  return id;
}

describe('prune (OPEN 12)', () => {
  it('removes a folder 91 days old and keeps one 89 days old (and one exactly 90)', () => {
    const old = errandAged(91, 'Old');
    const young = errandAged(89, 'Young');
    const edge = errandAged(90, 'Edge');
    const result = prune(NOW, {}, { home });
    assert.deepEqual(result.removed, [old]);
    assert.equal(existsSync(join(home, old)), false);
    assert.deepEqual(listErrands(home), [edge, young].sort());
    assert.equal(describePrune(result), `removed 1 errand folder(s): ${old}`);
  });

  it('a dry run removes nothing and lists what it would remove', () => {
    const old = errandAged(91, 'Old');
    const result = prune(NOW, { dryRun: true }, { home });
    assert.deepEqual(result, { removed: [old], dryRun: true });
    assert.ok(existsSync(join(home, old)));
    assert.equal(describePrune(result), `would remove 1 errand folder(s): ${old}`);
  });

  it('never removes a folder with no outcome dialled less than a day ago', () => {
    const { id } = newErrand(sampleBrief({ business: 'Odd' }), daysAgo(120), home);
    appendEvent(id, { kind: 'dialled' }, new Date(NOW.getTime() - 60 * 60_000), home);
    assert.deepEqual(prune(NOW, {}, { home }).removed, []);
    assert.ok(existsSync(join(home, id)));
  });
});
