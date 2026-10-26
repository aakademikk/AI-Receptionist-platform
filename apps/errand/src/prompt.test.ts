import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OPENING_LINE } from './config.ts';
import { DECISION_SCHEMA, buildErrandPrompt } from './prompt.ts';
import { COLIN_MOBILE, sampleBrief } from './testing/fixtures.ts';

describe('buildErrandPrompt', () => {
  const prompt = buildErrandPrompt(sampleBrief({ limits: { fixed: sampleBrief().limits.fixed, added: ['no outdoor tables'] } }));

  it('names who Amy calls for, the business, the goal, the window, the details and the contact', () => {
    for (const part of ['on behalf of Colin Wood', "calling Luigi's", 'book a table for two', 'Wed 28 Oct, between 19:00 and 20:30', '19:00 to 20:30', 'partySize: 2', COLIN_MOBILE, 'no outdoor tables']) {
      assert.ok(prompt.includes(part), part);
    }
  });

  it('states the rules: disclosure, window, details, payment, nothing beyond the goal, menus', () => {
    for (const part of [OPENING_LINE, 'automated assistant', 'Never agree a time outside it', 'Colin will give that to you directly.', 'Never take part in payment', 'Agree nothing beyond the goal', 'keypad digits', '"cannotPlace"']) {
      assert.ok(prompt.includes(part), part);
    }
  });

  it('gives the JSON reply shape, matching the schema', () => {
    for (const key of Object.keys(DECISION_SCHEMA.properties)) assert.ok(prompt.includes(`"${key}"`), key);
    assert.deepEqual(DECISION_SCHEMA.required, ['say']);
  });
});
