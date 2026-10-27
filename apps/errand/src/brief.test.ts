import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FIXED_LIMITS, briefHash, canonicalJson, validateBrief } from './brief.ts';
import { sampleBrief } from './testing/fixtures.ts';

describe('validateBrief', () => {
  it('accepts a complete table brief', () => {
    const result = validateBrief(sampleBrief());
    assert.equal(result.ok, true);
  });

  it('fails a table brief with no party size, naming the field', () => {
    const result = validateBrief(sampleBrief({ details: {} }));
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.field, 'details.partySize');
  });

  it('does not need a party size for another kind of errand', () => {
    assert.equal(validateBrief(sampleBrief({ goalKind: 'other', details: {} })).ok, true);
  });

  it('names each missing field', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ business: '' }, 'business'],
      [{ number: ' ' }, 'number'],
      [{ goal: undefined }, 'goal'],
      [{ goalKind: 'pizza' }, 'goalKind'],
      [{ window: undefined }, 'window'],
      [{ window: { date: '2026-02-30', earliest: '19:00', latest: '20:00' } }, 'window.date'],
      [{ window: { date: '2026-10-28', earliest: '7pm', latest: '20:00' } }, 'window.earliest'],
      [{ window: { date: '2026-10-28', earliest: '19:00', latest: '24:00' } }, 'window.latest'],
      [{ window: { date: '2026-10-28', earliest: '21:00', latest: '20:00' } }, 'window'],
      [{ contact: { name: 'Colin Wood' } }, 'contact.mobile'],
      [{ contact: { mobile: '+447700900123' } }, 'contact.name'],
      [{ limits: { fixed: ['turn cap 20'], added: [] } }, 'limits.fixed'],
      [{ limits: { fixed: [...FIXED_LIMITS], added: [''] } }, 'limits.added'],
    ];
    for (const [patch, field] of cases) {
      const result = validateBrief({ ...sampleBrief(), ...patch });
      assert.equal(result.ok, false, field);
      assert.equal(!result.ok && result.field, field);
    }
  });

  it('keeps afterHours only when it is true, and refuses any other value (T34)', () => {
    const on = validateBrief({ ...sampleBrief(), afterHours: true });
    assert.ok(on.ok);
    assert.equal(on.brief.afterHours, true);
    const off = validateBrief(sampleBrief());
    assert.ok(off.ok);
    assert.equal('afterHours' in off.brief, false);
    for (const value of [false, 'yes', 1, null]) {
      const result = validateBrief({ ...sampleBrief(), afterHours: value });
      assert.equal(!result.ok && result.field, 'afterHours', String(value));
    }
  });

  it('fills in the fixed limits when the brief names none', () => {
    const { limits: _limits, ...rest } = sampleBrief();
    const result = validateBrief(rest);
    assert.ok(result.ok);
    assert.deepEqual(result.brief.limits, { fixed: [...FIXED_LIMITS], added: [] });
  });
});

describe('briefHash', () => {
  it('changes when afterHours is set, so a Go for one cannot be used for the other (T34)', () => {
    assert.notEqual(briefHash({ ...sampleBrief(), afterHours: true }), briefHash(sampleBrief()));
  });

  it('is the same however the keys were ordered', () => {
    const brief = sampleBrief();
    const reordered = JSON.parse(canonicalJson(brief)) as typeof brief;
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse()) as typeof brief;
    assert.equal(briefHash(shuffled), briefHash(brief));
  });

  it('changes on an edit to any field', () => {
    const base = briefHash(sampleBrief());
    const edits = [
      sampleBrief({ business: "Luigi's Pizzeria" }),
      sampleBrief({ number: '020 7946 0124' }),
      sampleBrief({ goal: 'book a table for three' }),
      sampleBrief({ goalKind: 'other' }),
      sampleBrief({ window: { date: '2026-10-28', earliest: '19:00', latest: '20:45' } }),
      sampleBrief({ window: { date: '2026-10-29', earliest: '19:00', latest: '20:30' } }),
      sampleBrief({ details: { partySize: 3 } }),
      sampleBrief({ details: { partySize: 2, note: 'window seat' } }),
      sampleBrief({ contact: { name: 'Colin Wood', mobile: '+447700900124' } }),
      sampleBrief({ limits: { fixed: [...FIXED_LIMITS], added: ['no outdoor tables'] } }),
    ];
    const hashes = new Set(edits.map(briefHash));
    assert.equal(hashes.size, edits.length);
    assert.equal(hashes.has(base), false);
  });
});
