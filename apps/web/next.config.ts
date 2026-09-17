import path from 'node:path';

import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  /**
   * Hosts allowed to fetch `/_next/*` dev resources.
   *
   * Next blocks cross-origin access to them by default, and "cross-origin" means
   * anything that is not the origin the dev server thinks it is being served from.
   * This app is never reached on that origin: a phone comes in through the
   * cloudflared tunnel, and the audit scripts use 127.0.0.1.
   *
   * The failure is close to invisible and cost hours. Nothing errors in the
   * browser — every chunk still returns 200, `window.next` is set, the RSC payload
   * is delivered and consumed — but the dev runtime cannot complete, so
   * `hydrateRoot` never attaches and *every* client component in the app is inert.
   * No hydration warning, no console error, no failed request. The only evidence
   * is a line in the dev server's own stdout:
   *
   *   ⚠ Blocked cross-origin request to Next.js dev resource /_next/webpack-hmr
   *
   * So: read the server log before concluding the browser is fine. Symptoms were
   * a nav menu that would not open and a "Send" button that did nothing.
   *
   * Development only — Next ignores this in a production build, where there is no
   * dev resource to protect.
   */
  allowedDevOrigins: [
    '127.0.0.1',
    'localhost',
    // The public tunnel, which is how a handset reaches this at all.
    'receptionist.atwoodsystems.co.uk',
    // The LAN and tailnet addresses used to open the dashboard from a phone.
    '192.168.178.64',
    '100.99.55.22',
  ],
  // @atwood/core ships TypeScript source with .ts import specifiers rather than a
  // build artefact, so Next compiles it as part of the app. One less build step,
  // and the dashboard and the API share exactly the same code the tests exercise.
  transpilePackages: ['@atwood/core'],
  // Traces the modules actually reachable at runtime, so the container image in
  // docker/web.Dockerfile ships those rather than all of node_modules. Ignored by
  // Vercel, which does its own tracing.
  output: 'standalone',
  // The monorepo root, so tracing follows the workspace symlink into
  // packages/core instead of stopping at apps/web.
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  experimental: {
    // The internal API and webhook handlers are the only consumers of these, and
    // they are all server-side.
    serverActions: { bodySizeLimit: '2mb' },
  },
  /**
   * The magic link GoTrue emails points at the public API origin (`[api] external_url`
   * in supabase/config.toml) — the tunnel host, so a phone can resolve it at all. But
   * the tunnel only has one door, and it opens onto this app, not onto Supabase. This
   * forwards the verification call to the local stack so the link actually resolves.
   *
   * Nothing in the app occupies `/auth/v1` — the auth callback lives at
   * `/auth/callback` — so no existing route is shadowed. Server-side Supabase calls
   * are unaffected; they keep talking to 127.0.0.1:54321 directly.
   */
  async rewrites() {
    return [
      {
        source: '/auth/v1/:path*',
        destination: 'http://127.0.0.1:54321/auth/v1/:path*',
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
