import { Card, CardHeader, EmptyState, SplitBar, StatTile, TableShell, Td, Th } from '@/components/ui';
import { createClient } from '@/lib/supabase/server';
import { requireTenant } from '@/lib/tenant';

/**
 * Analytics.
 *
 * Reads `analytics_daily` — the sealed nightly rollup — rather than aggregating the
 * message log. That is the difference between a page that stays fast for a tenant
 * with two million messages and one that does not.
 *
 * Presented as tiles plus a day table. A time-series chart of these metrics is
 * genuinely useful and is on the roadmap (Phase 5); it is deliberately not
 * half-built here, because a trend line over a handful of seeded days would look
 * like a feature while telling the owner nothing.
 */
export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ days?: string }>;
}) {
  const { slug } = await params;
  const { days } = await searchParams;
  const tenant = await requireTenant(slug);
  const supabase = await createClient();

  const window = days === '7' ? 7 : days === '90' ? 90 : 30;
  const since = new Date(Date.now() - window * 86_400_000).toISOString().slice(0, 10);

  const [rollupResult, sourceResult] = await Promise.all([
    supabase
      .from('analytics_daily')
      .select('*')
      .eq('business_id', tenant.businessId)
      .gte('day', since)
      .order('day', { ascending: false }),
    supabase.from('lead_sources_30d').select('*').eq('business_id', tenant.businessId),
  ]);

  const rows = (rollupResult.data ?? []) as Array<{
    day: string;
    calls_total: number;
    calls_missed: number;
    conversations_started: number;
    messages_ai: number;
    messages_human: number;
    leads_captured: number;
    leads_qualified: number;
    appointments_booked: number;
    handovers: number;
    avg_first_response_seconds: number | null;
    ai_handled_pct: number | null;
    ai_cost_usd: number;
    messaging_cost_usd: number;
  }>;

  const sources = (sourceResult.data ?? []) as Array<{
    source: string;
    leads: number;
    qualified: number;
    avg_completeness: number | null;
  }>;

  const totals = rows.reduce(
    (accumulator, row) => ({
      calls: accumulator.calls + row.calls_total,
      missed: accumulator.missed + row.calls_missed,
      conversations: accumulator.conversations + row.conversations_started,
      ai: accumulator.ai + row.messages_ai,
      human: accumulator.human + row.messages_human,
      leads: accumulator.leads + row.leads_captured,
      qualified: accumulator.qualified + row.leads_qualified,
      appointments: accumulator.appointments + row.appointments_booked,
      handovers: accumulator.handovers + row.handovers,
      aiCost: accumulator.aiCost + Number(row.ai_cost_usd ?? 0),
      smsCost: accumulator.smsCost + Number(row.messaging_cost_usd ?? 0),
    }),
    {
      calls: 0,
      missed: 0,
      conversations: 0,
      ai: 0,
      human: 0,
      leads: 0,
      qualified: 0,
      appointments: 0,
      handovers: 0,
      aiCost: 0,
      smsCost: 0,
    },
  );

  const responseTimes = rows
    .map((row) => row.avg_first_response_seconds)
    .filter((value): value is number => value !== null);

  const avgResponse =
    responseTimes.length > 0
      ? responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length
      : null;

  // Conversion is the number an owner cares about most: of the calls we missed, how
  // many turned into a qualified lead we would otherwise have lost entirely?
  const recovery = totals.missed > 0 ? (totals.qualified / totals.missed) * 100 : null;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Analytics</h1>
          <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            Last {window} days, from the nightly rollup.
          </p>
        </div>
        <nav className="flex gap-1">
          {['7', '30', '90'].map((value) => (
            <a
              key={value}
              href={`/app/${slug}/analytics?days=${value}`}
              className="rounded-md border px-2.5 py-1.5 text-[12px] font-medium"
              style={{
                background: String(window) === value ? 'var(--surface-2)' : 'transparent',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-secondary)',
              }}
            >
              {value}d
            </a>
          ))}
        </nav>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No rolled-up data yet"
          description="The nightly job seals each day's metrics. Come back tomorrow, or run the Analytics workflow to backfill."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile label="Missed calls" value={totals.missed} hint={`of ${totals.calls} calls`} />
            <StatTile label="Conversations" value={totals.conversations} />
            <StatTile label="Leads" value={totals.leads} />
            <StatTile
              label="Qualified"
              value={totals.qualified}
              tone={totals.qualified > 0 ? 'good' : 'neutral'}
            />
            <StatTile label="Booked" value={totals.appointments} />
            <StatTile label="First reply" value={formatSeconds(avgResponse)} hint="average" />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Who answered"
                description={`Share of outbound replies over ${window} days.`}
              />
              <SplitBar
                aiCount={totals.ai}
                humanCount={totals.human}
                aiLabel="Assistant"
                humanLabel="Your team"
              />
              <p className="mt-4 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {totals.handovers} conversation{totals.handovers === 1 ? '' : 's'} handed to a person.
              </p>
            </Card>

            <Card>
              <CardHeader
                title="Recovered from missed calls"
                description="Qualified leads as a share of calls that went unanswered."
              />
              <div className="tnum text-4xl font-semibold">
                {recovery === null ? '—' : `${recovery.toFixed(1)}%`}
              </div>
              <dl className="mt-5 grid grid-cols-2 gap-4 text-[13px]">
                <div>
                  <dt style={{ color: 'var(--text-muted)' }}>Assistant cost</dt>
                  <dd className="tnum mt-0.5 font-semibold">${totals.aiCost.toFixed(2)}</dd>
                </div>
                <div>
                  <dt style={{ color: 'var(--text-muted)' }}>Messaging cost</dt>
                  <dd className="tnum mt-0.5 font-semibold">${totals.smsCost.toFixed(2)}</dd>
                </div>
              </dl>
            </Card>
          </div>

          {sources.length > 0 ? (
            <div>
              <h2 className="mb-3 text-[15px] font-semibold">Lead source</h2>
              <TableShell>
                <thead>
                  <tr>
                    <Th>Source</Th>
                    <Th align="right">Leads</Th>
                    <Th align="right">Qualified</Th>
                    <Th align="right">Avg. completeness</Th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((source) => (
                    <tr key={source.source}>
                      <Td>{source.source.replaceAll('_', ' ')}</Td>
                      <Td align="right">{source.leads}</Td>
                      <Td align="right">{source.qualified}</Td>
                      <Td align="right" muted>
                        {source.avg_completeness === null
                          ? '—'
                          : `${Math.round(Number(source.avg_completeness) * 100)}%`}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            </div>
          ) : null}

          <div>
            <h2 className="mb-3 text-[15px] font-semibold">By day</h2>
            <TableShell>
              <thead>
                <tr>
                  <Th>Day</Th>
                  <Th align="right">Missed</Th>
                  <Th align="right">Threads</Th>
                  <Th align="right">Leads</Th>
                  <Th align="right">Qualified</Th>
                  <Th align="right">Handovers</Th>
                  <Th align="right">AI %</Th>
                  <Th align="right">First reply</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.day}>
                    <Td>{new Date(row.day).toLocaleDateString('en-GB')}</Td>
                    <Td align="right">{row.calls_missed}</Td>
                    <Td align="right">{row.conversations_started}</Td>
                    <Td align="right">{row.leads_captured}</Td>
                    <Td align="right">{row.leads_qualified}</Td>
                    <Td align="right">{row.handovers}</Td>
                    <Td align="right" muted>
                      {row.ai_handled_pct === null ? '—' : `${Number(row.ai_handled_pct).toFixed(0)}%`}
                    </Td>
                    <Td align="right" muted>
                      {formatSeconds(row.avg_first_response_seconds)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </div>
        </>
      )}
    </div>
  );
}

function formatSeconds(value: number | null): string {
  if (value === null) return '—';
  if (value < 60) return `${Math.round(value)}s`;
  return `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
}
