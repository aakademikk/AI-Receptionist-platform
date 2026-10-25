/**
 * ElevenLabs `register_call`, for the Amy speed test (T32a, Route B).
 *
 * The VOLTA number's Voice webhook points at a web route; that route asks ElevenLabs
 * to register the inbound call against the trial agent and returns the TwiML ElevenLabs
 * gives back, unchanged. No Twilio credentials go to ElevenLabs on this route.
 *
 * Docs: https://elevenlabs.io/docs/agents-platform/phone-numbers/twilio-integration/register-call
 * HTTP: https://elevenlabs.io/docs/api-reference/twilio/register-call
 *       POST /v1/convai/twilio/register-call, JSON body agent_id, from_number, to_number, direction.
 *
 * The logic is here, apart from the route, because the web app has no test runner.
 * `fetch` is injected so the tests never reach the network.
 */

export const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io';

/** The Amy trial agent (`Amy trial (Atwood) 2026-10-16`). */
export const ELEVENLABS_TRIAL_AGENT_ID = 'agent_7701m512068ke0tvnm2xg17kbarw';

export type RegisterCallResult =
  | { ok: true; twiml: string }
  | { ok: false; reason: 'key_absent' | 'upstream_error' | 'empty_response'; status?: number };

export interface RegisterCallInput {
  apiKey: string | undefined;
  agentId?: string;
  from: string;
  to: string;
  fetchImpl?: typeof fetch;
}

/** The last 4 characters of a call SID, which is all the log line carries. */
export function callSidTail(callSid: string): string {
  return callSid.slice(-4);
}

export async function registerElevenLabsCall(input: RegisterCallInput): Promise<RegisterCallResult> {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) return { ok: false, reason: 'key_absent' };

  const doFetch = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${ELEVENLABS_API_BASE}/v1/convai/twilio/register-call`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: input.agentId ?? ELEVENLABS_TRIAL_AGENT_ID,
        from_number: input.from,
        to_number: input.to,
        direction: 'inbound',
      }),
    });
  } catch {
    return { ok: false, reason: 'upstream_error' };
  }
  if (!response.ok) return { ok: false, reason: 'upstream_error', status: response.status };

  const text = await response.text();
  // The docs example shows the TwiML as a JSON string; the endpoint description says TwiML.
  // Accept both, and hand back the TwiML itself.
  let twiml = text;
  if ((response.headers.get('content-type') ?? '').includes('json')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'string') twiml = parsed;
    } catch {
      // not JSON after all: use the body as it came
    }
  }
  if (!twiml.trim()) return { ok: false, reason: 'empty_response' };
  return { ok: true, twiml };
}
