import type { IncomingMessage } from 'node:http';

import { reconstructTwilioUrl, validateTwilioSignature } from '@atwood/core/integrations/twilio';

import { PUBLIC_ORIGIN } from './config.ts';

/**
 * Twilio signature checks for the errand endpoints (must-do 21).
 *
 * The HMAC itself is `@atwood/core`'s `validateTwilioSignature`, the one audited
 * implementation the relay and the web app already use. This file only decides which URL
 * strings to offer it, and fails closed on everything else: no auth token, no header, or a
 * mismatch is a refusal.
 *
 * **The URL is rebuilt from the fixed public origin**, never from the request's headers.
 * The errand process sits behind the tunnel on 127.0.0.1, and Twilio signs the public URL it
 * was given in the call create (`https://receptionist.atwoodsystems.co.uk/errand/...`), so
 * that origin is a constant and the request contributes only its path and query string.
 *
 * **The socket follows the relay's measured answer** (`apps/relay/src/signature.ts`, read and
 * not imported): Twilio signs the `wss://` form of the socket URL (measured on a live call,
 * 2026-09-16). The `https://` form of the same URL is offered too, at no widening — same
 * authority, same path, the token still required — and the caller logs which one matched, so
 * a change in Twilio's behaviour shows up as a log line rather than as silent failed calls.
 * An upgrade has no form body, so no parameters are offered.
 *
 * Several tokens may be offered, for the rotation window when Twilio may sign with either.
 */

export function publicUrlFor(requestUrl: string): string {
  return reconstructTwilioUrl({ requestUrl: `http://127.0.0.1${requestUrl}`, baseUrlOverride: PUBLIC_ORIGIN });
}

/** True when the signature matches the public URL and form body under any of the tokens. */
export function verifyWebhook(input: {
  signature: string | null | undefined;
  requestUrl: string;
  params: Record<string, string>;
  tokens: string[];
}): boolean {
  if (!input.signature || input.tokens.length === 0) return false;
  const url = publicUrlFor(input.requestUrl);
  let matched = false;
  // Every token is tried; core compares each in constant time.
  for (const authToken of input.tokens) {
    if (validateTwilioSignature({ signature: input.signature, url, params: input.params, authToken })) matched = true;
  }
  return matched;
}

export interface SocketSignatureResult {
  valid: boolean;
  matchedForm: 'wss' | 'https' | null;
  candidates: string[];
}

/** The socket URLs Twilio could have signed, most likely first. */
export function socketCandidates(request: Pick<IncomingMessage, 'url'>): string[] {
  const path = (request.url ?? '/').split('?')[0] || '/';
  const host = new URL(PUBLIC_ORIGIN).host;
  return [`wss://${host}${path}`, `https://${host}${path}`];
}

export function verifySocket(input: { signature: string | null | undefined; request: Pick<IncomingMessage, 'url'>; tokens: string[] }): SocketSignatureResult {
  const candidates = socketCandidates(input.request);
  if (!input.signature || input.tokens.length === 0) return { valid: false, matchedForm: null, candidates };
  for (const url of candidates) {
    for (const authToken of input.tokens) {
      if (validateTwilioSignature({ signature: input.signature, url, params: {}, authToken })) {
        return { valid: true, matchedForm: url.startsWith('wss://') ? 'wss' : 'https', candidates };
      }
    }
  }
  return { valid: false, matchedForm: null, candidates };
}
