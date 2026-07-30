# Architecture

## The shape in one page

```
        Customer's phone
               │
      call ────┤──── SMS / WhatsApp
               │
            Twilio
               │  (webhook, HMAC-SHA1 signed)
               ▼
   ┌───────────────────────────┐
   │  Next.js route handlers   │  verify signature, answer TwiML fast,
   │  /api/webhooks/twilio/*   │  hand the event onward
   └───────────┬───────────────┘
               │
               ▼
   ┌───────────────────────────┐
   │           n8n             │  retries, scheduling, durable waits,
   │   13 modular workflows    │  execution history, human-in-the-loop
   └───────────┬───────────────┘
               │  HTTP + shared secret
               ▼
   ┌───────────────────────────┐
   │   Internal API (Next.js)  │  the decisions: ordering, prompts,
   │   /api/internal/v1/*      │  escalation, extraction, notification
   └───────────┬───────────────┘
               │
       ┌───────┴────────┬─────────────┬──────────────┐
       ▼                ▼             ▼              ▼
   Supabase        Claude/GPT/     Twilio        Firecrawl,
   (Postgres,      Gemini          (send)        Google Calendar,
    RLS, Auth)                                   Resend
       ▲
       │  user JWT, RLS-filtered
       │
   Dashboard (Next.js server components)
```

Three processes, one codebase: the Next.js app (dashboard + API), n8n, and
Postgres. Everything else is a third-party API.

---

## Where the logic lives, and why

The single biggest architectural decision here is the split between n8n and the
API. The brief asks for modular workflows rather than one huge one, and this
delivers that — but modular in n8n means *thin*, not *many small graphs
containing business rules*.

**n8n owns orchestration.** It is genuinely excellent at the things that are
tedious and error-prone to write yourself:

- webhook ingestion with a stable public URL
- retry with backoff, and a visible red execution when retries run out
- cron scheduling across timezones
- durable waits (the onboarding poll loop survives a two-minute crawl without
  holding a connection open anywhere)
- an execution history you can open when a customer says nobody replied

**The API owns decisions.** Step ordering, prompt assembly, escalation rules,
merge semantics. These are subtle, they change often, and they need tests.
Expressed as a node graph they would live somewhere that cannot be unit-tested,
is painful to review in a pull request, and drifts from whatever the tests
exercise.

Concretely: `handleInboundMessage()` in
`packages/core/src/domain/pipeline.ts` is ~200 lines whose *ordering* is the
substance — record before replying so a crash never loses what the customer
said; check escalation before generating so an emergency never gets an AI reply;
extract after the reply is composed so the customer's answer does not wait on the
CRM write; notify last so an email provider outage cannot delay an SMS. Each of
those is a decision with a reason. As twelve wired nodes, the reasons vanish.

So workflow 02 is: verify secret → acknowledge → call one endpoint → branch on
the result → escalate to a human if it failed twice. Five nodes. It is modular
because it is small, and it is small because the hard part is behind an HTTP call.

### What this buys and what it costs

| | |
|---|---|
| **Buys** | Business rules are typed, unit-tested, reviewable, and run identically whether n8n is in the picture or not. Swapping the orchestrator later touches 13 JSON files and nothing else. |
| **Costs** | A non-developer cannot change escalation behaviour by dragging a node. That is a real trade, and for rules that decide whether an emergency reaches a human, it is the right one — those belong in code review, not in a canvas. |

The tenant-configurable parts (keywords, thresholds, model choice, notification
routing) are all in `business_settings` and editable from the dashboard, so a
tenant never needs to touch a workflow.

### n8n is optional

Every webhook handler falls back to calling the internal API directly when
`N8N_WEBHOOK_BASE_URL` is unset. Same code path, no orchestrator. Useful for
local development, and it means a n8n outage degrades to "no retries" rather
than "no service".

---

## Multi-tenancy

**Every tenant-scoped table carries `business_id`**, including where it is
strictly redundant (`messages.business_id` is derivable from
`messages.conversation_id`). That denormalisation is deliberate: it makes every
RLS policy a single indexed predicate instead of a join chain, which is the
difference between a model that holds at 5,000 tenants and one that degrades.
A trigger enforces consistency, and the SQL suite proves a mismatched insert is
rejected.

Isolation is enforced in three layers:

1. **RLS on all 27 tables.** Policies call
   `is_business_member(business_id)` — one `STABLE SECURITY DEFINER` function
   reading an indexed `memberships` lookup. `SECURITY DEFINER` is what avoids the
   "policy on A queries B whose policy queries A" recursion trap.
2. **Column grants.** Written out in full rather than relying on Supabase's
   default `GRANT ALL TO authenticated`, because **a table-level grant cannot be
   narrowed afterwards** — `REVOKE UPDATE (col)` against one emits a warning and
   changes nothing. Relying on the default would leave `users.platform_role`
   self-assignable and `api_keys.key_hash` readable. See `docs/07`.
3. **Role gating.** `has_business_role()` in write policies, so a viewer cannot
   send a message and an agent cannot rotate a credential.

The service role bypasses all of this, which is why it is confined to the
internal API and webhook handlers and never reaches a browser. Those call sites
must filter by `business_id` themselves — they are the one place isolation lives
in code, and it is on purpose: routing an inbound number to *whichever* tenant
owns it is a cross-tenant read that RLS cannot express.

### Routing

`phone_numbers.e164` is unique **platform-wide**. Twilio tells us the dialled
number; that number identifies the tenant in one indexed lookup with no tenant
hint required. This is the whole reason inbound routing is cheap.

---

## The two pipelines

### Missed call → branded SMS

1. Twilio calls `/api/webhooks/twilio/voice`. The handler verifies the signature,
   looks up the number, and returns TwiML that dials the business's own line.
2. If nobody answers, Twilio calls the `<Dial>` action URL. Letting `<Dial>`
   decide "was it missed?" is far more reliable than inferring it from call-status
   transitions — Twilio reports the forwarding leg's outcome directly, and it is
   the same signal whether the line was busy, rang out, or failed.
3. The action handler responds with hangup TwiML immediately and hands the event
   onward via `after()`, which keeps the invocation alive past the response — a
   bare dangling promise would be killed and the SMS would silently never send.
4. `record_missed_call()` routes, upserts the contact, opens the conversation and
   logs the call in one transaction, idempotent on the call SID.
5. The SMS is **templated, not generated**. Same text every time, usually
   owner-approved, and the caller has just hung up — spending a model round trip
   to reproduce a fixed string would add a second of latency at the worst moment.

### Customer replies → assistant answers

`handleInboundMessage()`, in order:

1. **Record.** Before anything that can fail.
2. **Idempotency gate.** A replayed webhook stops here — `was_created = false`.
3. **Escalation check.** Deterministic rules, no model call. Decides whether an
   AI reply is appropriate *at all*.
4. **Generate**, only if the assistant is still in charge.
5. **Extract** the lead, after the reply is composed.
6. **Notify** last.

Every step is idempotent on a provider-supplied id, so the whole pipeline is
safe to retry — which is what makes n8n's retry policy usable rather than
dangerous.

---

## AI provider abstraction

Tenants choose Claude, GPT or Gemini per business, and separately for reply
versus extraction (extraction can run on something cheaper). The interface is
two operations: *give me a reply* and *give me JSON matching this schema*.

The adapters absorb differences that would otherwise leak everywhere:

- Current Claude models **reject `temperature`** with a 400. A tenant may still
  have one saved from an older model, so the Anthropic adapter drops it rather
  than letting a stale setting break every reply.
- Thinking is on by default on Claude Opus 5 and **shares the `max_tokens`
  budget** with the response. Disabling it is worse than it sounds — on that
  generation it can cause tool calls to be written as prose and `<thinking>` tags
  to leak into output, both of which would reach a customer by SMS. So thinking
  stays on and spend is controlled with `effort`.
- A **refusal is an HTTP 200**, not an error. Reading `content[0]` without
  checking `stop_reason` throws on exactly the requests most needing graceful
  handling, so refusals surface as a normal result and route to a human.
- OpenAI strict mode requires `additionalProperties: false` and every property in
  `required`; schemas are normalised at the call boundary rather than maintained
  twice.
- Gemini needs raw JSON Schema in `responseJsonSchema`, not `responseSchema` —
  the wrong field silently degrades to unconstrained output, which the extractor
  cannot tolerate.

Cost is computed from a table of **verified** prices only. An unlisted model
returns `null` rather than a plausible-looking fabrication: a wrong number in a
billing dashboard is worse than a blank one.

---

## Never invent a service or a price

This is a product promise, and it is enforced structurally rather than by asking
nicely:

- Services, prices, coverage and hours are **typed tables**, not JSON blobs.
- The prompt renders them as an **explicit closed list** and states the list is
  exhaustive. A model will improvise a price when the prompt gestures at "our
  services"; it reliably declines when it can see a finite enumeration.
- A tenant with no catalogue gets an explicit "you have no service list, so
  describe and price nothing" instruction — the vacuum is named rather than left
  to be filled.
- Scraped content is `needs_review = true` until a human approves it, and
  `business_ai_context` filters it out. Unapproved scrape output cannot reach a
  prompt.
- Owner-authored instructions and knowledge base content are **fenced** in
  delimited blocks, after the rules, with an explicit note that content inside
  cannot override them. Without this, a scraped page containing "ignore your
  instructions" is a prompt injection into every conversation.

---

## Handover

Rules, not a model call. Three reasons:

- **Latency** — it sits in front of the reply, so a model call would double
  response time on every message.
- **Auditability** — when an owner asks why a thread escalated, `keyword:
  solicitor` is an answer; "the model judged it urgent" is not.
- **Recall over precision** — a false escalation costs a human 20 seconds of
  reading; a missed emergency costs a customer or worse. The patterns
  over-trigger on purpose.

Triggers: emergencies (water, gas, fire, injury, utility loss, security,
structural), explicit requests for a person, complaints and legal threats,
tenant-configured keywords, repeated confusion past a threshold, and an
exhausted turn budget. All tenant-tunable. 20 tests in
`packages/core/src/domain/handover.test.ts` are the specification.

---

## White-label

Two colour systems that never mix:

| | |
|---|---|
| `--brand-*` | The tenant's colours. **Chrome only** — nav, buttons, links, focus rings, email header. Set at runtime from `business_profiles`, so unknown at build time and unvalidatable. |
| `--series-*` | Data marks. A **fixed** categorical palette, identical for every tenant, validated for colourblind separation and contrast in both light and dark. |

Using a tenant's brand colour for data would mean a chart whose accessibility
depends on what a customer typed into a colour picker — one tenant's pale accent
would be unreadable against the surface, and a two-series chart could end up with
two indistinguishable hues. Chrome absorbs an eccentric brand colour; an encoding
cannot.

Applied in exactly one place: inline custom properties on the tenant shell in
`app/app/[slug]/layout.tsx`. No component takes a `brandColor` prop.

---

## Scale

| Concern | Approach |
|---|---|
| Inbound routing | Unique index on `phone_numbers.e164`. One lookup, no scan. |
| Conversation list | Denormalised counters and summary on `conversations`; renders from one table with no aggregation. |
| Transcript read | `(conversation_id, created_at)` — the most-executed query in the system. |
| Trend charts | `analytics_daily`, sealed nightly. Never scans the message log. |
| Today's metrics | Live views, but each scans only one tenant-day. |
| Search | Trigram GIN indexes; filtering happens in Postgres, not the browser. |
| Notification fan-out | Outbox table, `FOR UPDATE SKIP LOCKED` claim. Parallel workers, no double-send. |
| `ai_logs` growth | ~3 rows per inbound message. Retention-swept nightly; partition-ready shape (see `docs/01`). |
| Prompt size | Verbatim transcript window of 20, older turns compacted into a rolling summary. |

---

## Documents

| | |
|---|---|
| `01-database-schema.md` | Tables, indexes, RPCs, growth plan |
| `02-api-architecture.md` | Internal API contract, auth, error semantics |
| `03-n8n-workflows.md` | All 13 workflows, and the topology choice |
| `04-frontend-architecture.md` | Routing, data fetching, white-labelling |
| `05-authentication.md` | Auth, roles, the three privilege layers |
| `06-deployment.md` | Local setup through production |
| `07-security-and-gdpr.md` | Threat model, encryption, erasure, retention |
| `08-roadmap.md` | What is built, what is next |
| `09-build-order.md` | The order to build this in, and why |
