import { NextResponse } from 'next/server';

import { explainAuthError, publicEnv } from '@atwood/core';

import { createClient } from '@/lib/supabase/server';

/**
 * GET /auth/callback
 *
 * Exchanges the magic-link code for a session cookie, then forwards the user on.
 *
 * The `next` parameter is validated rather than trusted. It arrives from a URL the
 * user clicked in an email, and forwarding to an arbitrary value would make this an
 * open redirect — a phishing primitive that borrows our domain's credibility. Only
 * same-origin absolute paths are allowed through.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = sanitiseNext(url.searchParams.get('next'));

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=Missing+sign-in+code', url.origin));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const message = explainAuthError(error.message, publicEnv.supabaseUrl);
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(message)}`, url.origin),
    );
  }

  return NextResponse.redirect(new URL(next, url.origin));
}

/**
 * Only same-origin paths. Rejects `//evil.example`, `https://evil.example`, and
 * anything else that would leave our origin.
 */
function sanitiseNext(value: string | null): string {
  if (!value) return '/app';
  if (!value.startsWith('/')) return '/app';
  // `//host` is protocol-relative and would leave the origin.
  if (value.startsWith('//')) return '/app';
  return value;
}
