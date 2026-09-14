import { getAdminClient, logger, parseTwilioForm, requireValidTwilioSignature } from '@atwood/core';

import { reconstructUrl, withTwilioWebhook } from '@/lib/twilio-webhook';

/**
 * POST /api/webhooks/twilio/voice/status
 *
 * Call lifecycle events for calls *we* placed: initiated, ringing, answered,
 * completed.
 *
 * This exists because the gather callback only fires when the call was answered and
 * Twilio got as far as running the `<Gather>`. A call that rang out, hit a busy line
 * or was rejected has no gather callback at all — so without this route the most
 * common outcome of an outbound call would leave a row stuck at `queued` with no
 * outcome, and nobody would ever be able to tell a phone that never rang from one
 * that did.
 *
 * Distinct from `/api/webhooks/twilio/status`, which handles *message* receipts.
 * That route is tolerant of these (it finds no MessageSid and returns 204), but
 * tolerance is not the same as recording them.
 */
export const POST = withTwilioWebhook(async (request: Request): Promise<Response> => {
  const raw = await request.text();
  const params = parseTwilioForm(raw);

  requireValidTwilioSignature({
    signature: request.headers.get('x-twilio-signature'),
    url: reconstructUrl(request),
    params,
  });

  const callSid = params['CallSid'];
  const rawStatus = params['CallStatus'];

  // Nothing actionable, but 204 stops Twilio retrying a request we can never use.
  if (!callSid || !rawStatus) return new Response(null, { status: 204 });

  const supabase = getAdminClient();

  const { data } = await supabase
    .from('calls')
    .select('id, business_id, direction, outcome, metadata')
    .eq('provider_call_sid', callSid)
    .maybeSingle();

  const row = data as {
    id: string;
    business_id: string;
    direction: string;
    outcome: string | null;
    metadata: Record<string, unknown> | null;
  } | null;

  if (!row) {
    // An inbound call's status callback, or one that beat the row that records the
    // call. Neither is an error.
    logger.debug('Call status for an unknown call', { callSid, status: rawStatus });
    return new Response(null, { status: 204 });
  }

  const update: Record<string, unknown> = {
    call_status: rawStatus,
    metadata: {
      // Spread: this row's metadata carries the originating actor and trace id, and
      // the last event to arrive must not be the one that erases them.
      ...(row.metadata ?? {}),
      last_status_event: rawStatus,
    },
  };

  const duration = Number.parseInt(params['CallDuration'] ?? '', 10);
  if (Number.isFinite(duration)) update['duration_seconds'] = duration;

  if (params['RecordingUrl']) update['recording_url'] = params['RecordingUrl'];

  const TERMINAL = ['completed', 'busy', 'failed', 'no-answer', 'canceled'];
  if (TERMINAL.includes(rawStatus)) update['ended_at'] = new Date().toISOString();

  /*
   * The outcome, decided here only when the gather has not already decided it.
   *
   * Ordering matters: on an answered call the gather callback fires first and records
   * what was pressed; the `completed` event arrives afterwards. Overwriting that with
   * a status-derived guess would lose the only record of what the caller actually did.
   */
  if (!row.outcome) {
    if (rawStatus === 'failed') {
      update['outcome'] = 'failed';
    } else if (rawStatus === 'no-answer' || rawStatus === 'busy' || rawStatus === 'canceled') {
      update['outcome'] = 'unanswered';
    } else if (rawStatus === 'completed') {
      /*
       * Connected, then ended, with no gather callback — someone who picked up and
       * hung up before the prompt finished, most often. `no_input` is the accurate
       * description: the line was live and no keypad input reached us. It is not
       * `unanswered`, which would say nobody was ever there.
       */
      update['outcome'] = 'no_input';
    }
  }

  await supabase.from('calls').update(update).eq('id', row.id);

  logger.info('Outbound call status recorded', {
    callId: row.id,
    businessId: row.business_id,
    callSid,
    status: rawStatus,
    outcome: update['outcome'] ?? row.outcome,
  });

  return new Response(null, { status: 204 });
});
