import { NextResponse } from 'next/server';

import {
  badRequest,
  getAdminClient,
  loadBusinessContext,
  logger,
  mapTwilioStatus,
  notFound,
  sendSms,
} from '@atwood/core';

import {
  assertBusinessScope,
  readJson,
  requireString,
  withInternalAuth,
  type InternalAuthContext,
} from '@/lib/internal-auth';

/**
 * POST /api/internal/v1/messages/send
 *
 * Send an outbound message on an existing conversation. Used by the dashboard when
 * a human takes over and replies, and by the Send SMS workflow.
 *
 * A human reply implicitly takes the conversation over: the AI must not carry on
 * talking over a colleague who has just stepped in. That happens here rather than
 * being left to the caller, because forgetting it produces two voices in one thread.
 */
export const POST = withInternalAuth(async (request: Request, auth: InternalAuthContext) => {
  const body = await readJson<{
    conversation_id?: unknown;
    body?: unknown;
    sender?: unknown;
    sent_by_user_id?: unknown;
    take_over?: unknown;
  }>(request);

  const conversationId = requireString(body.conversation_id, 'conversation_id');
  const text = requireString(body.body, 'body');
  const sender = body.sender === 'ai' ? 'ai' : body.sender === 'system' ? 'system' : 'human';
  const sentByUserId = typeof body.sent_by_user_id === 'string' ? body.sent_by_user_id : null;

  const supabase = getAdminClient();

  const { data: conversationData, error } = await supabase
    .from('conversations')
    .select('id, business_id, channel, customer_phone, phone_number_id, status')
    .eq('id', conversationId)
    .maybeSingle();

  if (error) throw badRequest(`Could not load the conversation: ${error.message}`);
  if (!conversationData) throw notFound(`Conversation ${conversationId}`);

  const conversation = conversationData as {
    id: string;
    business_id: string;
    channel: 'sms' | 'whatsapp' | 'voice' | 'web' | 'email';
    customer_phone: string | null;
    status: string;
  };

  assertBusinessScope(auth, conversation.business_id);

  if (!conversation.customer_phone) {
    throw badRequest('This conversation has no customer number to reply to');
  }

  const context = await loadBusinessContext(conversation.business_id);
  const fromNumber = context.phone_numbers.find((number) =>
    number.channels.includes(conversation.channel),
  )?.e164;

  if (!fromNumber) {
    throw badRequest(`No ${conversation.channel}-capable number is configured`);
  }

  // A human speaking mutes the AI. Default true for human senders; the caller can
  // opt out (e.g. an operator sending a one-off note without adopting the thread).
  const shouldTakeOver = sender === 'human' && body.take_over !== false;
  if (shouldTakeOver && sentByUserId) {
    await supabase.rpc('take_over_conversation', {
      p_conversation_id: conversationId,
      p_user_id: sentByUserId,
    });
  }

  const { data: appended } = await supabase.rpc('append_message', {
    p_conversation_id: conversationId,
    p_direction: 'outbound',
    p_sender: sender,
    p_body: text,
    p_channel: conversation.channel,
    p_provider: 'twilio',
    p_provider_message_id: null,
    p_status: 'queued',
    p_sent_by_user_id: sentByUserId,
  });

  const messageId = (Array.isArray(appended) ? appended[0] : appended)?.message_id as
    | string
    | undefined;

  try {
    const sent = await sendSms({
      to: conversation.customer_phone,
      from: fromNumber,
      body: text,
      channel: conversation.channel === 'whatsapp' ? 'whatsapp' : 'sms',
      statusCallbackUrl: `${new URL(request.url).origin}/api/webhooks/twilio/status`,
      // The message row id is a natural idempotency key: a retry that reuses it
      // cannot produce a second Twilio message.
      ...(messageId ? { idempotencyKey: `send:${messageId}` } : {}),
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

    logger.info('Outbound message sent', {
      traceId: auth.traceId,
      businessId: conversation.business_id,
      conversationId,
      sender,
    });

    return NextResponse.json({
      trace_id: auth.traceId,
      message_id: messageId ?? null,
      message_sid: sent.sid,
      status: mapTwilioStatus(sent.status),
      took_over: shouldTakeOver,
    });
  } catch (sendError) {
    if (messageId) {
      await supabase
        .from('messages')
        .update({
          status: 'failed',
          error_message: sendError instanceof Error ? sendError.message : String(sendError),
        })
        .eq('id', messageId);
    }
    throw sendError;
  }
});
