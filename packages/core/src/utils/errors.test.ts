import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { explainAuthError } from './errors.ts';

const URL_ = 'http://127.0.0.1:54323';

describe('explainAuthError', () => {
  it('translates the JSON parse error a misconfigured URL produces', () => {
    // The exact message the Supabase client produces when the configured URL answers
    // with HTML. Reproduced against a stub server, not written from memory.
    const raw = `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`;
    const result = explainAuthError(raw, URL_);

    assert.match(result, /answered with a web page/);
    assert.match(result, /NEXT_PUBLIC_SUPABASE_URL/);
    assert.match(result, /54321/, 'must name the port that would work');
    assert.match(result, new RegExp(URL_.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(result, /Unexpected token/, 'the parser message must not survive');
  });

  it('translates a DOCTYPE body even when the wording of the parse error differs', () => {
    // Node, Bun and browsers word this differently; matching on the payload rather
    // than only the phrasing is what keeps this working across runtimes.
    const result = explainAuthError('JSON.parse: unexpected character <!DOCTYPE html>', URL_);
    assert.match(result, /answered with a web page/);
  });

  it('translates an unreachable host', () => {
    const result = explainAuthError('fetch failed', 'https://your-project.supabase.co');
    assert.match(result, /Could not reach the Supabase API/);
    assert.match(result, /pnpm db:start/);
  });

  it('passes a real auth error through untouched', () => {
    // These already say something true and specific; rewriting them would lose
    // information rather than add it.
    for (const message of [
      'Email rate limit exceeded',
      'Email link is invalid or has expired',
      'Signups not allowed for otp',
    ]) {
      assert.equal(explainAuthError(message, URL_), message);
    }
  });

  it('does not mistake a message that merely mentions fetching for a transport failure', () => {
    const message = 'Could not fetch failed login attempts for this user';
    assert.equal(explainAuthError(message, URL_), message);
  });
});
