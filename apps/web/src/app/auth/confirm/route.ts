import { NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';

import { explainAuthError, publicEnv } from '@atwood/core';

import { publicOrigin, sanitiseNext } from '@/lib/auth-redirect';
import { createClient } from '@/lib/supabase/server';

/**
 * GET /auth/confirm
 *
 * Verifies a magic-link or signup token and signs the user in, then forwards them
 * on. This is the cross-device path: unlike `/auth/callback` (the `code` flow),
 * `verifyOtp` needs no PKCE code verifier, so a link can be requested on one
 * browser and opened on another. The `code` flow keeps working alongside it for
 * same-device sign-in.
 *
 * The `next` parameter is validated rather than trusted, for the same reason as
 * the callback route: it arrives from a URL the user clicked in an email, and
 * forwarding to an arbitrary value would make this an open redirect.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const base = publicOrigin(request);
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') as EmailOtpType | null;
  const next = sanitiseNext(url.searchParams.get('next'));

  if (!tokenHash || !type) {
    return NextResponse.redirect(new URL('/login?error=Invalid+sign-in+link', base));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

  if (error) {
    const message = explainAuthError(error.message, publicEnv.supabaseUrl);
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(message)}`, base));
  }

  return NextResponse.redirect(new URL(next, base));
}
