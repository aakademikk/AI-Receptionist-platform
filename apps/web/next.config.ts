import path from 'node:path';

import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
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
