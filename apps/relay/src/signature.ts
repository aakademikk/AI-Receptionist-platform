import type { IncomingMessage } from 'node:http';

/**
 * Signature validation for the ConversationRelay WebSocket upgrade.
 *
 * Twilio states that the handshake carries `X-Twilio-Signature` and that it uses "the
 * same verification mechanism used for standard Twilio webhooks" — but it does not
 * publish the string it signs for the WebSocket case, and a WebSocket upgrade has no
 * form body to concatenate. So the payload is the URL and nothing else.
 *
 * **ANSWERED ON A LIVE CALL, 2026-09-16 00:17 BST: Twilio signs the `wss://` form.**
 * The handshake log line reads `"signedUrlForm":"wss"`. That is measured, not inferred.
 *
 * **The `https://` candidate is kept anyway, deliberately.** It is now known not to be
 * what Twilio sends, so it does no work today — but the two forms differ only by the
 * scheme token, so offering both is not a widening of the check. `wss://host/path` and
 * `https://host/path` are the same authority and the same path, and the HMAC still
 * requires the account's auth token either way. An attacker without the token cannot sign
 * either form; an attacker with the token has no need of this endpoint.
 *
 * It stays because the cost of guessing wrong here is paid in a currency this codebase
 * has already been billed in: picking one form and being wrong fails **closed and
 * silently** — the socket is refused, the call connects and dies, and the console shows a
 * failed call that says nothing about signatures. One extra HMAC over a string we have
 * already built buys a log line instead of a mystery if Twilio's signing form ever differs
 * by edge case, or if a future proxy changes what reaches us. The log line names which one
 * matched on every successful handshake, so a divergence announces itself rather than
 * hiding.
 *
 * The validation itself is `@atwood/core`'s — the single audited implementation, already
 * covered by its own tests and already tolerant of auth-token rotation. Nothing here
 * re-implements the HMAC; this file only decides which URL strings to offer it.
 */

export interface SignatureCheckInput {
  /** The `X-Twilio-Signature` header from the upgrade request. */
  signature: string | null | undefined;
  /** The upgrade request, used to reconstruct the URL Twilio dialled. */
  request: IncomingMessage;
  /** Explicit public origin, when the derived one is known to be wrong. */
  baseUrlOverride?: string | null;
  /** Injected for tests. */
  verify: (input: { signature: string | null | undefined; url: string; params: Record<string, string> }) => boolean;
}

export interface SignatureCheckResult {
  valid: boolean;
  /** The URL string that validated, or `null` when none did. */
  matchedUrl: string | null;
  /** Every candidate offered, for the log line on failure. */
  candidates: string[];
}

/** Port Twilio reaches us on. Anything else is part of the URL it signs. */
const DEFAULT_TLS_PORT = '443';

/**
 * Authority of the upgrade request — host, plus a port when it is not the default one.
 *
 * The port handling is not cosmetic. Twilio signs the URL it dialled, so the port is part
 * of the signed string whenever it is not 443. Dropping it unconditionally builds
 * `wss://host/relay` for a request that arrived at `wss://host:8443/relay`, and the
 * signature then never matches — a failure that looks exactly like a wrong auth token and
 * would be chased in the wrong place. In production the tunnel terminates TLS on 443 and
 * this collapses to the bare host; the distinction only shows up anywhere else, which is
 * precisely where a hardcoded assumption would hide.
 */
export function requestHost(request: IncomingMessage): string | null {
  const forwarded = headerValue(request.headers['x-forwarded-host']);
  const host = forwarded ?? headerValue(request.headers.host);
  if (!host) return null;

  // A forwarded list is ordered nearest-proxy-first; the first entry is the client-facing
  // one. A trailing port on any other entry belongs to an internal hop, not to us.
  const first = host.split(',')[0]!.trim();
  if (first.startsWith('[')) {
    // IPv6 literal: the colons are inside the brackets, so only a port can follow them.
    const closing = first.indexOf(']');
    const rest = first.slice(closing + 1);
    return rest.startsWith(':') && rest.slice(1) !== DEFAULT_TLS_PORT ? first : first.slice(0, closing + 1);
  }

  const [name, port] = first.split(':');
  if (!name) return null;
  return port && port !== DEFAULT_TLS_PORT ? `${name}:${port}` : name;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * URLs Twilio could have signed, most likely first.
 *
 * `wss` leads because that is the scheme in the TwiML `url` attribute and the one a
 * straightforward implementation would sign; `https` follows because the handshake is an
 * HTTP upgrade and the underlying request is an HTTPS one.
 */
export function candidateUrls(request: IncomingMessage, baseUrlOverride?: string | null): string[] {
  const path = (request.url ?? '/').split('?')[0] || '/';

  if (baseUrlOverride) {
    const base = new URL(baseUrlOverride);
    const derived = new URL(path, base);
    return [
      `wss://${derived.host}${derived.pathname}`,
      `https://${derived.host}${derived.pathname}`,
    ];
  }

  const host = requestHost(request);
  if (!host) return [];

  return [`wss://${host}${path}`, `https://${host}${path}`];
}

/**
 * Check the handshake signature against every candidate URL.
 *
 * No query parameters are offered: our socket URL has none, and inventing a parameter set
 * to try would be guessing rather than checking. If one is ever added to the TwiML `url`,
 * it has to be threaded through here too — that is the contract, and it is stated rather
 * than left to be rediscovered.
 */
export function checkSignature(input: SignatureCheckInput): SignatureCheckResult {
  const candidates = candidateUrls(input.request, input.baseUrlOverride);

  if (!input.signature || candidates.length === 0) {
    return { valid: false, matchedUrl: null, candidates };
  }

  for (const url of candidates) {
    if (input.verify({ signature: input.signature, url, params: {} })) {
      return { valid: true, matchedUrl: url, candidates };
    }
  }

  return { valid: false, matchedUrl: null, candidates };
}
