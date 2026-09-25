import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { asHeard } from './context.ts';

describe('asHeard', () => {
  const body = 'Our team has been alerted. Can you give me your postcode?';

  it('leaves a reply the caller heard exactly as it was', () => {
    assert.equal(asHeard(body, {}), body);
    assert.equal(asHeard(body, null), body);
    assert.equal(asHeard(body, { callSid: 'CA1', turn: 2 }), body);
  });

  it('shows only what was heard, and says the rest was not', () => {
    const text = asHeard(body, { interrupted: true, heard: 'Our team has been alerted.' });
    assert.ok(text!.startsWith('Our team has been alerted.'));
    assert.doesNotMatch(text!, /postcode/);
    assert.match(text!, /did not hear/);
  });

  it('says plainly when none of it was heard (the live 2026-09-25 case)', () => {
    const text = asHeard(body, { interrupted: true, heard: '' });
    assert.match(text!, /before hearing any of it/);
  });
});
