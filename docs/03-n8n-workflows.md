# n8n workflow architecture

13 workflows in `n8n/workflows/`, each importable on its own. CI validates every
file parses and that every connection names a node that exists — a dangling
reference imports without complaint and then fails at runtime, which is the worst
time to find out.

```bash
# Import all of them
for f in n8n/workflows/*.json; do
  docker compose exec -T n8n n8n import:workflow --input="/workflows/$(basename "$f")"
done
```

---

## The topology choice

Twilio's webhook has a 15-second timeout and needs a synchronous TwiML answer.
That single constraint drives the whole shape.

**Chosen: Twilio → Next.js → n8n → internal API.**

The Next.js route verifies the signature (fast, no external hop) and answers
Twilio inside the timeout, then hands the event to n8n. n8n adds retries, an
execution history, and a visible red run when something breaks.

The alternatives, and why not:

| Alternative | Problem |
|---|---|
| Twilio → n8n directly | n8n webhooks are unauthenticated by default and cannot verify a Twilio signature without a Code node reimplementing HMAC. The endpoint becomes a way to forge customer messages and bill the tenant for the AI reply. |
| Twilio → Next.js only, no n8n | Loses retries, scheduling, durable waits and per-execution history. The brief also asks for n8n, and rightly — an owner asking "why did nobody reply?" needs something to look at. |
| Everything in n8n nodes | Puts step ordering, prompt assembly and escalation rules somewhere untestable and painful to review. See `docs/00`. |

`N8N_WEBHOOK_BASE_URL` being unset makes every handler call the internal API
directly instead. Same code path, no orchestrator — so an n8n outage degrades to
"no retries", not "no service".

Every webhook-triggered workflow verifies `x-atwood-secret` in its first IF node,
because an n8n webhook path is otherwise open to anyone who learns it.

---

## The workflows

### Entry points

**01 Incoming Call** — missed call → branded SMS. 7 nodes: verify secret → call
`/calls/missed` → branch on result. 3 retries with 2s backoff, safe because the
endpoint is idempotent on the call SID.

**02 Incoming Message** — the conversation loop. 8 nodes, and the important detail
is that it **acknowledges with 202 before generating**. A model call can outlast
Twilio's timeout; a timeout makes Twilio retry; a retry arriving mid-generation is
how a customer receives two different answers.

Only **2 tries** here, not 5. Idempotency makes retrying safe, but a reply that
lands 90 seconds late is worse than one that never lands — a stale answer confuses
the customer. After two attempts the conversation is **escalated to a human**
rather than left silent. That branch is the most important node in the file: a
technical failure becomes a handover, not silence.

**13 Onboarding** — website URL → draft profile. Uses a Wait node to make a
durable poll loop; n8n persists the execution between waits, so a two-minute crawl
holds no connection open anywhere. 8-second interval — fast enough that the owner
sees the page count tick up, slow enough not to hammer Firecrawl's status endpoint.

### Shared sub-workflows

Called via Execute Workflow, not HTTP, so they compose without a network hop.

**03 Send SMS** — anything that needs to say something to a customer calls this,
so recording-then-sending and the Twilio idempotency key live in one place.
`take_over: false` — a workflow-sent message is the assistant speaking and must
not mute the assistant; only a human reply from the dashboard does that.

**04 Business Loader** — one call to `/businesses/:id/context`. Also serves as the
Knowledge Loader: published FAQs and policies arrive in the same payload. For a
typical small business the whole corpus is small enough to send wholesale, and
wholesale beats retrieval — a missed retrieval means the assistant says "I don't
know" about something the owner explicitly documented.

The last node flattens the handful of fields other workflows branch on to the top
level, so an IF node reads `{{ $json.booking_enabled }}` rather than a deep path.

**05 Knowledge Loader** — targeted trigram search, for tenants whose corpus has
outgrown being sent wholesale. Most never need it.

The metacharacter strip in the `or` filter is load-bearing: an unescaped comma in a
customer message breaks out of the PostgREST filter list, which is
filter-injection, not merely a bad result.

**06 Conversation Memory** — transcript window, rolling summary, topic, and
`known` lead fields. `known` is what stops the assistant asking for a postcode it
was given four messages ago.

**07 AI Response** — loads context and memory **in parallel**, checks the
assistant is still in charge, then generates. Split out so a reply can be produced
for review or replayed after a prompt change without texting anyone.

**08 Lead Extractor** — a separate model call from the reply. Prose for a human
vs JSON for a database; a malformed JSON block must never take the customer's reply
down with it. Safe to re-run because `upsert_lead` merges.

**10 Booking Engine** — two modes in one workflow because they are two halves of
one exchange. No `chosen_start`: return real availability. With it: book.

Booking is **not retried** — a 422 means the slot went, and retrying will not bring
it back. The failure branch texts the customer, because silence after a failed
booking is the worst outcome: they believe they are booked in.

### Scheduled

**09 Notification Engine** — every minute. A handover alert 60 seconds late is
fine; 15 minutes late is not. The claim uses `FOR UPDATE SKIP LOCKED`, so
overlapping ticks take disjoint batches — no singleton flag, no lock file.

`saveDataSuccessExecution: none`, because 1,440 successful runs a day is noise.
Failures are kept.

**11 Dashboard Sync** — the dashboard does not need syncing in the usual sense: it
reads Postgres directly, so an inbound SMS is visible on the next request with no
workflow involved. (A Realtime subscription would remove that reload; it is not
built — see `docs/08`.) This workflow covers the two things that genuinely need a
scheduler:

- **SLA chasing.** A conversation escalated at 4pm and still unanswered at 4:20
  needs chasing, and nothing else in the system notices the passage of time. The
  dedupe key is namespaced per 30-minute bucket, so the owner is chased *again as
  it gets worse* rather than every five minutes forever — an alert that repeats
  identically is an alert people mute.
- **CDN invalidation**, for deployments that cache dashboard pages.

**12 Analytics** — nightly at **02:15 UTC**, not midnight: tenants span timezones,
so this must run late enough that yesterday has closed for the westernmost tenant.
The SQL still evaluates each day boundary in the tenant's own timezone, so one run
seals the right 24 hours for Leeds and for Sydney.

Rollup then retention sweep, sequentially — rolling up before deleting means the
aggregates survive the data they came from.

---

## Conventions

**Secrets are `$env.*`, never inline.** That is what makes the JSON in this
directory safe to commit. `docker-compose.yml` passes
`N8N_BLOCK_ENV_ACCESS_IN_NODE: 'false'`; without it every expression above fails
with an opaque "access to env vars is denied".

**`neverError: true` on every HTTP node.** A 4xx then reaches the next IF node as
data rather than failing the execution, so retries apply only to genuine 5xx and
network faults. Without it, n8n retries validation errors.

**Retry counts reflect consequence, not habit.** 3 for missed calls (a late SMS is
still useful), 2 for replies (a late reply is worse than none), 0 for bookings (the
slot is gone).

**Every node has a `notes` field explaining why it exists.** The canvas is read by
whoever is on call at 2am; a node called "HTTP Request" with no note is a puzzle.

**`saveDataErrorExecution: all` everywhere.** The failed execution is the artefact
worth keeping.

---

## Operational notes

**Volume.** At 1,000 tenants averaging 20 conversations a day with 6 messages
each, that is ~120k executions a day. The single n8n container in
`docker-compose.yml` will not carry that: move to queue mode (Redis + workers)
before it becomes urgent. The workflows need no change — they are already thin.

**Pruning.** `EXECUTIONS_DATA_PRUNE` is on with a 14-day window. An execution log
that grows unbounded is the most common way an n8n instance runs out of disk.

**`N8N_ENCRYPTION_KEY`.** Losing it makes every stored n8n credential unreadable.
Back it up somewhere other than the machine running n8n.

**The workflow files are mounted read-only** in compose, so git stays the source of
truth and n8n cannot silently rewrite what is committed. Export deliberately:

```bash
docker compose exec n8n n8n export:workflow --all --pretty --output=/workflows
```
