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
        // The callback exchanges the code for a session and then forwards to `next`.
        emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(nextPath)}`,
      },
    });

    if (signInError) {
      // A misconfigured Supabase URL arrives here as a JSON parse error, which tells
      // the reader nothing. Translate it before it reaches the form.
      const message = explainAuthError(signInError.message, publicEnv.supabaseUrl);
      redirect(`/login?error=${encodeURIComponent(message)}`);
    }

    redirect(`/login?sent=1&next=${encodeURIComponent(nextPath)}`);
  }

  return (
    <main className="relative mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-16">
      {/* Ambient brand glow behind the card. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
        style={{
          background:
            'radial-gradient(50% 45% at 50% 35%, color-mix(in srgb, var(--brand-accent) 12%, transparent), transparent 70%)',
        }}
      />

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
