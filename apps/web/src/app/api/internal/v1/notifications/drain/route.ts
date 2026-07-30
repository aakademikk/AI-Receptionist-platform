import { NextResponse } from 'next/server';

import { drainNotifications, forbidden } from '@atwood/core';

import { readJson, withInternalAuth } from '@/lib/internal-auth';

/**
 * POST /api/internal/v1/notifications/drain
 *
 * Deliver a batch from the notification outbox. Called by the Notification Engine
 * workflow on a schedule (every minute is a sensible default).
 *
 * Platform-scoped: it drains across all tenants, so a per-tenant API key is refused.
 * Concurrency is safe — the claim uses `FOR UPDATE SKIP LOCKED`, so overlapping runs
 * take disjoint batches rather than double-sending.
 */
export const POST = withInternalAuth(async (request, auth) => {
  if (auth.businessId !== null) {
    throw forbidden('Draining the notification queue is a platform-level operation');
  }

  type Body = { limit?: unknown };
  const body: Body = await readJson<Body>(request).catch(() => ({}) as Body);
  const requested = typeof body.limit === 'number' ? body.limit : 25;
  // Bounded so one invocation cannot run past a serverless timeout mid-batch and
  // leave rows stuck in `sending`.
  const limit = Math.max(1, Math.min(requested, 100));

  const result = await drainNotifications(limit);

  return NextResponse.json({ trace_id: auth.traceId, ...result });
});
