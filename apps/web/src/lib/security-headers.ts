/**
 * Security response headers, in one place.
 *
 * `next.config.ts` sends the static ones on every path and `middleware.ts` builds the
 * per-request CSP from here, so the test in `security-headers.test.ts` checks the
 * exact values the app sends rather than a copy of them.
 *
 * Plain TypeScript with no imports on purpose: next.config.ts, the middleware and
 * `node --test --experimental-strip-types` all have to load it.
 */

/**
 * Sent by `next.config.ts` `headers()` on `/:path*`.
 *
 * HSTS is a year with no `includeSubDomains` and no `preload`: the zone also holds
 * the mail subdomains (`send.`) and whatever Colin adds later, and pinning those to
 * https is not this app's call. Cloudflare's Always Use HTTPS (ticket H1) does the
 * http to https redirect; this only stops a returning browser trying http first.
 */
export const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
];

/**
 * Report-Only until Colin has used the dashboard for a day with no violations
 * (ticket H3 step 3). Switching to enforcing is this one string, to
 * 'Content-Security-Policy'. Next reads its nonce from either header.
 */
export const CSP_REPORT_ONLY_HEADER = 'Content-Security-Policy-Report-Only';

/**
 * A fresh nonce for one request: 128 random bits, base64.
 *
 * Web Crypto and `btoa` rather than `Buffer`, so it runs in the edge runtime the
 * middleware may be given as well as in Node.
 */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The policy for one request, following Next's documented nonce pattern, cut to
 * the origin inventory in the H3 ticket.
 *
 * - script-src: the nonce plus `'strict-dynamic'`, so Next's inline bootstrap and
 *   the chunks it loads run and nothing else does. Never `'unsafe-inline'`.
 *   `'unsafe-eval'` in development only, where React uses eval for error stacks.
 * - style-src keeps `'unsafe-inline'`: React `style={{...}}` props render as style
 *   attributes on almost every element, and the tenant shell sets its brand colours
 *   that way. A nonce cannot cover an attribute, and listing one would switch
 *   `'unsafe-inline'` off.
 * - img-src allows any https host for the tenant-supplied logo URL.
 * - connect-src is same origin: the browser only talks to this app's own routes.
 * - `upgrade-insecure-requests` is left out while this is Report-Only, where
 *   browsers ignore it and log a console warning instead.
 */
export function buildContentSecurityPolicy(
  nonce: string,
  { dev = false }: { dev?: boolean } = {},
): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  return directives.join('; ');
}
