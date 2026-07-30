#!/usr/bin/env node
/**
 * `pnpm env:check` — report what the app actually resolves from your env files.
 *
 * Environment misconfiguration is the most common way a first run fails, and the
 * symptoms are indirect: a Supabase URL pointing at a web page surfaces as a JSON
 * parse error at sign-in, and an env file in the wrong directory surfaces as a
 * missing-variable error for a variable you can see with your own eyes. This resolves
 * the files the same way Next.js does and prints the result, so the answer is one
 * command rather than a guess.
 *
 * Never prints a secret. Values are masked to a prefix and a length.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP_DIR = path.join(ROOT, 'apps', 'web');

const REQUIRED = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'INTERNAL_API_SECRET',
  'CREDENTIAL_ENCRYPTION_KEY',
];

const OPTIONAL = [
  'NEXT_PUBLIC_APP_URL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'FIRECRAWL_API_KEY',
  'RESEND_API_KEY',
  'N8N_WEBHOOK_BASE_URL',
];

const problems = [];
const notes = [];

/** Mask everything but a short prefix — enough to tell two keys apart, never enough to use one. */
function mask(name, value) {
  if (name.startsWith('NEXT_PUBLIC_') && !name.includes('KEY')) return value;
  if (value.length <= 8) return `${'*'.repeat(value.length)} (${value.length} chars)`;
  return `${value.slice(0, 8)}… (${value.length} chars)`;
}

/* -- 1. Which files exist, and are any of them in a place nothing reads? ---------- */

console.log('\nEnvironment files\n');

const appLocal = path.join(APP_DIR, '.env.local');
console.log(`  ${existsSync(appLocal) ? '✓' : '✗'} apps/web/.env.local   ← the app reads this`);
if (!existsSync(appLocal)) {
  problems.push(
    'apps/web/.env.local is missing. Create it with:\n' +
      '      cp .env.example apps/web/.env.local',
  );
}

const rootEnv = path.join(ROOT, '.env');
console.log(`  ${existsSync(rootEnv) ? '✓' : '✗'} .env                  ← docker compose reads this`);

// The traps. Both of these look right in a file listing and are read by nothing.
const rootLocal = path.join(ROOT, '.env.local');
if (existsSync(rootLocal)) {
  problems.push(
    'A .env.local exists at the repo root. Next.js only loads env files from the app ' +
      'directory, so this file is ignored entirely. Move it:\n' +
      '      mv .env.local apps/web/.env.local',
  );
}

for (const stray of ['.env.local.txt', '.env.txt']) {
  for (const dir of [ROOT, APP_DIR]) {
    if (existsSync(path.join(dir, stray))) {
      problems.push(
        `Found ${path.relative(ROOT, path.join(dir, stray))}. An editor appended .txt ` +
          `when saving. Rename it to ${stray.replace('.txt', '')}.`,
      );
    }
  }
}

/* -- 2. Resolve the way Next does ------------------------------------------------- */

const require_ = createRequire(path.join(APP_DIR, 'package.json'));
let loaded;
try {
  /*
   * Two hops on purpose. `@next/env` is a transitive dependency of `next`, and pnpm's
   * strict layout links only declared dependencies into a package's node_modules — so
   * resolving it from apps/web fails. Going via next's own package root asks the
   * package that actually declares it.
   */
  const nextRequire = createRequire(require_.resolve('next/package.json'));
  const { loadEnvConfig } = nextRequire('@next/env');
  const result = loadEnvConfig(APP_DIR, true, { info: () => {}, warn: () => {}, error: () => {} });
  loaded = (result.loadedEnvFiles ?? []).map((f) => path.relative(ROOT, f.path));
} catch (error) {
  console.error(`\nCould not load @next/env — has \`pnpm install\` run? (${error.message})\n`);
  process.exit(1);
}

console.log(`\n  Next loaded: ${loaded.length ? loaded.join(', ') : '(nothing)'}`);

/*
 * Duplicate keys within one file resolve to the last occurrence, and .env.local wins
 * over .env, so a stale line above a corrected one is invisible unless you look for
 * it. Reporting it is cheaper than the confusion of editing a value that is overridden.
 */
if (existsSync(appLocal)) {
  const counts = new Map();
  for (const line of readFileSync(appLocal, 'utf8').split(/\r?\n/)) {
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    if (count > 1) {
      notes.push(
        `${key} is set ${count} times in apps/web/.env.local. The last one wins; ` +
          `delete the others so the file says what it means.`,
      );
    }
  }
}

/* -- 3. Report the values --------------------------------------------------------- */

console.log('\nRequired\n');
for (const name of REQUIRED) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.log(`  ✗ ${name.padEnd(32)} missing`);
    problems.push(`${name} is not set.`);
  } else {
    console.log(`  ✓ ${name.padEnd(32)} ${mask(name, value)}`);
  }
}

console.log('\nOptional\n');
for (const name of OPTIONAL) {
  const value = process.env[name];
  console.log(
    value && value.trim()
      ? `  · ${name.padEnd(32)} ${mask(name, value)}`
      : `  · ${name.padEnd(32)} —`,
  );
}

/* -- 4. Validate the Supabase URL with the app's own rules ------------------------ */

const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
if (url) {
  try {
    // The same check the app runs at boot, so this can never disagree with it.
    const { publicEnv } = await import(path.join(ROOT, 'packages/core/src/env.ts'));
    void publicEnv.supabaseUrl;
    console.log('\n  ✓ NEXT_PUBLIC_SUPABASE_URL passes the app\'s validation');
  } catch (error) {
    problems.push(error.message);
  }
}

/*
 * A key in the current format that is in the wrong slot is worth catching here:
 * publishable in the service-role variable means every privileged write fails with a
 * permission error rather than anything mentioning keys.
 */
const anon = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ?? '';
const service = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
if (anon.startsWith('sb_secret_')) {
  problems.push(
    'NEXT_PUBLIC_SUPABASE_ANON_KEY holds a secret key (sb_secret_…). That is the ' +
      'service-role key and NEXT_PUBLIC_ variables are compiled into the browser ' +
      'bundle — swap the two. Publishable goes here.',
  );
}
/*
 * A current-format secret key breaks every service-role call while leaving the
 * dashboard working, because supabase-js sends the API key as a bearer token when
 * there is no user session and PostgREST cannot verify a non-JWT. The library only
 * suppresses that fallback on its Edge Functions client. Symptom is
 * "No suitable key or wrong key type" on webhooks, takeover and the whole internal API.
 */
if (service.startsWith('sb_secret_')) {
  problems.push(
    'SUPABASE_SERVICE_ROLE_KEY is a current-format secret key (sb_secret_…). ' +
      'supabase-js sends it to PostgREST as a bearer token, which cannot verify it — ' +
      'every service-role call fails with "No suitable key or wrong key type" while the ' +
      'dashboard keeps working. Use the legacy JWT: `pnpm exec supabase status -o env` ' +
      'prints it as SERVICE_ROLE_KEY.',
  );
}
if (service.startsWith('sb_publishable_')) {
  problems.push(
    'SUPABASE_SERVICE_ROLE_KEY holds a publishable key (sb_publishable_…). It cannot ' +
      'bypass RLS, so the internal API will fail on every write. Use the Secret key.',
  );
}

/* -- 5. Verdict ------------------------------------------------------------------- */

if (notes.length) {
  console.log('\nWorth tidying\n');
  for (const note of notes) console.log(`  ! ${note}`);
}

if (problems.length) {
  console.log('\nProblems\n');
  for (const problem of problems) console.log(`  ✗ ${problem}\n`);
  console.log(`${problems.length} problem${problems.length === 1 ? '' : 's'} to fix.\n`);
  process.exit(1);
}

console.log('\nAll good. `pnpm db:start` then `pnpm dev`.\n');
