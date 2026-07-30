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
export function GET(): Response {
  return NextResponse.json(
    { status: 'ok', service: 'atwood-web', time: new Date().toISOString() },
    { headers: { 'cache-control': 'no-store' } },
  );
}
