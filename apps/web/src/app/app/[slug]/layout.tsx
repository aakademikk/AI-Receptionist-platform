import type { ReactNode } from 'react';

import { TenantNav } from '@/components/tenant-nav';
import { requireTenant } from '@/lib/tenant';

/**
 * The tenant shell.
 *
 * White-labelling happens here, and it happens in exactly one place: the tenant's
 * brand colours are written as inline CSS custom properties on the wrapper, and
 * every descendant reads them by role. No component knows the tenant's colours; no
 * component needs a `brandColor` prop.
 *
 * The colours reach chrome only. Data marks use the fixed validated `--series-*`
 * palette, which is not overridden here — see the note in globals.css for why a
 * customer-chosen colour must never become an encoding.
 *
 * The shell is the dark-canvas glassmorphism frame: a brand-tinted ambient glow at
 * the top, a frosted sticky header, and the content column beneath.
 */
export default async function TenantLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tenant = await requireTenant(slug);

  const nav = [
    { href: `/app/${slug}`, label: 'Overview' },
    { href: `/app/${slug}/conversations`, label: 'Conversations' },
    { href: `/app/${slug}/leads`, label: 'Leads' },
    { href: `/app/${slug}/appointments`, label: 'Appointments' },
    { href: `/app/${slug}/analytics`, label: 'Analytics' },
    { href: `/app/${slug}/knowledge`, label: 'Knowledge' },
    { href: `/app/${slug}/settings`, label: 'Settings' },
  ];

  return (
    <div
      className="relative"
      style={
        {
          '--brand-primary': tenant.theme.brandPrimary,
          '--brand-accent': tenant.theme.brandAccent,
          '--brand-foreground': tenant.theme.brandForeground,
          minHeight: '100dvh',
          background: 'var(--surface-0)',
        } as React.CSSProperties
      }
    >
      {/* Ambient brand glow bleeding down from the top of the canvas. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-80"
        style={{
          background:
            'radial-gradient(60% 100% at 50% 0%, color-mix(in srgb, var(--brand-accent) 10%, transparent), transparent 70%)',
        }}
      />

      <header className="glass hairline sticky top-0 z-40">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
          <a href={`/app/${slug}`} className="flex min-w-0 items-center gap-2.5">
            {tenant.theme.logoUrl ? (
              // Plain <img>: the URL is tenant-supplied and arbitrary, so it cannot
              // be pre-declared to next/image's remote allowlist.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={tenant.theme.logoUrl}
                alt=""
                className="h-7 w-auto max-w-[140px] object-contain"
              />
            ) : (
              <span
                className="grid size-8 shrink-0 place-items-center rounded-xl text-[13px] font-bold"
                style={{
                  background: 'color-mix(in srgb, var(--brand-accent) 12%, transparent)',
                  border: '1px solid var(--edge)',
                }}
              >
                <span className="text-gradient">
                  {(tenant.theme.tradingName ?? tenant.name).slice(0, 1).toUpperCase()}
                </span>
              </span>
            )}
            <span className="text-gradient truncate text-[15px] font-semibold">
              {tenant.theme.tradingName ?? tenant.name}
            </span>
          </a>

          <TenantNav items={nav} />

          <span
            className="chip hidden shrink-0 text-[11px] sm:inline-flex"
            style={{ color: 'var(--text-muted)' }}
          >
            {tenant.role}
          </span>
        </div>
      </header>

      <main className="relative mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
