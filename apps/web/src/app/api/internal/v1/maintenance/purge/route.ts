import { NextResponse } from 'next/server';

import { forbidden, getAdminClient, logger } from '@atwood/core';

import { readJson, withInternalAuth } from '@/lib/internal-auth';

/**
 * POST /api/internal/v1/maintenance/purge
 *
 * Retention sweep. Deletes AI logs, delivered notifications and closed conversations
 * past each tenant's configured `data_retention_days`.
 *
 * This is the mechanism behind the storage-limitation half of the GDPR story: a
 * documented retention period only means something if something actually enforces
 * it. Run nightly.
 *
 * Deliberately batched. An unbounded delete across a large tenant would hold locks
 * long enough to affect live traffic, so each run removes at most `batch_limit` rows
 * per table and the schedule catches up over successive nights.
 */
export const POST = withInternalAuth(async (request, auth) => {
  if (auth.businessId !== null) {
    throw forbidden('The retention sweep is a platform-level operation');
  }

  const body = await readJson<{ batch_limit?: unknown }>(request).catch(() => ({}));
  const requested = typeof body.batch_limit === 'number' ? body.batch_limit : 5_000;
  const batchLimit = Math.max(100, Math.min(requested, 50_000));

  const { data, error } = await getAdminClient().rpc('purge_expired_data', {
    p_batch_limit: batchLimit,
  });

  if (error) {
    logger.error('Retention sweep failed', { traceId: auth.traceId, error: error.message });
    throw new Error(`Purge failed: ${error.message}`);
  }

  logger.info('Retention sweep complete', { traceId: auth.traceId, result: data });

  return NextResponse.json({ trace_id: auth.traceId, result: data });
});
