import {
  callSidTail,
  logger,
  parseInboundCall,
  parseTwilioForm,
  registerElevenLabsCall,
  requireValidTwilioSignature,
} from '@atwood/core';

import { reconstructUrl, withTwilioWebhook } from '@/lib/twilio-webhook';

/**
 * POST /api/webhooks/twilio/elevenlabs-trial
 *
 * The Amy speed test's ElevenLabs variant (T32a, Route B). Inert until the VOLTA number's
 * Voice URL is pointed here by hand (T32). It checks the Twilio signature, asks ElevenLabs
 * to register the call against the trial agent, and returns the TwiML ElevenLabs gives back
 * without touching it. The logic lives in `@atwood/core` (`registerElevenLabsCall`), where it
 * is tested.
 *
 * `ELEVENLABS_API_KEY` is read from the environment only. Absent, the route answers 503 and
 * says so in the log; it never throws.
 */
export const POST = withTwilioWebhook(async (request: Request): Promise<Response> => {
  const raw = await request.text();
  const params = parseTwilioForm(raw);

  requireValidTwilioSignature({
    signature: request.headers.get('x-twilio-signature'),
    url: reconstructUrl(request),
    params,
  });

  const call = parseInboundCall(params);
  const sid = callSidTail(call.callSid);

  const result = await registerElevenLabsCall({
    apiKey: process.env.ELEVENLABS_API_KEY,
    from: call.from,
    to: call.to,
  });

  if (!result.ok) {
    if (result.reason === 'key_absent') {
      logger.error('ElevenLabs trial route: ELEVENLABS_API_KEY is not set, answering 503', { callSidTail: sid });
    } else {
      logger.error('ElevenLabs trial route: register_call failed', {
        callSidTail: sid,
        reason: result.reason,
        status: result.status,
      });
    }
    return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
      status: 503,
      headers: { 'content-type': 'text/xml; charset=utf-8' },
    });
  }

  logger.info('ElevenLabs trial call registered', { callSidTail: sid });
  return new Response(result.twiml, {
    status: 200,
    headers: { 'content-type': 'text/xml; charset=utf-8' },
  });
});
