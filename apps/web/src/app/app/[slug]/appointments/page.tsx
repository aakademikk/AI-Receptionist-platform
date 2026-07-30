import { formatPhoneForDisplay } from '@atwood/core';

import { Badge, EmptyState, TableShell, Td, Th } from '@/components/ui';
import { createClient } from '@/lib/supabase/server';
import { requireTenant } from '@/lib/tenant';

const TONE = {
  confirmed: 'good',
  pending: 'warning',
  completed: 'good',
  cancelled: 'neutral',
  no_show: 'critical',
} as const;

/** Appointments, upcoming first. Past bookings are kept but pushed below. */
export default async function AppointmentsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await requireTenant(slug);
  const supabase = await createClient();

  const { data } = await supabase
    .from('appointments')
    .select(
      `id, conversation_id, starts_at, ends_at, status, customer_name, customer_phone,
       customer_email, notes, timezone`,
    )
    .eq('business_id', tenant.businessId)
    // Upcoming ascending is what an owner wants to read; the filter keeps recent
    // history visible without an unbounded scan.
    .gte('starts_at', new Date(Date.now() - 30 * 86_400_000).toISOString())
    .order('starts_at', { ascending: true })
    .limit(200);

  const appointments = (data ?? []) as Array<{
    id: string;
    conversation_id: string | null;
    starts_at: string;
    status: keyof typeof TONE;
    customer_name: string | null;
    customer_phone: string | null;
    notes: string | null;
    timezone: string;
  }>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Appointments</h1>
        <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          Booked by the assistant or by your team. Times shown in each booking&rsquo;s own timezone.
        </p>
      </div>

      {appointments.length === 0 ? (
        <EmptyState
          title="Nothing booked"
          description="Turn booking on in Settings and connect a calendar, and the assistant can offer real slots."
        />
      ) : (
        <TableShell>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Customer</Th>
              <Th>Status</Th>
              <Th>Notes</Th>
            </tr>
          </thead>
          <tbody>
            {appointments.map((appointment) => (
              <tr key={appointment.id}>
                <Td>
                  <span className="font-medium">
                    {new Date(appointment.starts_at).toLocaleString('en-GB', {
                      timeZone: appointment.timezone,
                      weekday: 'short',
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </Td>
                <Td>
                  {appointment.conversation_id ? (
                    <a
                      href={`/app/${slug}/conversations/${appointment.conversation_id}`}
                      className="hover:underline"
                    >
                      {appointment.customer_name ?? formatPhoneForDisplay(appointment.customer_phone) ?? '—'}
                    </a>
                  ) : (
                    (appointment.customer_name ?? '—')
                  )}
                </Td>
                <Td>
                  <Badge tone={TONE[appointment.status] ?? 'neutral'}>
                    {appointment.status.replaceAll('_', ' ')}
                  </Badge>
                </Td>
                <Td muted>
                  <span className="line-clamp-2 max-w-[380px]">{appointment.notes ?? '—'}</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}
    </div>
  );
}
