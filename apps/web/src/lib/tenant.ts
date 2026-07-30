import { notFound, redirect } from 'next/navigation';

import { createClient, getCurrentUser } from './supabase/server';

/**
 * Tenant resolution for dashboard pages.
 *
 * Every `/app/[slug]/…` page starts by calling `requireTenant`. It returns the
 * business, the caller's role in it, and an RLS-scoped Supabase client.
 *
 * Note what it does *not* do: it never filters by business_id itself. The query
 * below asks for a business by slug with no tenancy predicate — and gets a row only
 * if the caller is a member, because RLS applies it. A non-member sees a 404, which
 * is also the right answer for a slug that does not exist: both should be
 * indistinguishable, or the dashboard becomes a tenant-enumeration oracle.
 */

export interface TenantContext {
  businessId: string;
  slug: string;
  name: string;
  role: 'owner' | 'admin' | 'agent' | 'viewer';
  userId: string;
  theme: {
    tradingName: string | null;
    logoUrl: string | null;
    logoDarkUrl: string | null;
    brandPrimary: string;
    brandAccent: string;
    brandForeground: string;
  };
}

export async function requireTenant(slug: string): Promise<TenantContext> {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/app/${slug}`);

  const supabase = await createClient();

  // No business_id filter here on purpose — see the note above.
  const { data } = await supabase
    .from('businesses')
    .select(
      `id, slug, name,
       business_profiles ( trading_name, logo_url, logo_dark_url, brand_primary, brand_accent, brand_foreground ),
       memberships ( role, user_id )`,
    )
    .eq('slug', slug)
    .maybeSingle();

  if (!data) notFound();

  const business = data as {
    id: string;
    slug: string;
    name: string;
    business_profiles:
      | {
          trading_name: string | null;
          logo_url: string | null;
          logo_dark_url: string | null;
          brand_primary: string;
          brand_accent: string;
          brand_foreground: string;
        }
      | Array<{
          trading_name: string | null;
          logo_url: string | null;
          logo_dark_url: string | null;
          brand_primary: string;
          brand_accent: string;
          brand_foreground: string;
        }>
      | null;
    memberships: Array<{ role: string; user_id: string }>;
  };

  // PostgREST returns an embedded 1:1 relation as an object or a single-element
  // array depending on how it infers the relationship; normalise both.
  const profile = Array.isArray(business.business_profiles)
    ? business.business_profiles[0]
    : business.business_profiles;

  const membership = business.memberships.find((m) => m.user_id === user.id);

  // RLS already guaranteed membership to return the row at all; this is belt and
  // braces, and it is how we learn the caller's role.
  if (!membership) notFound();

  return {
    businessId: business.id,
    slug: business.slug,
    name: business.name,
    role: membership.role as TenantContext['role'],
    userId: user.id,
    theme: {
      tradingName: profile?.trading_name ?? null,
      logoUrl: profile?.logo_url ?? null,
      logoDarkUrl: profile?.logo_dark_url ?? null,
      brandPrimary: profile?.brand_primary ?? '#0f172a',
      brandAccent: profile?.brand_accent ?? '#2563eb',
      brandForeground: profile?.brand_foreground ?? '#ffffff',
    },
  };
}

/** Roles permitted to write. Used to hide or disable actions in the UI. */
export function canWrite(role: TenantContext['role']): boolean {
  return role === 'owner' || role === 'admin' || role === 'agent';
}

export function canAdminister(role: TenantContext['role']): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * Every business the caller belongs to. Drives the switcher and the `/app` landing
 * redirect. RLS scopes it.
 */
export async function listMyBusinesses(): Promise<Array<{ id: string; slug: string; name: string }>> {
  const supabase = await createClient();

  const { data } = await supabase
    .from('businesses')
    .select('id, slug, name')
    .order('name');

  return (data ?? []) as Array<{ id: string; slug: string; name: string }>;
}
