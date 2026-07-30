import { notFound } from 'next/navigation';

import { formatPhoneForDisplay } from '@atwood/core';

import { ConversationActions } from '@/components/conversation-actions';
import { Badge, Card, CardHeader } from '@/components/ui';
import { createClient } from '@/lib/supabase/server';
import { canWrite, requireTenant } from '@/lib/tenant';

/**
 * Conversation viewer.
 *
 * The transcript is rendered on the server (fast first paint, no loading state) and
 * the reply box is a small client island. Sender attribution is explicit — assistant
 * messages are visually distinct from a colleague's — because an owner reading back
 * a thread needs to know which words were theirs.
 */
export default async function ConversationPage({
  params,
}: {
  params: Promise<{ slug: string; conversationId: string }>;
}) {
  const { slug, conversationId } = await params;
  const tenant = await requireTenant(slug);
  const supabase = await createClient();

  const [conversationResult, messagesResult, leadResult] = await Promise.all([
    supabase
      .from('conversations')
      .select('*')
      .eq('id', conversationId)
      .eq('business_id', tenant.businessId)
      .maybeSingle(),
    supabase
      .from('messages')
      .select('id, direction, sender, body, status, created_at, sent_by_user_id')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(500),
    supabase.from('leads').select('*').eq('conversation_id', conversationId).maybeSingle(),
  ]);

  if (!conversationResult.data) notFound();

  const conversation = conversationResult.data as {
    id: string;
    status: string;
    ai_enabled: boolean;
    customer_name: string | null;
    customer_phone: string | null;
    channel: string;
    summary: string | null;
    current_topic: string | null;
    handover_reason_code: string | null;
    handover_note: string | null;
    first_response_seconds: number | null;
    opened_at: string;
  };

  const messages = (messagesResult.data ?? []) as Array<{
    id: string;
    direction: string;
    sender: string;
    body: string | null;
    status: string;
    created_at: string;
  }>;

  const lead = leadResult.data as Record<string, unknown> | null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <a
            href={`/app/${slug}/conversations`}
            className="text-[12px] hover:underline"
            style={{ color: 'var(--text-muted)' }}
          >
            ← All conversations
          </a>
          <h1 className="mt-1 text-xl font-semibold">
            {conversation.customer_name ??
              formatPhoneForDisplay(conversation.customer_phone) ??
              'Unknown caller'}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px]">
            <Badge tone={conversation.status === 'waiting_for_human' ? 'warning' : 'info'}>
              {conversation.status.replaceAll('_', ' ')}
            </Badge>
            {conversation.ai_enabled ? (
              <Badge tone="good">Assistant replying</Badge>
            ) : (
              <Badge>Assistant paused</Badge>
            )}
            <span style={{ color: 'var(--text-muted)' }}>
              {conversation.channel} · opened {new Date(conversation.opened_at).toLocaleString('en-GB')}
            </span>
          </div>
        </div>

        {canWrite(tenant.role) ? (
          <ConversationActions
            conversationId={conversationId}
            aiEnabled={conversation.ai_enabled}
            status={conversation.status}
          />
        ) : null}
      </div>

      {conversation.handover_reason_code ? (
        <div
          className="rounded-xl border-l-4 px-4 py-3 text-[13px]"
          style={{
            background: 'color-mix(in oklab, var(--status-warning) 10%, transparent)',
            borderColor: 'var(--status-warning)',
          }}
        >
          <strong className="font-semibold">
            Escalated: {conversation.handover_reason_code.replaceAll('_', ' ')}
          </strong>
          {conversation.handover_note ? <p className="mt-1">{conversation.handover_note}</p> : null}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader
            title="Transcript"
            description={`${messages.length} message${messages.length === 1 ? '' : 's'}`}
          />
          <ol className="space-y-3">
            {messages.map((message) => {
              const isCustomer = message.sender === 'customer';
              const isSystem = message.sender === 'system';

              return (
                <li
                  key={message.id}
                  className={`flex ${isCustomer ? 'justify-start' : 'justify-end'}`}
                >
                  <div
                    className="max-w-[80%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed"
                    style={{
                      background: isCustomer
                        ? 'var(--surface-2)'
                        : isSystem
                          ? 'color-mix(in oklab, var(--status-warning) 12%, var(--surface-2))'
                          : 'color-mix(in oklab, var(--brand-accent) 12%, var(--surface-2))',
                      color: 'var(--text-primary)',
                    }}
                  >
                    <div
                      className="mb-1 text-[10px] font-semibold uppercase tracking-wider"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {senderLabel(message.sender)} ·{' '}
                      {new Date(message.created_at).toLocaleTimeString('en-GB', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                      {message.status === 'failed' || message.status === 'undelivered'
                        ? ' · not delivered'
                        : ''}
                    </div>
                    <p className="whitespace-pre-wrap">{message.body ?? '(no text)'}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="What the assistant knows" />
            {conversation.summary ? (
              <p className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                {conversation.summary}
              </p>
            ) : (
              <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
                No summary yet — short threads are sent to the model in full.
              </p>
            )}
            {conversation.current_topic ? (
              <p className="mt-3 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                Topic: {conversation.current_topic}
              </p>
            ) : null}
            {conversation.first_response_seconds !== null ? (
              <p className="mt-3 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                First reply in {conversation.first_response_seconds}s
              </p>
            ) : null}
          </Card>

          <Card>
            <CardHeader title="Lead" />
            {lead ? (
              <dl className="space-y-2 text-[13px]">
                {(
                  [
                    ['Name', lead['name']],
                    ['Phone', formatPhoneForDisplay(lead['phone'] as string | null)],
                    ['Email', lead['email']],
                    ['Postcode', lead['postcode']],
                    ['Service', lead['service_text']],
                    ['Urgency', lead['urgency']],
                    ['Status', lead['status']],
                    ['Callback', lead['callback_text']],
                    ['Score', lead['score']],
                  ] as Array<[string, unknown]>
                )
                  .filter(([, value]) => value !== null && value !== undefined && value !== '')
                  .map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-3">
                      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
                      <dd className="text-right font-medium">{String(value)}</dd>
                    </div>
                  ))}
              </dl>
            ) : (
              <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
                Nothing extracted yet.
              </p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function senderLabel(sender: string): string {
  switch (sender) {
    case 'customer':
      return 'Customer';
    case 'ai':
      return 'Assistant';
    case 'human':
      return 'Your team';
    default:
      return 'System';
  }
}
