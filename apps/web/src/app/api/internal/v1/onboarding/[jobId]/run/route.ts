import { NextResponse } from 'next/server';

import { getAdminClient, notFound, runOnboarding } from '@atwood/core';

import { assertBusinessScope, withInternalAuth } from '@/lib/internal-auth';

/**
 * POST /api/internal/v1/onboarding/:jobId/run
 *
 * Advance an onboarding job one step: start the crawl, poll it, or extract.
 *
 * A step function rather than one long call, because a crawl takes 30–120 seconds —
 * longer than a serverless function should hold a connection, and longer than an
 * owner will stare at a spinner. The browser polls this, or an n8n schedule does,
 * and each call is short and idempotent.
 */
export const POST = withInternalAuth<{ params: Promise<{ jobId: string }> }>(
  async (_request, auth, { params }) => {
    const { jobId } = await params;

    const { data } = await getAdminClient()
      .from('onboarding_jobs')
      .select('business_id')
      .eq('id', jobId)
      .maybeSingle();

    if (!data) throw notFound(`Onboarding job ${jobId}`);
    assertBusinessScope(auth, (data as { business_id: string }).business_id);

    const result = await runOnboarding(jobId);

    return NextResponse.json({ trace_id: auth.traceId, ...result });
  },
);
