import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { requireTwilioBase } from './config.ts';

/**
 * The errand path's boundary, enforced rather than promised (must-do 20).
 *
 * Errand calls must leave the receptionist byte-identical and write nothing to the tenant
 * database. The cheapest way to keep that true as the package grows is to make the
 * forbidden imports fail a test: a later change that reaches for `replyToCaller`, the
 * Supabase client or the relay's session class turns this suite red before it can ship.
 *
 * Imports are an allow-list, not a deny-list. `@atwood/core` may be used only for
 * `./integrations/twilio` (signature check, TwiML builder) and `./ai` (the Gemini provider),
 * so the core root index (which re-exports the domain) and every other subpath fail, along
 * with `@supabase/*`, and any relative path that climbs out of `apps/errand`.
 *
 * Two content rules apply to non-test source: the global Twilio host may appear only in
 * `config.ts`, where `requireTwilioBase` refuses it, and nothing may set `Record` on a call
 * (OPEN 11: transcript only, no recording). Tests are exempt from the content rules because
 * they must name what they forbid; this file is exempt from scanning itself for the same reason.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SRC, '..');
const SELF = fileURLToPath(import.meta.url);

const ALLOWED_BARE = new Set(['ws', '@atwood/core/integrations/twilio', '@atwood/core/ai']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every module specifier in a file: static imports, re-exports, side-effect and dynamic imports. */
function specifiers(text: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bimport\s+[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.push(match[1]!);
  }
  return found;
}

/** Why a specifier is out of bounds for a file, or null when it is allowed. */
export function importViolation(file: string, spec: string): string | null {
  if (spec.startsWith('node:')) return null;
  if (spec.startsWith('.')) {
    const target = resolve(dirname(file), spec);
    if (target !== PACKAGE_ROOT && !target.startsWith(PACKAGE_ROOT + sep)) {
      return `relative import leaves apps/errand: ${spec}`;
    }
    return null;
  }
  if (ALLOWED_BARE.has(spec)) return null;
  if (spec === '@atwood/core') return 'core root index (re-exports the domain)';
  if (spec.startsWith('@supabase/')) return 'Supabase client (no tenant database writes)';
  if (spec.startsWith('@atwood/core/')) return `core subpath not allowed: ${spec}`;
  return `package not on the allow-list: ${spec}`;
}

const RECORD_PARAM = /(['"`])Record\1|\bRecord\s*[:=](?!=)/;
const GLOBAL_HOST = 'api.twilio.com';

function contentViolations(file: string, text: string): string[] {
  const out: string[] = [];
  const rel = relative(SRC, file);
  if (rel !== 'config.ts' && text.includes(GLOBAL_HOST)) out.push(`${rel}: names ${GLOBAL_HOST}`);
  if (RECORD_PARAM.test(text)) out.push(`${rel}: sets Record on a call`);
  return out;
}

export function boundaryViolations(files: Array<{ path: string; text: string }>): string[] {
  const out: string[] = [];
  for (const { path, text } of files) {
    for (const spec of specifiers(text)) {
      const why = importViolation(path, spec);
      if (why) out.push(`${relative(SRC, path)}: ${why}`);
    }
    if (!path.endsWith('.test.ts')) out.push(...contentViolations(path, text));
  }
  return out;
}

describe('errand package boundary', () => {
  it('no source file imports outside the allow-list, names the global Twilio host or records a call', () => {
    const files = sourceFiles(SRC)
      .filter((path) => path !== SELF)
      .map((path) => ({ path, text: readFileSync(path, 'utf8') }));
    assert.ok(files.length > 0, 'expected source files to scan');
    assert.deepEqual(boundaryViolations(files), []);
  });

  it('catches each forbidden import', () => {
    const file = join(SRC, 'example.ts');
    const cases: Array<[string, boolean]> = [
      ["import { replyToCaller } from '@atwood/core/domain';", true],
      ["import '@atwood/core/domain';", true],
      ["import { x } from '@atwood/core/supabase';", true],
      ["import { x } from '@atwood/core';", true],
      ["import { createClient } from '@supabase/supabase-js';", true],
      ["import { RelaySession } from '../../relay/src/protocol.ts';", true],
      ["import x from '../../web/src/lib/conversation-relay.ts';", true],
      ["const m = await import('@atwood/core/domain');", true],
      ["export { x } from '@atwood/core/env';", true],
      ["import { validateTwilioSignature } from '@atwood/core/integrations/twilio';", false],
      ["import { GoogleProvider } from '@atwood/core/ai';", false],
      ["import { WebSocketServer } from 'ws';", false],
      ["import { readFileSync } from 'node:fs';", false],
      ["import { ROBOT_NUMBER } from './config.ts';", false],
    ];
    for (const [text, bad] of cases) {
      const violations = boundaryViolations([{ path: file, text }]);
      assert.equal(violations.length > 0, bad, text);
    }
  });

  it('catches the global host and a Record parameter in non-test source', () => {
    const file = join(SRC, 'example.ts');
    assert.equal(boundaryViolations([{ path: file, text: "const u = 'https://api.twilio.com/2010-04-01';" }]).length, 1);
    assert.equal(boundaryViolations([{ path: file, text: "form.set('Record', 'true');" }]).length, 1);
    assert.equal(boundaryViolations([{ path: file, text: 'const body = { Record: true };' }]).length, 1);
    assert.equal(boundaryViolations([{ path: file, text: 'const m: Record<string, string> = {};' }]).length, 0);
    assert.equal(boundaryViolations([{ path: join(SRC, 'config.ts'), text: "const h = 'api.twilio.com';" }]).length, 0);
  });
});

describe('requireTwilioBase', () => {
  it('returns the regional base without a trailing slash', () => {
    assert.equal(
      requireTwilioBase({ TWILIO_API_BASE_URL: 'https://api.dublin.ie1.twilio.com/2010-04-01/' }),
      'https://api.dublin.ie1.twilio.com/2010-04-01',
    );
  });

  it('throws when the base is unset or blank', () => {
    assert.throws(() => requireTwilioBase({}), /not set/);
    assert.throws(() => requireTwilioBase({ TWILIO_API_BASE_URL: '   ' }), /not set/);
  });

  it('throws when the base names the global host', () => {
    assert.throws(() => requireTwilioBase({ TWILIO_API_BASE_URL: 'https://api.twilio.com/2010-04-01' }), /regional edge/);
    assert.throws(() => requireTwilioBase({ TWILIO_API_BASE_URL: 'https://API.TWILIO.COM' }), /regional edge/);
  });

  it('throws when the base is not a URL', () => {
    assert.throws(() => requireTwilioBase({ TWILIO_API_BASE_URL: 'dublin' }), /not a valid URL/);
  });
});
