import { formatPhoneForDisplay } from '@atwood/core';

import { Badge, Card, CardHeader, EmptyState, SplitBar, StatTile, TableShell, Td, Th } from '@/components/ui';
import { createClient } from '@/lib/supabase/server';
import { requireTenant } from '@/lib/tenant';

/**
 * The overview screen.
 *
 * Everything on this page comes from three queries against views that are already
 * tenant-scoped by RLS: `dashboard_today` (live), `handling_split_30d` (from the
 * sealed rollups), and `handover_queue`.
 *
 * The layout answers, in order: does anything need me right now, what happened
 * today, and is the assistant earning its keep. The handover queue is first because
 * it is the only thing on the page that is time-critical.
 */
export default async function OverviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await requireTenant(slug);
  const supabase = await createClient();

  const [todayResult, splitResult, queueResult] = await Promise.all([
    supabase.from('dashboard_today').select('*').eq('business_id', tenant.businessId).maybeSingle(),
    supabase.from('handling_split_30d').select('*').eq('business_id', tenant.businessId).maybeSingle(),
    supabase
      .from('handover_queue')
      .select('*')
      .eq('business_id', tenant.businessId)
      .order('handover_at', { ascending: true })
      .limit(10),
  ]);

  const today = (todayResult.data ?? {}) as Record<string, number | null>;
  const split = splitResult.data as
    | { ai_total: number; human_total: number; handovers: number; leads_qualified: number }
    | null;
  const queue = (queueResult.data ?? []) as Array<{
    conversation_id: string;
    customer_name: string | null;
    customer_phone: string | null;
    handover_reason_code: string | null;
    waiting_minutes: number;
    sla_breached: boolean;
    summary: string | null;
    urgency: string | null;
  }>;

  const awaiting = today['awaiting_human'] ?? 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Overview</h1>
        <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          Today so far, in {tenant.theme.tradingName ?? tenant.name}&rsquo;s local time.
        </p>
      </div>

      {/* Time-critical first. */}
      {queue.length > 0 ? (
        <Card padded={false}>
          <div className="p-5 pb-0">
            <CardHeader
              title="Waiting for a person"
              description="The assistant has stepped back on these. Oldest first."
            />
          </div>
          <TableShell>
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th>Why</Th>
                <Th>Waiting</Th>
                <Th>Summary</Th>
              </tr>
            </thead>
            <tbody>
              {queue.map((row) => (
                <tr key={row.conversation_id}>
                  <Td>
                    <a
                      href={`/app/${slug}/conversations/${row.conversation_id}`}
                      className="font-medium hover:underline"
                    >
                      {row.customer_name ?? formatPhoneForDisplay(row.customer_phone) ?? 'Unknown'}
                    </a>
                  </Td>
                  <Td>
                    <Badge tone={row.urgency === 'emergency' ? 'critical' : 'warning'}>
                      {(row.handover_reason_code ?? 'manual').replaceAll('_', ' ')}
                    </Badge>
                  </Td>
                  <Td align="right">
                    <span style={{ color: row.sla_breached ? 'var(--status-critical)' : undefined }}>
                      {row.waiting_minutes}m{row.sla_breached ? ' · overdue' : ''}
                    </span>
                  </Td>
                  <Td muted>
                    <span className="line-clamp-2">{row.summary ?? '—'}</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Missed calls" value={today['calls_missed'] ?? 0} hint="today" />
        <StatTile label="Conversations" value={today['conversations_today'] ?? 0} hint="today" />
        <StatTile
          label="Awaiting a person"
          value={awaiting}
          tone={awaiting > 0 ? 'warning' : 'good'}
          href={`/app/${slug}/conversations?status=waiting_for_human`}
        />
        <StatTile label="New leads" value={today['leads_today'] ?? 0} hint="today" />
        <StatTile
          label="Qualified"
          value={today['qualified_today'] ?? 0}
          hint="today"
          tone={(today['qualified_today'] ?? 0) > 0 ? 'good' : 'neutral'}
        />
        <StatTile
          label="First reply"
          value={formatSeconds(today['avg_first_response_seconds'])}
          hint="average today"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Who answered"
            description="Share of outbound replies over the last 30 days."
          />
          <SplitBar
            aiCount={split?.ai_total ?? 0}
            humanCount={split?.human_total ?? 0}
            aiLabel="Assistant"
            humanLabel="Your team"
          />
          <dl className="mt-5 grid grid-cols-2 gap-4 text-[13px]">
            <div>
              <dt style={{ color: 'var(--text-muted)' }}>Handovers</dt>
              <dd className="tnum mt-0.5 text-lg font-semibold">{split?.handovers ?? 0}</dd>
            </div>
            <div>
              <dt style={{ color: 'var(--text-muted)' }}>Qualified leads</dt>
              <dd className="tnum mt-0.5 text-lg font-semibold">{split?.leads_qualified ?? 0}</dd>
            </div>
          </dl>
        </Card>

        <Card>
          <CardHeader title="Coming up" description="Appointments in the next seven days." />
          {(today['appointments_next_7d'] ?? 0) === 0 ? (
            <EmptyState
              title="Nothing booked"
              description="Appointments the assistant books will appear here."
            />
          ) : (
            <div className="tnum text-4xl font-semibold">{today['appointments_next_7d']}</div>
          )}
        </Card>
      </div>
    </div>
  );
}

function formatSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value < 60) return `${Math.round(value)}s`;
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}
