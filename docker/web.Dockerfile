# =============================================================================
# Production image for the Next.js app.
#
# Only needed for deployments that are not on Vercel — a container platform, or a
# customer who needs the whole stack inside their own VPC for data-residency
# reasons. On Vercel this file is unused.
#
# Multi-stage, and it installs dependencies before copying source so a source-only
# change does not re-resolve the dependency tree. `output: standalone` in
# next.config.ts is what makes the runtime layer small: Next traces the modules
# actually reachable at runtime rather than shipping all of node_modules.
# =============================================================================

# --- Dependencies -------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

RUN corepack enable

# Only the manifests, so this layer is cached until a dependency actually changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY apps/web/package.json ./apps/web/

RUN pnpm install --frozen-lockfile

# --- Build --------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined into the browser bundle at build time, so they
# must be present here — unlike the server-only secrets, which are read at runtime.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL

ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm --filter @atwood/web build

# --- Runtime ------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# Non-root. The app needs no write access to its own filesystem.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs

EXPOSE 3000

# Reports unhealthy while the process is up but not serving, which is what a load
# balancer needs to know.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
