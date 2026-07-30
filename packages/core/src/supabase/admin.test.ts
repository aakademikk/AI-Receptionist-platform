import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { explainSupabaseError } from './admin.ts';

describe('explainSupabaseError', () => {
  it('explains the key-type failure a current-format secret key produces', () => {
    // Verbatim from a real run: the whole message PostgREST returns.
    const result = explainSupabaseError('No suitable key or wrong key type');

    assert.match(result, /SUPABASE_SERVICE_ROLE_KEY/);
    assert.match(result, /sb_secret_/);
    assert.match(result, /supabase status -o env/, 'must say how to get the working key');
    assert.match(result, /^No suitable key or wrong key type/, 'keeps the original message');
  });

  it('matches the wording variants PostgREST uses', () => {
    for (const raw of ['No suitable key or wrong key type', 'JWSError: no suitable key found']) {
      assert.match(explainSupabaseError(raw), /SUPABASE_SERVICE_ROLE_KEY/);
    }
  });

  it('leaves an unrelated error alone', () => {
    // Annotating every failure with a key theory would send people the wrong way.
    for (const raw of [
      'duplicate key value violates unique constraint "messages_provider_id_idx"',
      'new row violates row-level security policy for table "messages"',
    ]) {
      assert.equal(explainSupabaseError(raw), raw);
    }
  });
});
