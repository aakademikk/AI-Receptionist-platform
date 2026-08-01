import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeFetchError, explainAuthError } from './errors.ts';

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

  it('replaces a content-free message rather than rendering it', () => {
    // Rendered as a bare "{}" in the sign-in form, which is worse than useless.
    for (const raw of ['', '   ', '{}', '[object Object]']) {
      const result = explainAuthError(raw, URL_);
      assert.match(result, /no message/);
      assert.match(result, /pnpm db:reset/);
    }
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

describe('describeFetchError', () => {
  it('unwraps the cause Node hides behind "fetch failed"', () => {
    // Exactly the shape undici produces: a bare outer message, real reason in `cause`.
    const inner = Object.assign(new Error('getaddrinfo ENOTFOUND n8n.example.uk'), {
      code: 'ENOTFOUND',
    });
    const outer = new Error('fetch failed', { cause: inner });

    const result = describeFetchError(outer);
    assert.match(result, /fetch failed/);
    assert.match(result, /ENOTFOUND/, 'the useful part must survive');
    assert.match(result, /n8n\.example\.uk/);
  });

  it('reports a TLS failure rather than swallowing it', () => {
    const inner = Object.assign(new Error('certificate has expired'), {
      code: 'CERT_HAS_EXPIRED',
    });
    assert.match(describeFetchError(new Error('fetch failed', { cause: inner })), /CERT_HAS_EXPIRED/);
  });

  it('does not loop forever on a cyclic cause chain', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    const result = describeFetchError(b);
    assert.ok(result.length < 200, 'must terminate');
  });

  it('handles a plain thrown value', () => {
    assert.equal(describeFetchError('something odd'), 'something odd');
  });
});
