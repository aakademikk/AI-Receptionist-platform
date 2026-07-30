import type { ReactNode } from 'react';

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
      <header className="border-b" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-6 py-3">
          <a href={`/app/${slug}`} className="flex items-center gap-2.5 min-w-0">
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
                className="grid size-7 shrink-0 place-items-center rounded-md text-[12px] font-bold"
                style={{ background: 'var(--brand-primary)', color: 'var(--brand-foreground)' }}
              >
                {(tenant.theme.tradingName ?? tenant.name).slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="truncate text-[14px] font-semibold">
              {tenant.theme.tradingName ?? tenant.name}
            </span>
          </a>

          <nav className="ml-auto flex items-center gap-0.5 overflow-x-auto">
            {nav.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="rounded-md px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap hover:brightness-95"
                style={{ color: 'var(--text-secondary)' }}
              >
                {item.label}
              </a>
            ))}
          </nav>

          <span
            className="hidden shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium sm:inline"
            style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
          >
            {tenant.role}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  );
}
