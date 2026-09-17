/**
 * Shared helpers for the auth routes.
 *
 * Extracted from `auth/callback/route.ts` so the `/auth/callback` (`code`) and
 * `/auth/confirm` (`token_hash`) routes build their redirects identically. Both
 * guards are load-bearing — see each one's comment.
 */

/**
 * The origin to send the browser to once the handshake has completed.
 *
 * `url.origin` is wrong here for the same reason it is wrong for Twilio callbacks:
 * behind the tunnel `request.url` reports the origin service, so a redirect built
 * from it reads `https://localhost:3001/...` — unreachable from the handset that
 * just tapped the link. `NEXT_PUBLIC_APP_URL` is the public origin by definition,
 * and the login page already builds the callback URL from that same variable, so
 * the two cannot disagree. Falling back to the request origin keeps local runs
 * (and preview deployments, which set no override) working.
 */
export function publicOrigin(request: Request): string {
  const configured = process.env['NEXT_PUBLIC_APP_URL'];
  const origin = configured ? configured : new URL(request.url).origin;
  return origin.replace(/\/+$/, '');
}

/**
 * Only same-origin paths. Rejects `//evil.example`, `https://evil.example`, and
 * anything else that would leave our origin.
 */
export function sanitiseNext(value: string | null): string {
  if (!value) return '/app';
  if (!value.startsWith('/')) return '/app';
  // `//host` is protocol-relative and would leave the origin.
  if (value.startsWith('//')) return '/app';
  return value;
}
