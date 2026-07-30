import { formatPhoneForDisplay } from '@atwood/core';

import { Badge, Card, CardHeader, EmptyState, TableShell, Td, Th } from '@/components/ui';
import { createClient } from '@/lib/supabase/server';
import { requireTenant } from '@/lib/tenant';

const STATUS_TONE: Record<string, 'neutral' | 'good' | 'warning' | 'critical' | 'info'> = {
  active: 'info',
  waiting_for_human: 'warning',
  human_handling: 'info',
  resolved: 'good',
  closed: 'neutral',
  archived: 'neutral',
};

/**
 * Conversation list, with search and status filtering.
 *
 * Search runs server-side against the trigram indexes on `customer_name` and
 * `summary`. The obvious alternative — fetch and filter in the browser — would work
 * for a tenant with fifty conversations and fall over for one with fifty thousand,
 * which is the whole point of building this for thousands of businesses.
 */
export default async function ConversationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const { slug } = await params;
  const { q, status } = await searchParams;
  const tenant = await requireTenant(slug);
  const supabase = await createClient();

  let query = supabase
    .from('conversations')
    .select(
      `id, customer_name, customer_phone, channel, status, lead_status, summary,
       message_count, last_message_at, handover_reason_code, ai_enabled`,
    )
    .eq('business_id', tenant.businessId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(100);

  if (status) query = query.eq('status', status);

  if (q && q.trim().length >= 2) {
    // Escape PostgREST's `or` metacharacters. Without this a comma in the search box
    // breaks out of the filter list — a filter-injection bug, not just a bad result.
    const term = q.trim().replace(/[%_,()\\]/g, '');
    query = query.or(
      `customer_name.ilike.%${term}%,summary.ilike.%${term}%,customer_phone.ilike.%${term}%`,
    );
  }

  const { data } = await query;

  const conversations = (data ?? []) as Array<{
    id: string;
    customer_name: string | null;
    customer_phone: string | null;
    channel: string;
    status: string;
    lead_status: string;
    summary: string | null;
    message_count: number;
    last_message_at: string | null;
    handover_reason_code: string | null;
    ai_enabled: boolean;
  }>;

  const filters = [
    { label: 'All', value: '' },
    { label: 'Needs a person', value: 'waiting_for_human' },
    { label: 'Active', value: 'active' },
    { label: 'With your team', value: 'human_handling' },
    { label: 'Resolved', value: 'resolved' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Conversations</h1>
        <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          Every thread, newest activity first.
        </p>
      </div>

      {/* Filters in one row above the table. */}
      <Card>
        <form className="flex flex-wrap items-center gap-3" action={`/app/${slug}/conversations`}>
          <input
            type="search"
            name="q"
            defaultValue={q ?? ''}
            placeholder="Search name, number or summary"
            className="min-w-[220px] flex-1 rounded-lg border px-3 py-2 text-[13px]"
            style={{
              background: 'var(--surface-2)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
          />
          <select
            name="status"
            defaultValue={status ?? ''}
            className="rounded-lg border px-3 py-2 text-[13px]"
            style={{
              background: 'var(--surface-2)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
          >
            {filters.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-lg border px-3.5 py-2 text-[13px] font-semibold"
            style={{ background: 'var(--brand-accent)', color: '#ffffff', borderColor: 'transparent' }}
          >
            Search
          </button>
        </form>
      </Card>

      {conversations.length === 0 ? (
        <EmptyState
          title={q || status ? 'Nothing matches those filters' : 'No conversations yet'}
          description={
            q || status
              ? 'Try a broader search.'
              : 'When someone calls and you miss it, or texts your number, the thread will appear here.'
          }
        />
      ) : (
        <TableShell>
          <thead>
            <tr>
              <Th>Customer</Th>
              <Th>Status</Th>
              <Th>Lead</Th>
              <Th>Summary</Th>
              <Th align="right">Messages</Th>
              <Th align="right">Last activity</Th>
            </tr>
          </thead>
          <tbody>
            {conversations.map((conversation) => (
              <tr key={conversation.id}>
                <Td>
                  <a
                    href={`/app/${slug}/conversations/${conversation.id}`}
                    className="font-medium hover:underline"
                  >
                    {conversation.customer_name ??
                      formatPhoneForDisplay(conversation.customer_phone) ??
                      'Unknown'}
                  </a>
                  <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {conversation.channel}
                  </div>
                </Td>
                <Td>
                  <Badge tone={STATUS_TONE[conversation.status] ?? 'neutral'}>
                    {conversation.status.replaceAll('_', ' ')}
                  </Badge>
                  {!conversation.ai_enabled && conversation.status === 'active' ? (
                    <div className="mt-1">
                      <Badge>AI paused</Badge>
                    </div>
                  ) : null}
                </Td>
                <Td muted>{conversation.lead_status.replaceAll('_', ' ')}</Td>
                <Td muted>
                  <span className="line-clamp-2 max-w-[420px]">{conversation.summary ?? '—'}</span>
                </Td>
                <Td align="right">{conversation.message_count}</Td>
                <Td align="right" muted>
                  {formatRelative(conversation.last_message_at)}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}
    </div>
  );
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const minutes = Math.round((Date.now() - then) / 60_000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
