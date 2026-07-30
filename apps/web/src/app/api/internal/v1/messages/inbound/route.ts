import { NextResponse } from 'next/server';

import {
  getAdminClient,
  handleInboundMessage,
  logger,
  mapTwilioStatus,
  sendSms,
  type CommsChannel,
} from '@atwood/core';

import {
  readJson,
  requireString,
  withInternalAuth,
  type InternalAuthContext,
} from '@/lib/internal-auth';

/**
 * POST /api/internal/v1/messages/inbound
 *
 * The conversation pipeline: record the inbound message, decide whether a human is
 * needed, generate a reply, extract the lead, notify the owner — then send.
 *
 * This is one endpoint rather than six because the steps share state and their
 * ordering is load-bearing (see `handleInboundMessage`). n8n calls it once and
 * branches on the response.
 */
export const POST = withInternalAuth(async (request: Request, auth: InternalAuthContext) => {
  const body = await readJson<{
    to_number?: unknown;
    from_number?: unknown;
    body?: unknown;
    channel?: unknown;
    provider_message_id?: unknown;
  }>(request);

  const channel: CommsChannel = body.channel === 'whatsapp' ? 'whatsapp' : 'sms';

  const result = await handleInboundMessage({
    toNumber: requireString(body.to_number, 'to_number'),
    fromNumber: requireString(body.from_number, 'from_number'),
    // An empty body is legitimate — an MMS or a WhatsApp image arrives with no text —
    // so this is not `requireString`.
    body: typeof body.body === 'string' ? body.body : '',
    channel,
    providerMessageId:
      typeof body.provider_message_id === 'string' ? body.provider_message_id : null,
    traceId: auth.traceId,
  });

  const log = logger.child({
    traceId: result.traceId,
    businessId: result.businessId,
    conversationId: result.conversationId,
  });

  const base = {
    trace_id: result.traceId,
    business_id: result.businessId,
    conversation_id: result.conversationId,
    inbound_message_id: result.inboundMessageId,
    is_new_message: result.isNewMessage,
    handover: result.handover,
    lead: result.lead,
  };

  if (!result.reply) {
    return NextResponse.json({
      ...base,
      reply_sent: false,
      reason: result.isNewMessage ? 'ai_muted_or_no_reply_needed' : 'duplicate_webhook',
    });
  }

  const supabase = getAdminClient();

  const { data: appended } = await supabase.rpc('append_message', {
    p_conversation_id: result.conversationId,
    p_direction: 'outbound',
    p_sender: result.reply.sender,
    p_body: result.reply.body,
    p_channel: result.reply.channel,
    p_provider: 'twilio',
    p_provider_message_id: null,
    p_status: 'queued',
    p_ai_log_id: result.reply.aiLogId,
  });

  const messageId = (Array.isArray(appended) ? appended[0] : appended)?.message_id as
    | string
    | undefined;

  try {
    const sent = await sendSms({
      to: result.reply.toNumber,
      from: result.reply.fromNumber,
      body: result.reply.body,
      channel: result.reply.channel === 'whatsapp' ? 'whatsapp' : 'sms',
      statusCallbackUrl: `${new URL(request.url).origin}/api/webhooks/twilio/status`,
      // Keyed on the inbound message, so a replayed n8n execution reuses the same
      // Twilio message rather than sending a second reply.
      idempotencyKey: `reply:${result.inboundMessageId}`,
    });

    if (messageId) {
      await supabase
        .from('messages')
        .update({
          provider_message_id: sent.sid,
          status: mapTwilioStatus(sent.status),
          segments: sent.segments,
          price_amount: sent.priceAmount,
          price_currency: sent.priceCurrency,
          sent_at: new Date().toISOString(),
        })
        .eq('id', messageId);
    }

    log.info('Reply sent', { messageSid: sent.sid, sender: result.reply.sender });

    return NextResponse.json({
      ...base,
      reply_sent: true,
      reply_message_id: messageId ?? null,
      reply_message_sid: sent.sid,
      reply_sender: result.reply.sender,
    });
  } catch (error) {
    if (messageId) {
      await supabase
        .from('messages')
        .update({
          status: 'failed',
          error_message: error instanceof Error ? error.message : String(error),
        })
        .eq('id', messageId);
    }
    throw error;
  }
});
