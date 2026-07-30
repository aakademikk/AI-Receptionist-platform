import {
  getAdminClient,
  logger,
  mapTwilioStatus,
  parseTwilioForm,
  requireValidTwilioSignature,
} from '@atwood/core';

import { reconstructUrl } from '../voice/route';

/**
 * POST /api/webhooks/twilio/status
 *
 * Delivery receipts. Twilio calls this as a message moves through
 * queued → sent → delivered, or fails.
 *
 * Worth wiring up rather than skipping: without it the dashboard shows "sent" for a
 * message that was never delivered, and a tenant whose number has been blocked by a
 * carrier has no way to find out. `undelivered` and `failed` are the states an owner
 * actually needs to see.
 *
 * Updates by `provider_message_id`. Receipts arrive out of order, so a terminal
 * state is never overwritten by a late-arriving intermediate one.
 */
export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  const params = parseTwilioForm(raw);

  requireValidTwilioSignature({
    signature: request.headers.get('x-twilio-signature'),
    url: reconstructUrl(request),
    params,
  });

  const messageSid = params['MessageSid'] ?? params['SmsSid'];
  const rawStatus = params['MessageStatus'] ?? params['SmsStatus'];

  if (!messageSid || !rawStatus) {
    // Nothing actionable, but a 200 stops Twilio retrying a request we will never
    // be able to use.
    return new Response(null, { status: 204 });
  }

  const status = mapTwilioStatus(rawStatus);

  const update: Record<string, unknown> = { status };
  if (status === 'delivered') update['delivered_at'] = new Date().toISOString();
  if (status === 'failed' || status === 'undelivered') {
    update['error_code'] = params['ErrorCode'] ?? null;
    update['error_message'] = params['ErrorMessage'] ?? null;
  }

  const supabase = getAdminClient();

  // Terminal states must not be walked backwards by a late receipt.
  const TERMINAL = ['delivered', 'read', 'failed', 'undelivered'];

  const { data: existing } = await supabase
    .from('messages')
    .select('id, status, business_id')
    .eq('provider_message_id', messageSid)
    .maybeSingle();

  const row = existing as { id: string; status: string; business_id: string } | null;

  if (!row) {
    // A receipt can legitimately beat the row that records the message, since the
    // send response and the first webhook race. Not an error.
    logger.debug('Delivery receipt for an unknown message', { messageSid, status });
    return new Response(null, { status: 204 });
  }

  if (TERMINAL.includes(row.status) && !TERMINAL.includes(status)) {
    return new Response(null, { status: 204 });
  }

  await supabase.from('messages').update(update).eq('id', row.id);

  if (status === 'failed' || status === 'undelivered') {
    logger.warn('Message delivery failed', {
      businessId: row.business_id,
      messageSid,
      errorCode: params['ErrorCode'],
    });
  }

  return new Response(null, { status: 204 });
}
