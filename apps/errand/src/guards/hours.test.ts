import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkCallingHours } from './hours.ts';

/** UK local `HH:MM` on a GMT date (November) and a BST date (July), as an instant. */
const gmt = (hhmm: string): Date => new Date(`2026-11-10T${hhmm}:00Z`);
const bst = (hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(2026, 6, 15, h - 1, m));
};

describe('checkCallingHours', () => {
  for (const [label, at] of [['GMT', gmt], ['BST', bst]] as const) {
    it(`${label}: 07:59 refused, 08:00 and 20:59 allowed, 21:00 refused`, () => {
      assert.deepEqual(checkCallingHours(at('07:59')), { ok: false, reason: 'outside calling hours (08:00 to 21:00 UK); it is 07:59 UK time now' });
      assert.deepEqual(checkCallingHours(at('08:00')), { ok: true });
      assert.deepEqual(checkCallingHours(at('20:59')), { ok: true });
      assert.deepEqual(checkCallingHours(at('21:00')), { ok: false, reason: 'outside calling hours (08:00 to 21:00 UK); it is 21:00 UK time now' });
    });
  }

  it('passes outside the hours only when the brief says afterHours (OPEN 14, T34)', () => {
    const twoAm = gmt('02:00');
    assert.equal(checkCallingHours(twoAm).ok, false);
    assert.equal(checkCallingHours(twoAm, { afterHours: false }).ok, false);
    assert.deepEqual(checkCallingHours(twoAm, { afterHours: true }), { ok: true, note: 'after hours, on the brief' });
    assert.deepEqual(checkCallingHours(gmt('14:00'), { afterHours: true }), { ok: true });
  });

  it('reads the hour in UK time, not UTC: 07:30 UTC in July is 08:30 BST and dials', () => {
    assert.deepEqual(checkCallingHours(new Date('2026-07-15T07:30:00Z')), { ok: true });
    assert.equal(checkCallingHours(new Date('2026-07-15T20:30:00Z')).ok, false);
  });
});
