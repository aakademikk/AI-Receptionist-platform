import { formatPhoneForDisplay } from '@atwood/core';

import { Badge, Card, EmptyState, TableShell, Td, Th } from '@/components/ui';
import { createClient } from '@/lib/supabase/server';
import { requireTenant } from '@/lib/tenant';

const URGENCY_TONE = {
  emergency: 'critical',
  high: 'warning',
  normal: 'neutral',
  low: 'neutral',
} as const;

/**
 * Leads.
 *
 * Sorted by score descending by default — the owner's question is "who should I ring
 * first?", not "who arrived most recently". The score is computed in code (see
 * `scoreLead`) so the ordering means the same thing every day.
 */
export default async function LeadsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string; status?: string; sort?: string }>;
}) {
  const { slug } = await params;
  const { q, status, sort } = await searchParams;
  const tenant = await requireTenant(slug);
  const supabase = await createClient();

  const orderColumn = sort === 'recent' ? 'created_at' : 'score';

  let query = supabase
    .from('leads')
    .select(
      `id, conversation_id, name, phone, email, postcode, service_text, summary,
       urgency, status, score, completeness, callback_text, created_at`,
    )
    .eq('business_id', tenant.businessId)
    .order(orderColumn, { ascending: false })
    .limit(100);

  if (status) query = query.eq('status', status);

  if (q && q.trim().length >= 2) {
    const term = q.trim().replace(/[%_,()\\]/g, '');
    query = query.or(
      `name.ilike.%${term}%,phone.ilike.%${term}%,summary.ilike.%${term}%,postcode.ilike.%${term}%`,
    );
  }

  const { data } = await query;
  const leads = (data ?? []) as Array<{
    id: string;
    conversation_id: string;
    name: string | null;
    phone: string | null;
    email: string | null;
    postcode: string | null;
    service_text: string | null;
    summary: string | null;
    urgency: keyof typeof URGENCY_TONE;
    status: string;
    score: number;
    callback_text: string | null;
    created_at: string;
  }>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Leads</h1>
        <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          Extracted from conversations. Highest score first — most complete and most
          urgent at the top.
        </p>
      </div>

      <Card>
        <form className="flex flex-wrap items-center gap-3" action={`/app/${slug}/leads`}>
          <input
            type="search"
            name="q"
            defaultValue={q ?? ''}
            placeholder="Search name, number, postcode or summary"
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
            <option value="">Any status</option>
            {['new', 'qualifying', 'qualified', 'booked', 'nurture', 'unqualified', 'won', 'lost'].map(
              (value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ),
            )}
          </select>
          <select
            name="sort"
            defaultValue={sort ?? 'score'}
            className="rounded-lg border px-3 py-2 text-[13px]"
            style={{
              background: 'var(--surface-2)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
          >
            <option value="score">Best first</option>
            <option value="recent">Newest first</option>
          </select>
          <button
            type="submit"
            className="rounded-lg px-3.5 py-2 text-[13px] font-semibold"
            style={{ background: 'var(--brand-accent)', color: '#ffffff' }}
          >
            Apply
          </button>
        </form>
      </Card>

      {leads.length === 0 ? (
        <EmptyState
          title={q || status ? 'No leads match those filters' : 'No leads yet'}
          description="When the assistant captures a name, a number and what someone needs, the lead shows up here."
        />
      ) : (
        <TableShell>
          <thead>
            <tr>
              <Th align="right">Score</Th>
              <Th>Name</Th>
              <Th>Contact</Th>
              <Th>Needs</Th>
              <Th>Urgency</Th>
              <Th>Status</Th>
              <Th>Callback</Th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr key={lead.id}>
                <Td align="right">
                  <span className="font-semibold">{lead.score}</span>
                </Td>
                <Td>
                  <a
                    href={`/app/${slug}/conversations/${lead.conversation_id}`}
                    className="font-medium hover:underline"
                  >
                    {lead.name ?? 'Unnamed'}
                  </a>
                  <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {new Date(lead.created_at).toLocaleDateString('en-GB')}
                  </div>
                </Td>
                <Td muted>
                  <div>{formatPhoneForDisplay(lead.phone) || '—'}</div>
                  {lead.email ? <div className="text-[11px]">{lead.email}</div> : null}
                  {lead.postcode ? <div className="text-[11px]">{lead.postcode}</div> : null}
                </Td>
                <Td muted>
                  <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                    {lead.service_text ?? '—'}
                  </div>
                  <span className="line-clamp-2 max-w-[320px]">{lead.summary ?? ''}</span>
                </Td>
                <Td>
                  <Badge tone={URGENCY_TONE[lead.urgency] ?? 'neutral'}>{lead.urgency}</Badge>
                </Td>
                <Td>
                  <Badge tone={lead.status === 'qualified' || lead.status === 'won' ? 'good' : 'neutral'}>
                    {lead.status}
                  </Badge>
                </Td>
                <Td muted>{lead.callback_text ?? '—'}</Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}
    </div>
  );
}
