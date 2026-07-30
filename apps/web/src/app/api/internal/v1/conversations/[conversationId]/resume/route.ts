import { NextResponse } from 'next/server';

import { badRequest, getAdminClient, loadConversationMemory } from '@atwood/core';

import { assertBusinessScope, withInternalAuth } from '@/lib/internal-auth';

/**
 * POST /api/internal/v1/conversations/:conversationId/resume
 *
 * Hand the conversation back to the AI: clear the escalation, reset the confusion
 * counter, and re-enable replies.
 *
 * Resetting `confusion_count` matters. It is what stops a thread that was escalated
 * for repeated confusion from re-escalating on the very next message — the human has
 * presumably resolved the misunderstanding, so the count should start again.
 */
export const POST = withInternalAuth<{ params: Promise<{ conversationId: string }> }>(
  async (_request, auth, { params }) => {
    const { conversationId } = await params;

    const memory = await loadConversationMemory(conversationId);
    assertBusinessScope(auth, memory.business_id);

    const { error } = await getAdminClient().rpc('resume_ai', {
      p_conversation_id: conversationId,
    });

    if (error) throw badRequest(`Resume failed: ${error.message}`);

    return NextResponse.json({
      trace_id: auth.traceId,
      conversation_id: conversationId,
      status: 'active',
      ai_enabled: true,
    });
  },
);
