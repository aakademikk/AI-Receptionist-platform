import { NextResponse } from 'next/server';

import { badRequest, getAdminClient } from '@atwood/core';

import { assertBusinessScope, readJson, withInternalAuth } from '@/lib/internal-auth';

/**
 * POST /api/internal/v1/analytics/rollup
 *
 * Seal a day's metrics into `analytics_daily`. Called nightly by the Analytics
 * workflow, and on demand to backfill.
 *
 * With no `business_id`, rolls up every active tenant. With one, just that tenant.
 * Both forms are idempotent — the rollup is an upsert keyed on
 * (business_id, day) — so a retried or overlapping run recomputes rather than
 * double-counts.
 *
 * The day boundary is evaluated in each tenant's own timezone inside the SQL
 * function, so "yesterday" means the right 24 hours for a business in Leeds and one
 * in Sydney.
 */
export const POST = withInternalAuth(async (request, auth) => {
  // An empty body is valid — it means "roll up every tenant for yesterday" — so a
  // missing or unparseable body degrades to defaults rather than a 400.
  type Body = { business_id?: unknown; day?: unknown };
  const body: Body = await readJson<Body>(request).catch(() => ({}) as Body);

  const day = typeof body.day === 'string' ? body.day : null;
  if (day !== null && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw badRequest('"day" must be an ISO date (YYYY-MM-DD)');
  }

  const supabase = getAdminClient();

  if (typeof body.business_id === 'string') {
    assertBusinessScope(auth, body.business_id);

    const { error } = await supabase.rpc('rollup_analytics_daily', {
      p_business_id: body.business_id,
      ...(day ? { p_day: day } : {}),
    });

    if (error) throw badRequest(`Rollup failed: ${error.message}`);

    return NextResponse.json({
      trace_id: auth.traceId,
      businesses_rolled_up: 1,
      business_id: body.business_id,
      day,
    });
  }

  // Platform-wide: only the shared secret may do this.
  if (auth.businessId !== null) {
    assertBusinessScope(auth, auth.businessId);
    const { error } = await supabase.rpc('rollup_analytics_daily', {
      p_business_id: auth.businessId,
      ...(day ? { p_day: day } : {}),
    });
    if (error) throw badRequest(`Rollup failed: ${error.message}`);
    return NextResponse.json({ trace_id: auth.traceId, businesses_rolled_up: 1, day });
  }

  const { data, error } = await supabase.rpc('rollup_analytics_all', {
    ...(day ? { p_day: day } : {}),
  });

  if (error) throw badRequest(`Rollup failed: ${error.message}`);

  return NextResponse.json({
    trace_id: auth.traceId,
    businesses_rolled_up: typeof data === 'number' ? data : 0,
    day,
  });
});
