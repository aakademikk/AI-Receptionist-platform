import { parseVoiceTestVariant } from '@atwood/core';
import { NextResponse } from 'next/server';

/**
 * GET /api/health
 *
 * Liveness only. Deliberately does not touch the database.
 *
 * A health check that queries Postgres conflates two different questions — "is this
 * process serving?" and "is the database reachable?" — and answering them together
 * means a brief database blip causes a load balancer to cycle every healthy app
 * instance, turning a recoverable incident into an outage. Database health belongs
 * in monitoring, not in the check that decides whether to kill a container.
 */
// Read per request: without this Next may prerender the route at build time and freeze
// `voiceTestVariant` (and `time`) at whatever the build saw, hiding a variant switch.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return NextResponse.json(
    {
      status: 'ok',
      service: 'atwood-web',
      time: new Date().toISOString(),
      // Speed-test read-back: the parsed variant name only, never the raw value, so a
      // typo reads back as `today` and nothing unvalidated is echoed.
      voiceTestVariant: parseVoiceTestVariant(process.env.VOICE_TEST_VARIANT).name,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
