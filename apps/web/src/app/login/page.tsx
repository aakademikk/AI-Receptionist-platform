import { redirect } from 'next/navigation';

import { explainAuthError, publicEnv } from '@atwood/core';

import { createClient, getCurrentUser } from '@/lib/supabase/server';

/**
 * Sign in.
 *
 * Magic link only — no passwords. For a product whose users are small-business
 * owners checking a dashboard from a phone, this removes the entire password surface
 * (reset flows, reuse, storage, breach exposure) in exchange for one email round
 * trip. Supabase Auth owns the token lifecycle; this page owns a form.
 *
 * A server action rather than a client component: the form works without JavaScript,
 * and the Supabase call happens server-side.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; sent?: string; error?: string }>;
}) {
  const { next, sent, error } = await searchParams;

  if (await getCurrentUser()) redirect(next ?? '/app');

  async function signIn(formData: FormData) {
    'use server';

    const email = String(formData.get('email') ?? '').trim();
    const nextPath = String(formData.get('next') ?? '/app');

    if (!email) redirect('/login?error=Enter+your+email+address');

    const supabase = await createClient();
    const origin = process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000';

    const { error: signInError } = await supabase.auth.signInWithOtp({
      email,
      options: {
        // Only mail addresses that already have an account. Without this, an unknown
        // address silently creates a new auth.users row — an unauthenticated write
        // and outbound-mail surface on a public URL.
        shouldCreateUser: false,
        // The callback exchanges the code for a session and then forwards to `next`.
        emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(nextPath)}`,
      },
    });

    if (signInError) {
      // `shouldCreateUser: false` makes an unknown address fail with `otp_disabled`.
      // Show the same "check your email" screen as a real send — answering with an
      // error here would tell a stranger which addresses have accounts on this box.
      if (signInError.code === 'otp_disabled') {
        redirect(`/login?sent=1&next=${encodeURIComponent(nextPath)}`);
      }

      // A misconfigured Supabase URL arrives here as a JSON parse error, which tells
      // the reader nothing. Translate it before it reaches the form.
      const message = explainAuthError(signInError.message, publicEnv.supabaseUrl);
      redirect(`/login?error=${encodeURIComponent(message)}`);
    }

    redirect(`/login?sent=1&next=${encodeURIComponent(nextPath)}`);
  }

  return (
    <main className="relative mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-16">
      {/*
        The ambient glow that sits behind this card is no longer here. It was a 12%
        radial painted into this column, and this column is `max-w-md` -- so it faded
        out at the edges of the form rather than filling the screen. The backdrop now
        comes from `.ambient` on <body>, which is full-bleed, and from the shared
        `--ambient-backdrop` token so the login screen and the dashboard cannot drift
        apart.
      */}

      <div className="relative mb-8">
        <h1 className="text-gradient text-3xl font-bold tracking-tight">Atwood Systems</h1>
        <p className="mt-2 text-[14px]" style={{ color: 'var(--text-secondary)' }}>
          Sign in to your receptionist dashboard.
        </p>
      </div>

      <div className="glass hairline relative rounded-2xl p-8">
        {sent ? (
          <div className="text-[14px]">
            <p className="font-medium">Check your email.</p>
            <p className="mt-1.5" style={{ color: 'var(--text-secondary)' }}>
              We&rsquo;ve sent you a sign-in link. It expires in an hour.
            </p>
          </div>
        ) : (
          <form action={signIn} className="space-y-5">
            <input type="hidden" name="next" value={next ?? '/app'} />

            <div className="field">
              <label htmlFor="email">Email address</label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                autoFocus
                placeholder="you@example.com"
              />
            </div>

            {error ? (
              <p className="text-[13px]" style={{ color: 'var(--status-critical)' }} role="alert">
                {error}
              </p>
            ) : null}

            <button type="submit" className="btn-primary w-full">
              Email me a sign-in link
            </button>
          </form>
        )}
      </div>

      <p className="relative mt-6 text-[12px]" style={{ color: 'var(--text-muted)' }}>
        No password to remember. We&rsquo;ll email you a link each time.
      </p>
    </main>
  );
}
