import { NextResponse } from 'next/server';

import { badRequest, getAdminClient, loadConversationMemory } from '@atwood/core';

import {
  assertBusinessScope,
  readJson,
  requireString,
  withInternalAuth,
} from '@/lib/internal-auth';

/**
 * POST /api/internal/v1/conversations/:conversationId/takeover
 *
 * A named human adopts the conversation. Sets `human_handling`, assigns them, and
 * mutes the AI so the customer never hears two voices.
 *
 * Separate from `/handover`: handover is the system deciding a person is needed;
 * takeover is a specific person saying "this is mine now". A thread can be taken
 * over without ever having been escalated — an owner reading along and choosing to
 * step in — which is why this is not folded into the other endpoint.
 */
export const POST = withInternalAuth<{ params: Promise<{ conversationId: string }> }>(
  async (request, auth, { params }) => {
    const { conversationId } = await params;
    const body = await readJson<{ user_id?: unknown }>(request);
    const userId = requireString(body.user_id, 'user_id');

    const memory = await loadConversationMemory(conversationId);
    assertBusinessScope(auth, memory.business_id);

    // The user must belong to the tenant. Without this check an API key holder could
    // assign a conversation to somebody in another business.
    const { data: membership } = await getAdminClient()
      .from('memberships')
      .select('role')
      .eq('business_id', memory.business_id)
      .eq('user_id', userId)
      .maybeSingle();

    if (!membership) {
      throw badRequest('That user is not a member of this business');
    }

    const { error } = await getAdminClient().rpc('take_over_conversation', {
      p_conversation_id: conversationId,
      p_user_id: userId,
    });

    if (error) throw badRequest(`Takeover failed: ${error.message}`);

    return NextResponse.json({
      trace_id: auth.traceId,
      conversation_id: conversationId,
      status: 'human_handling',
      assigned_user_id: userId,
    });
  },
);
