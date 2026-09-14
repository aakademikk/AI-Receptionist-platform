import { redirect } from 'next/navigation';

import { EmptyState } from '@/components/ui';
import { listMyBusinesses } from '@/lib/tenant';

/**
 * `/app` — the landing redirect.
 *
 * One business (the common case) goes straight through. Several — an agency
 * managing multiple clients — gets a picker rather than an arbitrary choice.
 */
export default async function AppIndex() {
  const businesses = await listMyBusinesses();

  if (businesses.length === 1) {
    redirect(`/app/${businesses[0]!.slug}`);
  }

  if (businesses.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <EmptyState
          title="You are not a member of any business yet"
          description="Ask whoever invited you to add you to their business, or start a new one from the onboarding flow."
        />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <div className="mb-8">
        <h1 className="text-gradient text-2xl font-semibold tracking-tight">Choose a business</h1>
        <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          You have access to more than one.
        </p>
      </div>
      <div className="glass hairline rounded-2xl p-2">
        <ul className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
          {businesses.map((business) => (
            <li key={business.id}>
              <a
                href={`/app/${business.slug}`}
                className="flex items-center justify-between rounded-xl px-3 py-3 text-[14px] font-medium transition-colors hover:bg-white/[0.03]"
              >
                <span>{business.name}</span>
                <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  /{business.slug}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
