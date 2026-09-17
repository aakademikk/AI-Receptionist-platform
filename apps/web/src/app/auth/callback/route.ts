import { NextResponse } from 'next/server';

import { explainAuthError, publicEnv } from '@atwood/core';

import { publicOrigin, sanitiseNext } from '@/lib/auth-redirect';
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
  const base = publicOrigin(request);
  const code = url.searchParams.get('code');
  const next = sanitiseNext(url.searchParams.get('next'));

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=Missing+sign-in+code', base));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const message = explainAuthError(error.message, publicEnv.supabaseUrl);
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(message)}`, base));
  }

  return NextResponse.redirect(new URL(next, base));
}
