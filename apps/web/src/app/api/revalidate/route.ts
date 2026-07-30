import { revalidatePath } from 'next/cache';
import { NextResponse } from 'next/server';

import { serverEnv, verifySharedSecret } from '@atwood/core';

/**
 * POST /api/revalidate
 *
 * Cache invalidation for deployments that serve dashboard pages from a CDN cache.
 *
 * Most of the dashboard is dynamic and needs none of this. It exists for the
 * Dashboard Sync workflow, and for the moment after onboarding is applied — when a
 * tenant's branding and service catalogue change all at once and any cached shell
 * would be stale.
 *
 * Paths are validated against the tenant's own prefix. Without that check, a caller
 * could purge another tenant's pages, or the whole site, from one request.
 */
export async function POST(request: Request): Promise<Response> {
  const presented = request.headers.get('x-atwood-secret');

  if (!verifySharedSecret(presented, serverEnv.internalApiSecret)) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Invalid internal API secret' } },
      { status: 401 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    slug?: unknown;
    paths?: unknown;
  };

  const slug = typeof body.slug === 'string' ? body.slug : null;
  const requested = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === 'string') : [];

  const revalidated: string[] = [];

  if (slug) {
    // Scope every path to this tenant's subtree. A bare `/` or another tenant's
    // prefix is rejected rather than silently honoured.
    const prefix = `/app/${slug}`;
    const targets = requested.length > 0 ? requested : [prefix];

    for (const path of targets) {
      if (path === prefix || path.startsWith(`${prefix}/`)) {
        revalidatePath(path);
        revalidated.push(path);
      }
    }
  }

  return NextResponse.json({ revalidated });
}
