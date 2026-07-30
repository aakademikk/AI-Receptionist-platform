import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { ConfigError, publicEnv } from './env.ts';

/**
 * These all exercise the same idea: a misconfigured Supabase URL must fail at boot
 * naming the value that would work, not at sign-in as a JSON parse error.
 *
 * Each URL here is one a person actually pasted.
 */

const ORIGINAL = process.env['NEXT_PUBLIC_SUPABASE_URL'];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['NEXT_PUBLIC_SUPABASE_URL'];
  else process.env['NEXT_PUBLIC_SUPABASE_URL'] = ORIGINAL;
});

function read(url: string): string {
  process.env['NEXT_PUBLIC_SUPABASE_URL'] = url;
  return publicEnv.supabaseUrl;
}

function rejection(url: string): ConfigError {
  process.env['NEXT_PUBLIC_SUPABASE_URL'] = url;
  try {
    void publicEnv.supabaseUrl;
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: `expected ${url} to be rejected` });
}

describe('publicEnv.supabaseUrl', () => {
  it('accepts the local API URL', () => {
    assert.equal(read('http://127.0.0.1:54321'), 'http://127.0.0.1:54321');
  });

  it('accepts a hosted project URL', () => {
    const url = 'https://hthirrwvgonjyraxswdr.supabase.co';
    assert.equal(read(url), url);
  });

  it('accepts a self-hosted instance behind a path prefix', () => {
    // Not every path is a mistake — only the known sub-APIs are.
    const url = 'https://internal.example.com/supabase';
    assert.equal(read(url), url);
  });

  it('rejects the dashboard URL and derives the API URL from the project ref', () => {
    const error = rejection('https://supabase.com/dashboard/project/hthirrwvgonjyraxswdr');
    assert.match(error.message, /dashboard/i);
    assert.match(
      error.message,
      /https:\/\/hthirrwvgonjyraxswdr\.supabase\.co/,
      'must hand over the exact API URL, not merely describe its shape',
    );
  });

  it('rejects a dashboard URL with no recognisable ref, and says where to look', () => {
    const error = rejection('https://supabase.com/dashboard');
    assert.match(error.message, /Project Settings/);
  });

  it('rejects the storage sub-API URL that `supabase start` prints', () => {
    // Labelled "API URL" in the S3 section of the start output, which is why it gets
    // copied. The client would append /auth/v1/... to it.
    const error = rejection('http://127.0.0.1:54321/storage/v1/s3');
    assert.match(error.message, /storage/);
    assert.match(error.message, /http:\/\/127\.0\.0\.1:54321$/m);
  });

  it('rejects the Studio port and names the API port', () => {
    const error = rejection('http://127.0.0.1:54323');
    assert.match(error.message, /Studio/);
    assert.match(error.message, /54321/);
  });

  it('rejects the .env.example placeholder', () => {
    const error = rejection('https://your-project.supabase.co');
    assert.match(error.message, /placeholder/);
    assert.match(error.message, /pnpm db:start/);
  });

  it('rejects a value that is not a URL at all', () => {
    const error = rejection('127.0.0.1:54321');
    assert.match(error.message, /not a valid URL/);
  });
});
