# Atwood Systems

A white-label AI receptionist platform. One shared codebase serves unlimited
businesses: a missed call becomes an SMS conversation, the conversation becomes a
qualified lead, and the owner can take over at any point.

Every tenant gets its own phone numbers, brand, opening hours, service catalogue,
FAQs, escalation rules and choice of AI model. None of that is a fork or a
deployment — it is rows.

---

## The flow

```
Missed call
  └─ Twilio → /api/webhooks/twilio/voice/missed   (signature verified, TwiML in <15s)
       └─ route number → tenant → open conversation → record call
            └─ send branded SMS: "Hi, thanks for contacting Parkfords Property
               Management. We're sorry we missed your call. How can we help today?"
                 └─ notify the owner

Customer replies
  └─ Twilio → /api/webhooks/twilio/sms
       └─ record inbound (idempotent on the Twilio message SID)
            ├─ deterministic escalation check ── emergency / human request /
            │    complaint / repeated confusion → stop the AI, alert a human,
            │    status WAITING_FOR_HUMAN
            └─ otherwise: load profile + FAQs + services + hours + memory
                 └─ generate reply (the tenant's chosen model) → send → record
                      └─ second model call extracts structured lead JSON
                           └─ upsert lead (merge, never overwrite) → notify → dashboard
```

Two model calls per turn, deliberately: prose for a human, JSON for a database. A
malformed extraction must never take the customer's reply down with it.

The assistant works from a **closed list** of the tenant's services and prices. It
cannot invent either, because it is never given the freedom to — see
`packages/core/src/prompts/receptionist.ts`.

---

## Folder structure

```
atwood-systems/
├── apps/
│   └── web/                        Next.js 15 App Router — dashboard + all HTTP surfaces
│       └── src/
│           ├── app/
│           │   ├── app/[slug]/     Tenant dashboard. Server components; RLS filters.
│           │   │   ├── page.tsx            Overview — handover queue first
│           │   │   ├── conversations/      List (server-side search) + viewer
│           │   │   ├── leads/              Score-sorted
│           │   │   ├── appointments/
│           │   │   ├── knowledge/          What the assistant was told
│           │   │   ├── analytics/          From the sealed daily rollups
│           │   │   └── settings/           Model, notifications, escalation
│           │   ├── api/
│           │   │   ├── webhooks/twilio/    voice, voice/missed, sms, status
│           │   │   ├── internal/v1/        15 endpoints — n8n and workers
│           │   │   ├── dashboard/          Browser bridge (session cookie → secret)
│           │   │   ├── revalidate/
│           │   │   └── health/
│           │   ├── login/  auth/callback/  Magic link
│           │   └── globals.css     Two token systems: --brand-* and --series-*
│           ├── components/         ui.tsx (server) + one client island
│           ├── lib/
│           │   ├── internal-auth.ts  Shared secret / tenant API key, scope check
│           │   ├── tenant.ts         requireTenant(slug), role checks
│           │   └── supabase/         server (RLS-scoped) and browser clients
│           └── middleware.ts       Session refresh + redirect only
│
├── packages/
│   └── core/                       All decisions live here, typed and tested
│       └── src/
│           ├── ai/                 provider.ts + anthropic / openai / google
│           ├── prompts/            receptionist, extraction, onboarding
│           ├── domain/
│           │   ├── pipeline.ts     handleMissedCall, handleInboundMessage
│           │   ├── context.ts      Business context + conversation memory
│           │   ├── handover.ts     Deterministic escalation detection
│           │   ├── reply.ts  lead.ts  notify.ts  booking.ts  onboarding.ts
│           ├── integrations/       twilio, email, firecrawl, google-calendar
│           ├── crypto/secrets.ts   AES-256-GCM envelopes, API key hashing
│           ├── utils/              hours, phone, sms, redact, errors, logger
│           ├── supabase/admin.ts   Service-role client (bypasses RLS — read the file)
│           ├── types/domain.ts     Domain types
│           └── env.ts              The only place process.env is read
│
├── supabase/
│   ├── migrations/                 0001–0010: enums → tenancy → profile →
│   │                               telephony → leads → notifications → audit →
│   │                               RLS → RPCs → views
│   ├── seed.sql                    Parkfords demo tenant
│   ├── tests/validate_local.sh     Applies everything to a throwaway cluster
│   ├── tests/functional.sql        Isolation, idempotency, privilege, GDPR
│   └── config.toml
│
├── n8n/workflows/                  13 importable workflows, 01–13
├── docker/web.Dockerfile           3-stage, non-root, standalone
├── docker-compose.yml              n8n + its Postgres (Supabase CLI runs its own)
├── .github/workflows/ci.yml        typecheck/test/build · database · workflow JSON
├── docs/                           Architecture and operations — index below
└── .env.example                    Every variable, with why it exists
```

The shape follows one rule: **n8n orchestrates, TypeScript decides.** Workflows are
5–8 nodes and hold retries, schedules and durable waits; step ordering, prompt
assembly and escalation rules live in `packages/core` where they can be typechecked
and unit-tested. `docs/00` and `docs/03` argue the trade-off, including what it
costs — a non-developer cannot change escalation behaviour by dragging a node.

---

## Quickstart

**Node 22+, pnpm 10+, and Docker Desktop running.** The Supabase CLI is a dev
dependency, so `pnpm install` brings it — no global install, and the whole team gets
the same version. It ships per-platform binaries as optional dependencies, so there
is no build step to approve on Windows.

Docker is not optional: `pnpm db:start` runs Postgres, Auth, PostgREST, Realtime and
Studio as containers, and without a running daemon it fails with
`failed to connect to the docker API`.

```bash
pnpm install

# The app reads apps/web/.env.local — NOT a .env.local at the repo root, which
# Next.js does not look at. Docker compose reads the root .env.
cp .env.example apps/web/.env.local
cp .env.example .env

openssl rand -base64 48                              # INTERNAL_API_SECRET, N8N_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # CREDENTIAL_ENCRYPTION_KEY

pnpm db:start        # prints the Project URL and keys — copy them in (table below)
pnpm env:check       # confirms the app resolves what you think it does
pnpm db:reset        # migrations + seed
pnpm dev             # http://localhost:3000
pnpm n8n:up          # optional; http://localhost:5678
```

`pnpm env:check` exists because every misconfiguration here shows up somewhere
unhelpful — a wrong URL as a JSON parse error at sign-in, a file in the wrong
directory as a missing variable you can plainly see. It resolves the files exactly as
Next.js does and reports what the app will actually see, masking secrets. Run it
before `pnpm dev` whenever something looks wrong.

**Take the three Supabase values from `pnpm exec supabase status`**, rather than
typing them. Recent CLI versions label them differently from the variable names here:

| `supabase status` | `.env.local` |
|---|---|
| **Project URL** (`http://127.0.0.1:54321`) | `NEXT_PUBLIC_SUPABASE_URL` |
| **Publishable** `sb_publishable_…` (older CLIs: `anon key`) | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| **Secret** `sb_secret_…` (older CLIs: `service_role key`) | `SUPABASE_SERVICE_ROLE_KEY` |

Use the **Project URL**. Three other URLs in that output and in your browser are not
the API — Studio (54323), the Storage (S3) URL ending in `/storage/v1/s3`, and the
`supabase.com/dashboard/project/…` address. The app rejects all three at boot and
names the one to use, but they are easy to grab by accident.

Sign in at `/login` as `dev@atwood.systems`. The magic link is never really sent
locally — read it at `http://localhost:54324`. The seed ships Parkfords Property
Management with two conversations — one of them escalated — so the dashboard has
something to show.

Full walkthrough, Twilio and n8n wiring, and production deployment:
[`docs/06-deployment.md`](docs/06-deployment.md).

### Verifying the database without Docker

```bash
./supabase/tests/validate_local.sh
```

Applies all ten migrations to a throwaway Postgres cluster, asserts that every
tenant-scoped table has RLS and policies, then runs the functional suite: tenant
isolation, hot-path idempotency, merge-not-overwrite extraction, privilege gating,
GDPR erasure with aggregates preserved. Needs `initdb` and refuses to run as root.
This is what CI runs.

```bash
pnpm typecheck && pnpm test && pnpm build
```

---

## Documentation

| | |
|---|---|
| [`00-architecture.md`](docs/00-architecture.md) | System shape, the n8n-vs-TypeScript boundary, request paths, failure modes |
| [`01-database-schema.md`](docs/01-database-schema.md) | 27 tables, 7 views, 13 RPCs, the denormalised `business_id`, indexes |
| [`02-api-architecture.md`](docs/02-api-architecture.md) | Three surfaces, three auth models, error semantics as a contract |
| [`03-n8n-workflows.md`](docs/03-n8n-workflows.md) | All 13 workflows, retry counts and why they differ, conventions |
| [`04-frontend-architecture.md`](docs/04-frontend-architecture.md) | Server components, white-labelling, the two colour systems |
| [`05-authentication.md`](docs/05-authentication.md) | Magic link, memberships, roles, the four credential types |
| [`06-deployment.md`](docs/06-deployment.md) | Local, Vercel, Docker, Twilio, backups, runbook |
| [`07-security-and-gdpr.md`](docs/07-security-and-gdpr.md) | RLS model, encryption, prompt injection, DSARs, retention |
| [`08-roadmap.md`](docs/08-roadmap.md) | What is built, **what is not**, and the phases after |
| [`09-build-order.md`](docs/09-build-order.md) | The order to rebuild this in, and what to do differently |

Start with `00`. If you are picking this up to extend it, read `08` second — it
states the boundaries of the deliverable rather than leaving them to be discovered.

---

## Security posture, briefly

Row Level Security on all 27 tables, `FORCE` on the four holding customer data, and
**explicit column grants** rather than the default `GRANT ALL TO authenticated` — a
table-level grant cannot be narrowed afterwards, so `users.platform_role` would
otherwise be self-assignable and `api_keys.key_hash` readable. Messages are
append-only for tenant users.

Twilio webhooks verify the HMAC signature against a URL reconstructed from
`x-forwarded-proto`, compared in constant time. Tenant credentials are AES-256-GCM
envelopes with a versioned key prefix. Audit triggers record changed keys only.
Scraped and owner-supplied content is fenced inside delimited blocks placed after
the rules, and unreviewed knowledge never reaches a prompt.

Details, including the reasoning behind each choice, in
[`docs/07-security-and-gdpr.md`](docs/07-security-and-gdpr.md).

---

## Status

Database, domain core, API, dashboard, workflows and infrastructure are built and
verified: 10/10 migrations apply cleanly with the functional suite passing, 52 unit
tests green, both packages typecheck, `next build` succeeds, all 13 workflow JSONs
validate.

Not built, stated plainly rather than by omission: the onboarding review UI,
knowledge and service editing, a Realtime conversation viewer, analytics trend
charts, push notifications, billing, number provisioning through the UI, MFA,
voicemail transcription, and a public tenant API. [`docs/08-roadmap.md`](docs/08-roadmap.md)
covers where each one stands and what it would take.
