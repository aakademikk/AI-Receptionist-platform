import { NextResponse } from 'next/server';

import { loadBusinessContext } from '@atwood/core';

import { assertBusinessScope, withInternalAuth } from '@/lib/internal-auth';

/**
 * GET /api/internal/v1/businesses/:businessId/context
 *
 * The Business Loader and Knowledge Loader workflows, as one call. Returns the
 * profile, settings, service catalogue, coverage, hours, published knowledge and
 * numbers — everything the prompt builder needs.
 *
 * Exposed as an endpoint mainly so an n8n workflow that needs to branch on tenant
 * configuration (is booking enabled? which model?) can read it without duplicating
 * the aggregation. The reply pipeline does not call this over HTTP — it loads the
 * same view in-process, which saves a round trip on the latency-sensitive path.
 */
export const GET = withInternalAuth<{ params: Promise<{ businessId: string }> }>(
  async (_request, auth, { params }) => {
    const { businessId } = await params;
    assertBusinessScope(auth, businessId);

    const context = await loadBusinessContext(businessId);

    return NextResponse.json(
      { trace_id: auth.traceId, context },
      {
        headers: {
          // Tenant configuration changes rarely and this is read often, so a few
          // seconds of caching is worth having. Private, because the body is
          // tenant data and must never land in a shared cache.
          'cache-control': 'private, max-age=5, stale-while-revalidate=30',
        },
      },
    );
  },
);
