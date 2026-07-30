import { NextResponse } from 'next/server';

import {
  extractLead,
  loadBusinessContext,
  loadConversationMemory,
} from '@atwood/core';

import {
  assertBusinessScope,
  readJson,
  requireString,
  withInternalAuth,
} from '@/lib/internal-auth';

/**
 * POST /api/internal/v1/leads/extract
 *
 * Run lead extraction over a conversation and upsert the result.
 *
 * The inbound pipeline already does this on every message, so this endpoint is for
 * the off-path cases: re-extracting a finished conversation after a prompt change,
 * backfilling leads for threads that predate a schema change, or letting a
 * dashboard user force a refresh.
 *
 * Safe to call repeatedly. `upsert_lead` merges rather than replaces, so a re-run
 * can only add information — it will never blank a field the earlier pass captured.
 */
export const POST = withInternalAuth(async (request, auth) => {
  const body = await readJson<{ conversation_id?: unknown }>(request);
  const conversationId = requireString(body.conversation_id, 'conversation_id');

  const memory = await loadConversationMemory(conversationId);
  assertBusinessScope(auth, memory.business_id);

  const context = await loadBusinessContext(memory.business_id);

  const result = await extractLead({ context, memory, traceId: auth.traceId });

  return NextResponse.json({
    trace_id: auth.traceId,
    conversation_id: conversationId,
    lead_id: result.leadId,
    score: result.score,
    refused: result.refused,
    extraction: result.extraction,
  });
});
