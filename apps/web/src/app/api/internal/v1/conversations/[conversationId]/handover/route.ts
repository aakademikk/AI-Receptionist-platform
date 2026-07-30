import { NextResponse } from 'next/server';

import {
  badRequest,
  composeHandoverBody,
  enqueueNotification,
  getAdminClient,
  loadBusinessContext,
  loadConversationMemory,
  publicEnv,
  type HandoverReason,
} from '@atwood/core';

import {
  assertBusinessScope,
  readJson,
  withInternalAuth,
  type InternalAuthContext,
} from '@/lib/internal-auth';

const VALID_REASONS: HandoverReason[] = [
  'customer_request',
  'emergency',
  'urgent',
  'complaint',
  'repeated_confusion',
  'low_confidence',
  'keyword',
  'manual',
  'ai_error',
  'out_of_scope',
];

/**
 * POST /api/internal/v1/conversations/:conversationId/handover
 *
 * Escalate a conversation to a human: mute the AI, mark it
 * `waiting_for_human`, and alert whoever the tenant has told us to alert.
 *
 * The inbound pipeline escalates on its own; this endpoint exists for the cases it
 * cannot see — a dashboard user escalating by hand, or a workflow acting on
 * something outside the message text (a lead score threshold, a scheduled SLA check).
 *
 * Idempotent: `request_handover` is a no-op on an already-escalated thread, and the
 * notification is deduplicated, so a retry cannot alert the owner twice.
 */
export const POST = withInternalAuth<{ params: Promise<{ conversationId: string }> }>(
  async (request: Request, auth: InternalAuthContext, { params }) => {
    const { conversationId } = await params;
    const body = await readJson<{ reason?: unknown; note?: unknown; notify?: unknown }>(request);

    const reason = (typeof body.reason === 'string' ? body.reason : 'manual') as HandoverReason;
    if (!VALID_REASONS.includes(reason)) {
      throw badRequest(`"reason" must be one of: ${VALID_REASONS.join(', ')}`);
    }

    const note = typeof body.note === 'string' ? body.note : null;

    const memory = await loadConversationMemory(conversationId);
    assertBusinessScope(auth, memory.business_id);

    const { data, error } = await getAdminClient().rpc('request_handover', {
      p_conversation_id: conversationId,
      p_reason: reason,
      p_note: note,
    });

    if (error) throw badRequest(`Handover failed: ${error.message}`);

    const row = (Array.isArray(data) ? data[0] : data) as {
      was_escalated: boolean;
      business_id: string;
    };

    // Only alert on a state change. Re-notifying on an already-waiting thread is
    // how an owner learns to ignore the alerts.
    if (row.was_escalated && body.notify !== false) {
      const context = await loadBusinessContext(memory.business_id);
      const lastCustomerMessage = [...memory.transcript]
        .reverse()
        .find((message) => message.sender === 'customer')?.body ?? null;

      await enqueueNotification({
        businessId: memory.business_id,
        event: 'handover_required',
        subject: reason === 'emergency' ? 'URGENT: a conversation needs you now' : 'A conversation needs you',
        body: composeHandoverBody({
          businessName: context.profile.trading_name ?? context.name,
          customerName: memory.customer_name,
          customerPhone: memory.customer_phone,
          reason: reason.replaceAll('_', ' '),
          note,
          summary: memory.summary,
          lastMessage: lastCustomerMessage,
          conversationUrl: `${publicEnv.appUrl}/app/${context.slug}/conversations/${conversationId}`,
        }),
        payload: {
          customer_name: memory.customer_name,
          customer_phone: memory.customer_phone,
          summary: memory.summary,
          reason,
          urgency: reason === 'emergency' ? 'emergency' : 'high',
          conversation_id: conversationId,
        },
        conversationId,
        dedupeKey: `handover:${conversationId}:${reason}`,
      });
    }

    return NextResponse.json({
      trace_id: auth.traceId,
      conversation_id: conversationId,
      was_escalated: row.was_escalated,
      reason,
    });
  },
);
