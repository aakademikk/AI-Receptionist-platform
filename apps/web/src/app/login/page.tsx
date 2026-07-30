import { redirect } from 'next/navigation';

import { Card } from '@/components/ui';
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
      redirect(`/login?error=${encodeURIComponent(signInError.message)}`);
    }

    redirect(`/login?sent=1&next=${encodeURIComponent(nextPath)}`);
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-16">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold">Atwood Systems</h1>
        <p className="mt-1.5 text-[14px]" style={{ color: 'var(--text-secondary)' }}>
          Sign in to your receptionist dashboard.
        </p>
      </div>

      <Card>
        {sent ? (
          <div className="text-[14px]">
            <p className="font-medium">Check your email.</p>
            <p className="mt-1.5" style={{ color: 'var(--text-secondary)' }}>
              We&rsquo;ve sent you a sign-in link. It expires in an hour.
            </p>
          </div>
        ) : (
          <form action={signIn} className="space-y-4">
            <input type="hidden" name="next" value={next ?? '/app'} />

            <div>
              <label
                htmlFor="email"
                className="mb-1.5 block text-[13px] font-medium"
                style={{ color: 'var(--text-secondary)' }}
              >
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                autoFocus
                className="w-full rounded-lg border px-3 py-2.5 text-[14px]"
                style={{
                  background: 'var(--surface-2)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>

            {error ? (
              <p className="text-[13px]" style={{ color: 'var(--status-critical)' }} role="alert">
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              className="w-full rounded-lg px-4 py-2.5 text-[14px] font-semibold"
              style={{ background: 'var(--brand-accent)', color: '#ffffff' }}
            >
              Email me a sign-in link
            </button>
          </form>
        )}
      </Card>

      <p className="mt-6 text-[12px]" style={{ color: 'var(--text-muted)' }}>
        No password to remember. We&rsquo;ll email you a link each time.
      </p>
    </main>
  );
}
