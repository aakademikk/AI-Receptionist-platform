import { after } from 'next/server';

import {
  buildHangupTwiml,
  logger,
  parseInboundCall,
  parseTwilioForm,
  requireValidTwilioSignature,
  serverEnv,
} from '@atwood/core';

import { reconstructUrl } from '../route';

/**
 * POST /api/webhooks/twilio/voice/missed
 *
 * The `<Dial>` action callback: Twilio reports how the forwarding leg ended.
 *
 * If the call was answered there is nothing to do. If it was missed, this triggers
 * the follow-up SMS — either by handing off to n8n (the documented default, so the
 * workflow's retry and observability apply) or by running the pipeline in-process
 * when n8n is not configured.
 *
 * Either way it responds immediately with hangup TwiML. The caller has already hung
 * up or is listening to dead air; making them wait on an AI call and an SMS send
 * would be both pointless and, on Twilio's 15-second webhook timeout, a failure.
 */
export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  const params = parseTwilioForm(raw);
  const url = reconstructUrl(request);

  requireValidTwilioSignature({
    signature: request.headers.get('x-twilio-signature'),
    url,
    params,
  });

  const call = parseInboundCall(params);

  if (!call.isMissed) {
    logger.info('Call was answered; no follow-up needed', {
      callSid: call.callSid,
      dialCallStatus: call.dialCallStatus,
    });
    return twiml(buildHangupTwiml());
  }

  const startedAt = new Date().toISOString();
  const callStatus = call.dialCallStatus ?? call.callStatus;
  const n8nBase = serverEnv.n8nWebhookBaseUrl;

  /*
   * `after()` schedules work to run once the response has been flushed, and — unlike
   * a bare `void promise` — keeps the serverless invocation alive until it settles.
   * A dangling promise here would be terminated the moment we return the TwiML,
   * which on a cold path means the follow-up SMS silently never sends.
   */
  after(async () => {
    const payload = {
      to_number: call.to,
      from_number: call.from,
      call_sid: call.callSid,
      call_status: callStatus,
      started_at: startedAt,
    };

    /*
     * Both branches post the same payload to the same contract. n8n is the
     * documented default because the workflow gives us retries and an execution
     * history; without it we call our own internal API directly.
     *
     * Note the direct branch targets the API rather than calling
     * `handleMissedCall()` in-process: the pipeline deliberately returns the message
     * rather than sending it, and the route owns recording-then-sending with the
     * Twilio idempotency key. Going through HTTP keeps exactly one implementation of
     * that, at the cost of one loopback request on a path that is already async.
     */
    const target = n8nBase
      ? `${n8nBase}/webhook/atwood/incoming-call`
      : `${new URL(url).origin}/api/internal/v1/calls/missed`;

    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-atwood-secret': serverEnv.internalApiSecret,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(`${n8nBase ? 'n8n' : 'internal API'} returned ${response.status}`);
      }
    } catch (error) {
      // A dropped hand-off means no follow-up SMS — something the owner would
      // otherwise never learn about, so it must be loud.
      logger.error('Missed-call follow-up could not be dispatched', {
        callSid: call.callSid,
        via: n8nBase ? 'n8n' : 'in-process',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return twiml(buildHangupTwiml());
}

function twiml(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/xml; charset=utf-8' },
  });
}
