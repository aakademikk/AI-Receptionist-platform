# Deployment

## Local

Prerequisites: Node 22+, pnpm 10+, Docker, the Supabase CLI.

```bash
git clone <repo> && cd atwood-systems
pnpm install
cp .env.example .env.local && cp .env.example .env   # .env is for docker compose
```

Generate the two secrets that have no sensible default:

```bash
# INTERNAL_API_SECRET and N8N_ENCRYPTION_KEY
openssl rand -base64 48

# CREDENTIAL_ENCRYPTION_KEY — must be exactly 32 bytes
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Start the database and apply the schema:

```bash
pnpm db:start     # supabase start — Postgres, GoTrue, PostgREST, Realtime, Studio
pnpm db:reset     # migrations + seed
```

`db:start` prints the local anon and service-role keys; put them in `.env.local`
and `.env`.

Then:

```bash
pnpm dev          # http://localhost:3000
pnpm n8n:up       # http://localhost:5678
```

Sign in at `/login` as `dev@atwood.systems` — the magic link lands in Inbucket at
`http://localhost:54324`. The seed creates Parkfords Property Management with two
conversations, one of them escalated, so the dashboard has something to show.

### Verifying the schema without Supabase

```bash
./supabase/tests/validate_local.sh
```

Applies every migration to a throwaway Postgres cluster, asserts RLS coverage, and
runs the isolation and GDPR suite. Needs `initdb`, and refuses to run as root
(Postgres does) — run it as an ordinary user. Without pgvector it degrades the
embedding column to text and skips the IVFFlat index; `REQUIRE_VECTOR=1` makes that
a failure instead, which is what CI uses.

### Importing the workflows

```bash
for f in n8n/workflows/*.json; do
  docker compose exec -T n8n n8n import:workflow --input="/workflows/$(basename "$f")"
done
```

Activate them in the n8n UI. The scheduled ones (09, 11, 12) start immediately;
the webhook ones need their URLs registered with Twilio (below).

---

## Twilio

Per number, in the Twilio console or via the API:

| Setting | Value |
|---|---|
| A call comes in | `POST https://your-app/api/webhooks/twilio/voice` |
| A message comes in | `POST https://your-app/api/webhooks/twilio/sms` |
| Status callback | set automatically per message; no console config needed |

Then insert the number so inbound traffic can be routed:

```sql
insert into public.phone_numbers (business_id, e164, is_primary, forward_to, channels)
values ('<business-uuid>', '+441134960001', true, '+447700900123',
        array['sms','voice']::comms_channel[]);
```

`forward_to` is the number the call is tried on first. **Leaving it null means
every call is treated as missed**, which is a legitimate configuration (an
SMS-first business) but is worth knowing rather than discovering.

For local development, expose port 3000 with a tunnel and use that hostname —
`cloudflared tunnel --url http://localhost:3000` or ngrok. Signature verification
honours `x-forwarded-proto`, so a TLS-terminating tunnel works without changes.

WhatsApp needs a separate `phone_numbers` row with `channels =
array['whatsapp']`, pointed at the same webhook.

---

## Production

### Supabase

Create a project, then:

```bash
supabase link --project-ref <ref>
supabase db push
```

Post-deploy checklist:

1. **Enable pgvector** in Database → Extensions if any tenant will use embeddings.
2. **Set the site URL and redirect allowlist** in Auth settings to your real
   domain, or magic links will point at localhost.
3. **Run `supabase db lint`** and check the advisors panel.
4. **Confirm RLS is on for every table** — the migration does this, but it is worth
   seeing in the dashboard.
5. **Turn on PITR** on any plan that offers it.

### Web app on Vercel

Import the repo. Root directory `apps/web`; the build command is the default.

Environment variables — everything from `.env.example` except the
`docker compose only` block. `NEXT_PUBLIC_*` are inlined at build time, so a change
to one needs a redeploy, not just a restart.

`SUPABASE_SERVICE_ROLE_KEY` and `INTERNAL_API_SECRET` must be server-only. Vercel
treats any variable not prefixed `NEXT_PUBLIC_` that way, but it is worth checking
rather than assuming.

`docker/web.Dockerfile` covers non-Vercel deployments — a container platform, or a
customer who needs the whole stack inside their own VPC for data-residency reasons.
It uses `output: 'standalone'`, so the runtime layer ships only the modules Next
traced as reachable.

### n8n

n8n needs to be somewhere with a stable public URL and persistent storage. Fly.io,
Railway, or a small VM all work; `docker-compose.yml` is the reference config.

- **`N8N_ENCRYPTION_KEY` must be backed up somewhere other than the machine running
  n8n.** Losing it makes every stored credential unreadable.
- **Do not rely on `N8N_BASIC_AUTH_*`.** Those variables belonged to n8n 0.x and
  current versions ignore them silently — the editor's `AuthConfig` exposes only
  `N8N_SECURE_COOKIE` and `N8N_SAMESITE_COOKIE`, and the authentication methods are
  email, LDAP and SAML. A compose file that sets them looks protected and is not.
  What protects the instance is n8n's own owner account, which must be **claimed
  immediately on first start** — whoever loads the editor first gets it, and an n8n
  owner can read every credential the instance holds, including
  `SUPABASE_SERVICE_ROLE_KEY`. Locally, compose binds the editor to `127.0.0.1`;
  in production put it behind TLS and a reverse proxy that enforces auth of its own.
- The webhook endpoints additionally verify `x-atwood-secret`, so a leaked path is
  not a leaked capability — but that protects the workflows, not the editor.
- `WEBHOOK_URL` must be the public URL, or n8n registers webhooks against its
  internal hostname.
- `ATWOOD_API_URL` must be reachable **from inside the container**. On Docker
  Desktop that is `http://host.docker.internal:3000`; in production it is your real
  app URL.

At roughly 100k executions a day, move to queue mode (Redis plus worker
containers). The workflows need no change — they are already thin. Pruning is on by
default with a 14-day window; an unbounded execution log is the most common way an
n8n instance runs out of disk.

---

## Rollout order

The order matters, because each step's verification depends on the previous one.

1. **Supabase** — `db push`, then run `validate_local.sh` against a scratch
   database to confirm the migrations apply cleanly somewhere you can throw away.
2. **Web app** — deploy, hit `/api/health`, sign in, confirm the dashboard renders.
3. **A tenant** — create the business, profile, settings and at least one service.
   Without a service catalogue the assistant correctly refuses to describe
   anything, which looks like a bug if you have not read `docs/00`.
4. **n8n** — deploy, import, activate. Check the scheduled workflows run.
5. **One Twilio number** — configure the webhooks, insert the row, ring it from
   your own phone. This is the end-to-end test; everything before it is unit-level.
6. **Everything else** — remaining numbers, notification recipients, calendar.

---

## Operating it

### Health

- `GET /api/health` — liveness only, and deliberately does not touch the database.
  A check that queries Postgres conflates "is this process serving?" with "is the
  database reachable?", and answering them together means a brief database blip
  cycles every healthy instance — turning a recoverable incident into an outage.
- n8n `/healthz`.
- Supabase's own dashboard for database health.

### What to watch

| Signal | Query |
|---|---|
| Model failures | `select * from ai_logs where status <> 'ok' order by created_at desc` |
| Stuck notifications | `select * from notifications where status = 'pending' and attempts >= 5` |
| Overdue handovers | `select * from handover_queue where sla_breached` |
| Undelivered SMS | `select * from messages where status in ('failed','undelivered')` |
| Spend per tenant | `select business_id, sum(ai_cost_usd), sum(messaging_cost_usd) from analytics_daily where day >= current_date - 30 group by 1` |

Every log line is JSON with a `trace_id`, and the same id appears on the n8n
execution, the API response header and the `ai_logs` row — so one search reconstructs
a whole interaction.

### Rotating secrets

**`INTERNAL_API_SECRET`** — set on the app and n8n, then redeploy both. There is a
window where they disagree, so do it during quiet hours or add the new value
alongside temporarily.

**`CREDENTIAL_ENCRYPTION_KEY`** — the envelope format carries its key version, so
rotation needs no flag day:

1. Generate a new key. Move the current value to `CREDENTIAL_ENCRYPTION_KEY_V1`.
2. Set the new key as `CREDENTIAL_ENCRYPTION_KEY` and bump
   `CREDENTIAL_KEY_VERSION` to 2.
3. New writes use v2; existing v1 envelopes still decrypt.
4. Re-save each credential when convenient, then drop the old key.

**Supabase service role** — rotate in the dashboard, update the app and n8n.

### Backups

Supabase handles Postgres. Two things it does not cover:

- **`N8N_ENCRYPTION_KEY`** — back it up separately.
- **Workflow definitions** — they are in git, which is the point of committing
  them. Export deliberately after editing in the UI:
  `docker compose exec n8n n8n export:workflow --all --pretty --output=/workflows`
