# Owner-alert emails queued but never sent

**Reported:** 2026-09-26. On the live box, nine owner-alert email rows in
`public.notifications` for tenant VOLTA are `status = 'pending'` with
`attempts = 0`; the oldest is 29 days old.

**Method:** reasoned from code, migrations and config only. The live database,
the live n8n instance and the box's systemd units were not reachable. Every
claim below is marked either **from code** (proven by the cited lines) or
**needs the live box** (a hypothesis until someone looks).

---

## 1. The path an owner alert takes

### Enqueue — works, and runs without n8n (from code)

Owner alerts are written inline by the web app and the relay, through
`enqueueNotification` (`packages/core/src/domain/notify.ts:40`), which calls
the SQL function `enqueue_notification`
(`supabase/migrations/0009_rpc_functions.sql:462`). Call sites:

| Event | Where |
|---|---|
| `missed_call` | `packages/core/src/domain/pipeline.ts:118` |
| `new_message` (caller rang back on a handed-over thread) | `packages/core/src/domain/pipeline.ts:495` |
| `new_message` (message on a thread a human holds) | `packages/core/src/domain/pipeline.ts:535` |
| `lead_captured` / `lead_qualified` | `packages/core/src/domain/pipeline.ts:612` |
| `handover_required` | `packages/core/src/domain/pipeline.ts:687` (via `notifyHandover`, called at :385 and :566) |
| `handover_required` (internal API) | `apps/web/src/app/api/internal/v1/conversations/[conversationId]/handover/route.ts:83` |
| `appointment_booked` | `apps/web/src/app/api/internal/v1/bookings/create/route.ts:64` |

A new row takes the column defaults: `status = 'pending'`, `attempts = 0`,
`scheduled_for = now()` (`supabase/migrations/0006_notifications_ai_analytics.sql:62-66`).
The nine rows look exactly like freshly enqueued rows that nothing has touched.

### Claim and send — only one caller, and it is n8n (from code)

- The **only** code that changes `attempts` is `claim_notifications`, which sets
  `status = 'sending', attempts = attempts + 1`
  (`supabase/migrations/0009_rpc_functions.sql:540`). Nothing else in the
  repository writes that column.
- The only caller of `claim_notifications` is `drainNotifications`
  (`packages/core/src/domain/notify.ts:96`).
- The only caller of `drainNotifications` is the route
  `POST /api/internal/v1/notifications/drain`
  (`apps/web/src/app/api/internal/v1/notifications/drain/route.ts:29`).
- The only caller of that route is n8n workflow 09, on a one-minute schedule
  (`n8n/workflows/09-notification-engine.json:5,16`).

There is no Supabase edge function (`supabase/functions/` does not exist), no
`pg_cron` job, no `vercel.json` cron, no timer in the relay or the web app, and
no script that drains. (Searched for `drainNotifications`, `notifications/drain`,
`claim_notifications`, `setInterval`, `vercel.json`.)

So `attempts = 0` means one thing: **`claim_notifications` has never run while
these rows were due**. Nothing tried to send them and failed; nothing tried at all.

### Why nothing tried: n8n is documented as optional (from code)

The repository tells the operator, in four places, that the platform works with
n8n absent:

- `.env.example:137` — "Blank is the deliberate default: the handlers then call
  the internal API directly and the platform is fully functional without the
  orchestrator."
- `docs/00-architecture.md:92` — "n8n is optional".
- `docs/03-n8n-workflows.md:36`, and `README.md:144` (`pnpm n8n:up  # optional`).

That fallback is real for the *webhook* hand-off (`N8N_WEBHOOK_BASE_URL` blank
makes the Twilio routes call the internal API directly), but it has no
equivalent for the *scheduled* drain. A box run the documented way without n8n
queues every owner alert and delivers none. That is a defect in the code and
docs, not just in the box's configuration.

### Why nobody noticed (from code)

- The dashboard channel is read straight from the table and never needs
  draining (`0009_rpc_functions.sql:533`), so the in-app notifications kept
  working and hid the fact that email was dead.
- The documented monitoring query for stuck notifications was
  `status = 'pending' and attempts >= 5` (`docs/06-deployment.md`, "What to
  watch"). It cannot see never-attempted rows, and it barely sees anything:
  `drainNotifications` sets a row to `failed` once `attempts >= 5`
  (`notify.ts:131-135`), so rows rarely sit at `pending` with five attempts.
- If n8n *was* running workflow 09 but its HTTP call was failing, the node had
  `neverError: true` (`09-notification-engine.json:25` before this change). A
  401, 404 or 502 then took the "Clean run" branch, and with
  `saveDataSuccessExecution: "none"` (`:77`) no execution was kept. The DB
  symptom — rows at `attempts = 0` — is identical to n8n not running at all.

---

## 2. Most likely cause on the live box (needs the live box)

In order of likelihood, given what the code allows:

1. **No drainer is running.** n8n is not up on the box, or it is up but
   workflow 09 was never imported/activated. The only unit the repository
   ships for the box is `apps/relay/atwood-relay.service`, and the relay does
   not drain.
2. **Workflow 09 is active but its request never reaches a working drain
   route**, and `neverError` hid it. Candidates: `ATWOOD_API_URL` pointing at
   something that is not the running web app (the compose default is
   `http://host.docker.internal:3000`, `docker-compose.yml:88`; the old
   `receptionist.aaa123.uk` host now 404s on every path); or n8n's
   `INTERNAL_API_SECRET` differing from the app's (a 401).
3. **The drain runs, but against a different database** — i.e. the app that
   n8n reaches uses a different `NEXT_PUBLIC_SUPABASE_URL`/service-role key from
   the one the live traffic writes to. Less likely; worth one query to rule out.

What cannot explain `attempts = 0`: Resend being down or `RESEND_API_KEY` being
missing (either would raise `attempts` and set `last_error`), batch starvation
(the claim is oldest-first, `0009_rpc_functions.sql:535`), or the dashboard
exclusion (these are email rows). A `scheduled_for` in the future would, but
nothing in the code sets one; confirm with the first query below.

---

## 3. What was changed

- `n8n/workflows/09-notification-engine.json` — `neverError` removed, so a
  failed drain request fails the execution and is kept in n8n's history.
- `scripts/drain-notifications.mjs` — drains once via the same route, exits
  non-zero if the route is unreachable, refuses the secret, or does not answer
  JSON.
- `scripts/systemd/atwood-notify-drain.{service,timer}` — runs it every minute
  as a user unit, in the same shape as `atwood-relay.service`. Safe alongside
  workflow 09: the claim uses `FOR UPDATE SKIP LOCKED`.
- `docs/00-architecture.md`, `.env.example`, `docs/06-deployment.md` — say
  plainly that notification delivery needs one of the two drainers, and replace
  the monitoring query with ones that catch never-attempted, failed and
  stuck-in-`sending` rows.

No schema or application-code change was needed: the claim and send logic are
correct; nothing was calling them.

---

## 4. To run on the live box, in this order

**a. Confirm the diagnosis (read-only).**

```sql
-- The stuck rows: expect status pending, attempts 0, last_error null,
-- scheduled_for in the past.
select id, event, channel, destination, status, attempts, last_error,
       scheduled_for, created_at
from notifications
where status = 'pending' and attempts = 0 and channel <> 'dashboard'
order by created_at;

-- Has any email ever been sent from this database? If there are no `sent`
-- email rows at all, no drainer has ever run against it.
select channel, status, count(*), min(created_at), max(created_at),
       max(sent_at) as last_sent
from notifications group by 1, 2 order by 1, 2;
```

Then, on the box: is n8n running (`docker ps`), is workflow 09 present and
active, and do its recent executions show errors? Compare n8n's
`ATWOOD_API_URL` and `INTERNAL_API_SECRET` with the app's `.env.local`.

**b. Decide what to do with the backlog before starting any drainer.** The
first drain will email every one of the nine rows, up to 29 days late, to the
owner at once. If that is not wanted, retire them first (they remain visible
in the dashboard channel's rows):

```sql
update notifications
set status = 'suppressed',
    last_error = 'Stale: queued while no drainer was running (2026-09-26)'
where status = 'pending' and attempts = 0 and channel <> 'dashboard'
  and created_at < now() - interval '1 hour';
```

**c. Check `RESEND_API_KEY` and `NOTIFICATION_FROM_EMAIL`** are set in the env
file the web app actually loads. See 5a: a missing key currently burns five
attempts and marks each row `failed`.

**d. Start one drainer.** Either re-import and activate workflow 09, or install
the systemd timer (`docs/06-deployment.md`, "Delivering notifications without
n8n"). Run `node scripts/drain-notifications.mjs --limit 1` by hand first and
check the result line.

**e. Prove it end to end.** Trigger one real owner alert (a missed call to the
VOLTA number is the simplest), then within two minutes:

```sql
select status, attempts, last_error, sent_at
from notifications
where channel = 'email' order by created_at desc limit 3;
```

Expect `sent`, `attempts = 1`, and the email in the owner's inbox.

---

## 5. Related findings, not fixed here

a. **`not_configured` is not suppressed.** `.env.example:125-127` and
   `packages/core/src/integrations/email.ts:29-31` promise that a missing
   `RESEND_API_KEY` makes the worker suppress the row. `drainNotifications`
   does not check for it (`notify.ts:125-146`): the row is retried five times
   and marked `failed`. From code.

b. **Rows left in `sending` are never reclaimed.** `claim_notifications` only
   takes `pending` rows (`0009_rpc_functions.sql:531`). If the drain process
   dies between the claim and the status update, those rows stay `sending`
   for ever. The new monitoring query surfaces them; nothing retries them.
   From code.
