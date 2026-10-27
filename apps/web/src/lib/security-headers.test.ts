import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import config from '../../next.config.ts';

import {
  CSP_REPORT_ONLY_HEADER,
  buildContentSecurityPolicy,
  createNonce,
  securityHeaders,
} from './security-headers.ts';

/** `default-src 'self'; script-src ...` -> Map of directive name to its source list. */
function directives(policy: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) map.set(name, sources);
  }
  return map;
}

function header(key: string): string | undefined {
  return securityHeaders.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;
}

describe('Strict-Transport-Security (H2)', () => {
  it('is sent with a max-age of at least six months', () => {
    const value = header('Strict-Transport-Security');
    assert.ok(value, 'no Strict-Transport-Security header');
    const maxAge = Number(/max-age=(\d+)/i.exec(value)?.[1]);
    // The own-site patrol's floor (live-smoke.sh HEADER RULES).
    assert.ok(maxAge >= 15768000, `max-age ${maxAge} is under 15768000`);
  });

  it('does not pin subdomains or ask for preload', () => {
    const value = header('Strict-Transport-Security') ?? '';
    assert.doesNotMatch(value, /includeSubDomains/i);
    assert.doesNotMatch(value, /preload/i);
  });

  it('is what next.config.ts headers() actually returns, on every path', async () => {
    const rules = (await config.headers?.()) ?? [];
    const all = rules.find((r) => r.source === '/:path*');
    assert.ok(all, 'no /:path* header rule in next.config.ts');
    const hsts = all.headers.find((h) => h.key === 'Strict-Transport-Security');
    assert.ok(hsts, 'next.config.ts headers() does not send Strict-Transport-Security');
    assert.equal(hsts.value, header('Strict-Transport-Security'));
  });

  it('leaves the existing headers unchanged', () => {
    assert.equal(header('X-Content-Type-Options'), 'nosniff');
    assert.equal(header('X-Frame-Options'), 'DENY');
    assert.equal(header('Referrer-Policy'), 'strict-origin-when-cross-origin');
    assert.equal(header('Permissions-Policy'), 'camera=(), microphone=(), geolocation=()');
  });
});

describe('Content-Security-Policy-Report-Only (H3)', () => {
  const nonce = createNonce();
  const policy = buildContentSecurityPolicy(nonce);
  const csp = directives(policy);

  it('is sent as Report-Only, not enforcing, until Colin has used it for a day', () => {
    assert.equal(CSP_REPORT_ONLY_HEADER, 'Content-Security-Policy-Report-Only');
  });

  it("carries default-src 'self', frame-ancestors 'none' and object-src 'none'", () => {
    assert.match(policy, /(^|;)\s*default-src 'self'(;|$)/);
    assert.match(policy, /(^|;)\s*frame-ancestors 'none'(;|$)/);
    assert.match(policy, /(^|;)\s*object-src 'none'(;|$)/);
    assert.deepEqual(csp.get('base-uri'), ["'self'"]);
    assert.deepEqual(csp.get('form-action'), ["'self'"]);
  });

  it('puts the per-request nonce in script-src', () => {
    assert.ok(csp.get('script-src')?.includes(`'nonce-${nonce}'`), policy);
  });

  it("never allows inline script without a nonce ('unsafe-inline')", () => {
    for (const dev of [false, true]) {
      const scripts = directives(buildContentSecurityPolicy(nonce, { dev })).get('script-src');
      assert.ok(scripts, 'no script-src');
      assert.ok(!scripts.includes("'unsafe-inline'"), scripts.join(' '));
      assert.ok(scripts.some((s) => s.startsWith("'nonce-")), scripts.join(' '));
    }
  });

  it("allows 'unsafe-eval' in development only (React's dev error stacks)", () => {
    assert.ok(!csp.get('script-src')?.includes("'unsafe-eval'"));
    const dev = directives(buildContentSecurityPolicy(nonce, { dev: true }));
    assert.ok(dev.get('script-src')?.includes("'unsafe-eval'"));
  });

  it('makes a fresh nonce each call, in the form Next.js reads back', () => {
    const a = createNonce();
    const b = createNonce();
    assert.notEqual(a, b);
    // Next's getScriptNonceFromHeader only accepts this alphabet; anything else is
    // dropped silently and the page renders with no nonce on its scripts.
    assert.match(a, /^[A-Za-z0-9+/_-]+={0,2}$/);
    assert.ok(a.length >= 22, 'nonce under 128 bits');
  });
});
