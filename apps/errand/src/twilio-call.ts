import {
  CALL_CREATE_TIMEOUT_MS,
  MACHINE_DETECTION,
  MAX_CALL_S,
  PUBLIC_ORIGIN,
  RING_TIMEOUT_S,
  ROBOT_NUMBER,
  STATUS_PATH,
  TWIML_PATH,
  requireTwilioBase,
} from './config.ts';
import { assertErrandId } from './store.ts';

/**
 * The errand call create (must-do 7; OPEN 3, OPEN 4; facts B1, B2).
 *
 * The one Twilio request the errand path makes. It is its own small function rather than
 * core's `placeCall` for three reasons, each of which would otherwise mean changing the
 * receptionist's code: `placeCall` has no machine detection or time limit, it falls back to
 * the global host when the base is unset, and it can record. Here:
 *
 *  * the base is `requireTwilioBase()`: the account's Dublin edge or nothing, checked before
 *    any request exists;
 *  * the call rings from the robot number, with synchronous `DetectMessageEnd` machine
 *    detection, a 30-second ring timeout and an 8-minute `TimeLimit` on every create;
 *  * the call instructions are a `Url`, not inline TwiML: with synchronous detection Twilio
 *    delivers `AnsweredBy` only on the request to the `Url` (facts B2), so inline TwiML would
 *    never learn whether a person or a machine answered;
 *  * `AsyncAmd` is never sent (absent means synchronous), and nothing that records is sent:
 *    transcript only (OPEN 11);
 *  * the request is abandoned at 15 seconds and never retried (must-do 18). A timeout is
 *    ambiguous — Twilio may have placed the call — and a retry could ring the business twice.
 *    The status callback is what settles a call whose create timed out.
 *
 * The account SID and auth token come from the environment and are never logged or returned.
 */

export const STATUS_EVENTS = 'initiated ringing answered completed';

export interface CreateCallDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export type CreateCallResult =
  | { ok: true; callSid: string }
  | { ok: false; failure: 'timeout' | 'rejected' | 'other'; status?: number; twilioCode?: unknown; message: string };

export function twimlUrlFor(errandId: string): string {
  return `${PUBLIC_ORIGIN}${TWIML_PATH}?errand=${encodeURIComponent(assertErrandId(errandId))}`;
}

export function statusUrlFor(errandId: string): string {
  return `${PUBLIC_ORIGIN}${STATUS_PATH}?errand=${encodeURIComponent(assertErrandId(errandId))}`;
}

/** The form body, exactly as facts B1 names the parameters. */
export function callParams(errandId: string, to: string): URLSearchParams {
  return new URLSearchParams({
    From: ROBOT_NUMBER,
    To: to,
    Url: twimlUrlFor(errandId),
    // Stated explicitly: the endpoint verifies a signature over the POST body.
    Method: 'POST',
    StatusCallback: statusUrlFor(errandId),
    StatusCallbackEvent: STATUS_EVENTS,
    StatusCallbackMethod: 'POST',
    MachineDetection: MACHINE_DETECTION,
    Timeout: String(RING_TIMEOUT_S),
    TimeLimit: String(MAX_CALL_S),
  });
}

export async function createErrandCall(input: { errandId: string; to: string }, deps: CreateCallDeps = {}): Promise<CreateCallResult> {
  const env = deps.env ?? process.env;
  const base = requireTwilioBase(env);
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  if (!accountSid || !authToken) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set.');
  const body = callParams(input.errandId, input.to);
  const doFetch = deps.fetch ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_CREATE_TIMEOUT_MS);
  try {
    const response = await doFetch(`${base}/Accounts/${encodeURIComponent(accountSid)}/Calls.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      return {
        ok: false,
        failure: 'rejected',
        status: response.status,
        twilioCode: payload.code,
        message: typeof payload.message === 'string' ? payload.message : response.statusText,
      };
    }
    if (typeof payload.sid !== 'string') return { ok: false, failure: 'other', message: 'Twilio answered with no CallSid' };
    return { ok: true, callSid: payload.sid };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, failure: 'timeout', message: `no answer from Twilio in ${CALL_CREATE_TIMEOUT_MS / 1000} s` };
    return { ok: false, failure: 'other', message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
