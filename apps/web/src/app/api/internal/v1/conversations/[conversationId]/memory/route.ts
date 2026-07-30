import { NextResponse } from 'next/server';

import { loadConversationMemory } from '@atwood/core';

import { assertBusinessScope, withInternalAuth } from '@/lib/internal-auth';

/**
 * GET /api/internal/v1/conversations/:conversationId/memory
 *
 * The Conversation Memory workflow: the recent transcript, the rolling summary,
 * current topic, lead status and whatever lead fields are already known.
 *
 * `known` is the field that earns this endpoint its keep — it is what stops the
 * assistant asking for a postcode it was given four messages ago.
 */
export const GET = withInternalAuth<{ params: Promise<{ conversationId: string }> }>(
  async (_request, auth, { params }) => {
    const { conversationId } = await params;
    const memory = await loadConversationMemory(conversationId);

    assertBusinessScope(auth, memory.business_id);

    return NextResponse.json({ trace_id: auth.traceId, memory });
  },
);
