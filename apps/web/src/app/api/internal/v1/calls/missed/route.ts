import { NextResponse } from 'next/server';

import {
  getAdminClient,
  handleMissedCall,
  logger,
  mapTwilioStatus,
  sendSms,
} from '@atwood/core';

import {
  readJson,
  requireString,
  withInternalAuth,
  type InternalAuthContext,
} from '@/lib/internal-auth';

/**
 * POST /api/internal/v1/calls/missed
 *
 * The missed-call pipeline. n8n's "Incoming Call" workflow posts here once Twilio
 * reports the forwarding leg went unanswered.
 *
 * Sends the SMS itself rather than returning it for n8n to send. The alternative
 * (return the body, let n8n send, then call back to record it) has a window where
 * the message is delivered but unrecorded — and a customer holding an SMS the
 * dashboard has never heard of is the worst of the available failure modes.
 */
export const POST = withInternalAuth(async (request: Request, auth: InternalAuthContext) => {
  const body = await readJson<{
    to_number?: unknown;
    from_number?: unknown;
    call_sid?: unknown;
    call_status?: unknown;
    started_at?: unknown;
  }>(request);

  const result = await handleMissedCall({
    toNumber: requireString(body.to_number, 'to_number'),
    fromNumber: requireString(body.from_number, 'from_number'),
    callSid: typeof body.call_sid === 'string' ? body.call_sid : null,
    callStatus: typeof body.call_status === 'string' ? body.call_status : null,
    startedAt: typeof body.started_at === 'string' ? body.started_at : null,
    traceId: auth.traceId,
  });

  const log = logger.child({
    traceId: result.traceId,
    businessId: result.businessId,
      conversationId: result.conversationId,
  });

  if (!result.reply) {
    return NextResponse.json({
      trace_id: result.traceId,
      business_id: result.businessId,
      conversation_id: result.conversationId,
      call_id: result.callId,
      is_new_call: result.isNewCall,
      sms_sent: false,
      // Tells n8n why nothing was sent, so a quiet no-op is not mistaken for a bug.
      reason: result.isNewCall ? 'sms_disabled_or_no_number' : 'duplicate_webhook',
    });
  }

  const supabase = getAdminClient();

  // Record as queued first. If the Twilio call then fails, the message exists in a
  // failed state and is visible; recording after a successful send would lose any
  // message whose send succeeded but whose write did not.
  const { data: appended } = await supabase.rpc('append_message', {
    p_conversation_id: result.conversationId,
    p_direction: 'outbound',
    p_sender: 'ai',
    p_body: result.reply.body,
    p_channel: result.reply.channel,
    p_provider: 'twilio',
    p_provider_message_id: null,
    p_status: 'queued',
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
      statusCallbackUrl: statusCallbackUrl(request),
      // Twilio-side idempotency, keyed on the call: an n8n retry cannot double-text.
      idempotencyKey: `missed-call:${result.callId}`,
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

    await supabase
      .from('calls')
      .update({ followup_sent_at: new Date().toISOString() })
      .eq('id', result.callId);

    log.info('Missed-call follow-up SMS sent', { messageSid: sent.sid });

    return NextResponse.json({
      trace_id: result.traceId,
      business_id: result.businessId,
      conversation_id: result.conversationId,
      call_id: result.callId,
      is_new_call: result.isNewCall,
      sms_sent: true,
      message_id: messageId ?? null,
      message_sid: sent.sid,
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

/**
 * Absolute URL for the delivery-receipt webhook.
 *
 * Derived from the incoming request so it is correct in preview deployments as well
 * as production, where the host differs per branch.
 */
function statusCallbackUrl(request: Request): string | undefined {
  try {
    const url = new URL(request.url);
    return `${url.origin}/api/webhooks/twilio/status`;
  } catch {
    return undefined;
  }
}
