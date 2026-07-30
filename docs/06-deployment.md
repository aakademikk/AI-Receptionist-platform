# Deployment

## Local

Prerequisites: Node 22+, pnpm 10+, and Docker Desktop **running**.

The Supabase CLI is a dev dependency rather than a global install, so `pnpm install`
provides it and everyone gets the same version. It publishes per-platform binaries as
optional dependencies (`@supabase/cli-windows-x64` and friends), so there is no
postinstall script for pnpm to block.

Docker is a hard requirement for `pnpm db:start` — the local stack is containers, and
without a daemon the CLI fails with `failed to connect to the docker API`.

```bash
git clone <repo> && cd atwood-systems
pnpm install

# apps/web/.env.local is read by the app; the root .env by docker compose.
# A .env.local at the repo root is read by nothing — Next.js loads env files from
# the app directory only, so a copy left at the root looks configured and is inert.
cp .env.example apps/web/.env.local
cp .env.example .env
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

`pnpm exec supabase status` prints the values; copy all three into `.env.local` and
`.env` rather than typing them.

`pnpm env:check` then confirms what the app resolves, including the mistakes that are
invisible in an editor: a duplicate key overriding the line you just fixed, a
publishable key in the service-role slot, or an env file in a directory nothing reads.

Recent CLI versions renamed the keys, so the labels do not match the variable names:

| `supabase status` | Variable |
|---|---|
| `Project URL` | `NEXT_PUBLIC_SUPABASE_URL` |
| `Publishable` — `sb_publishable_…` (was `anon key`) | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `Secret` — `sb_secret_…` (was `service_role key`) | `SUPABASE_SERVICE_ROLE_KEY` |

The **publishable** key works in either format. The **service-role** key must be the
**legacy JWT** — `pnpm exec supabase status -o env` prints it as `SERVICE_ROLE_KEY`.

`supabase-js` falls back to sending the API key as an `Authorization: Bearer` token
whenever there is no user session, which is every request the service client makes. A
legacy key is a JWT so that is fine; an `sb_secret_…` key is not, and PostgREST rejects
it with `No suitable key or wrong key type`. The library does suppress that fallback
for new-format keys — but only on its Edge Functions client, where the flag is
hardcoded and not exposed to callers.

The failure is worth recognising because of its shape: the dashboard carries on
working, since it authenticates with a real user JWT and uses the publishable key only
as an identifier. Only service-role paths break — webhooks, takeover, the internal API
— so the app looks half-alive rather than misconfigured. `pnpm env:check` flags it.

**Use `Project URL` — port 54321.** Three nearby URLs are not the API and all of them
get pasted by mistake: Studio (54323), the Storage (S3) URL ending `/storage/v1/s3`
in that same output, and `supabase.com/dashboard/project/<ref>` from the browser. Each
serves a web page, which a client parses as JSON and reports as
`Unexpected token '<'`. The app now rejects all three at boot naming the correct URL —
for the dashboard case it derives it from the project ref.

Then:

```bash
pnpm dev          # http://localhost:3000
pnpm n8n:up       # http://localhost:5678
```

Sign in at `/login` as `dev@atwood.systems`. Local mail is caught rather than
delivered — read the link at `http://localhost:54324`. The seed creates Parkfords
Property Management with two conversations, one of them escalated, so the dashboard
has something to show.

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

### Runbook: a real number against your laptop

The order matters — a number pointed at a tunnel that is not running gives Twilio a
failed webhook and you an empty log.

**1. Choose the model, and set both pairs.** `business_settings` carries two provider
columns, one for the reply and one for lead extraction. Switching only the first
leaves extraction calling the old provider, which then fails for want of an API key —
and because extraction is deliberately non-fatal, the symptom is a working assistant
that never produces a lead. Set them together:

```sql
update public.business_settings set
  ai_provider        = 'google',
  ai_model           = 'gemini-2.5-flash',
  extraction_provider = 'google',
  extraction_model   = 'gemini-2.5-flash'
where business_id = '<business-uuid>';
```

**2. Point the tenant's number at the real one.**

```sql
update public.phone_numbers set
  e164       = '+44XXXXXXXXXX',   -- the Twilio number, E.164
  forward_to = null               -- see below
where business_id = '<business-uuid>' and is_primary = true;
```

`forward_to = null` makes every call missed immediately: the TwiML is a `<Redirect>`
straight to the missed-call handler rather than a `<Dial>` that has to ring out first.
That is the fastest way to see the follow-up SMS, and a legitimate permanent
configuration for an SMS-first business. Set it to a real mobile when you want the
forward-then-fall-back behaviour.

**3. Start the tunnel, then configure Twilio** — in that order, so the URL exists
before Twilio is told about it.

```bash
cloudflared tunnel --url http://localhost:3000
```

| Twilio console field | Value |
|---|---|
| Voice → A call comes in | `POST https://<tunnel>/api/webhooks/twilio/voice` |
| Messaging → A message comes in | `POST https://<tunnel>/api/webhooks/twilio/sms` |

Leave `NEXT_PUBLIC_APP_URL` as `http://localhost:3000`. It governs magic-link
redirects, not webhooks — the status callback is derived from the inbound request's
own origin, so it follows the tunnel automatically. Changing it would break sign-in
unless the tunnel host is also added to `additional_redirect_urls` in
`supabase/config.toml`.

**4. Watch it.** A text to the number should appear in the conversation view within a
second or two, with the reply following it. If nothing arrives, Twilio's Monitor →
Logs → Errors names the failure — a 403 there means the auth token in `.env.local`
does not match the account that owns the number.

**Trial accounts** can only message numbers verified in the console. A reply that
Twilio accepts and never delivers, with error 21608 in the logs, is that limit rather
than a bug here.

WhatsApp needs a separate `phone_numbers` row with `channels =
array['whatsapp']`, pointed at the same webhook.

---

## Production

### Supabase

Create a project, then:

```bash
pnpm exec supabase link --project-ref <ref>
pnpm exec supabase db push
```

The `pnpm exec` prefix is not decoration. The CLI is a dev dependency of this repo,
not a global install, so a bare `supabase …` gives
`The term 'supabase' is not recognized` on Windows (`command not found` elsewhere).
The `pnpm db:*` scripts work without the prefix because pnpm puts
`node_modules/.bin` on PATH for scripts it runs itself.

Post-deploy checklist:

1. **Enable pgvector** in Database → Extensions if any tenant will use embeddings.
2. **Set the site URL and redirect allowlist** in Auth settings to your real
   domain, or magic links will point at localhost.
3. **Run `pnpm exec supabase db lint`** and check the advisors panel.
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
