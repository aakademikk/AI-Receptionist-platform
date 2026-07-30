# Database schema

Postgres 15+ on Supabase. Migrations in `supabase/migrations`, applied in
filename order. Verified end-to-end by `supabase/tests/validate_local.sh`, which
applies every migration to a throwaway cluster, asserts RLS coverage, and runs
the functional suite.

```bash
./supabase/tests/validate_local.sh     # migrations + RLS coverage + isolation + GDPR
pnpm db:reset                          # local Supabase, with seed data
```

---

## The organising principle

**Every tenant-scoped table carries `business_id`.** Including where it is
redundant: `messages.business_id` is derivable through `conversation_id`, and is
stored anyway.

That denormalisation is the load-bearing decision in this schema. It makes every
RLS policy a single indexed predicate:

```sql
using (public.is_business_member(business_id))
```

rather than a join chain that Postgres must plan on every row of every query. A
trigger (`messages_after_insert`) rejects a mismatch, and the functional suite
proves it:

```
FAIL: cross-tenant message insert was allowed   ← the test that guards this
```

---

## Tables

### Tenancy — `0002_tenancy.sql`

| Table | Purpose |
|---|---|
| `businesses` | Tenant root. Slug, status, plan, timezone, `default_region` (for phone parsing), currency. |
| `users` | Mirror of `auth.users`. Kept separate so we never write to the auth schema and profile reads need no elevated privilege. Auto-provisioned by trigger on signup. |
| `memberships` | `(business_id, user_id, role)`. **The single source of truth for RLS.** Many-to-many so an agency can manage several clients. |
| `invitations` | Pending members with no `auth.users` row yet. Token stored hashed. |
| `integration_credentials` | Per-tenant third-party secrets, AES-256-GCM envelopes. Opaque to the database. |
| `api_keys` | Hashed keys for machine access. `business_id NULL` = platform-scoped. |

Roles: `owner` > `admin` > `agent` > `viewer`. Separately, `users.platform_role`
marks Atwood staff — deliberately *not* a tenant role, and not in the column grant
list, so nobody can promote themselves.

### Profile and knowledge — `0003_profile_and_knowledge.sql`

Split three ways rather than one wide table, because these are changed by
different people at different cadences:

- **`business_profiles`** — identity, contact, branding, AI voice. 1:1, auto-created
  by trigger so nothing downstream needs null-handling.
- **`business_settings`** — behaviour switches: model selection, escalation rules,
  notification preferences, booking config, retention.
- **`services`, `service_areas`, `opening_hours`, `opening_hours_overrides`,
  `knowledge_items`** — the corpus.

**Services are a typed table, not JSON.** This is the mechanism behind "never
invent a service or a price": the prompt builder can only enumerate a closed list
if a closed list exists. `price_text` is text, not numeric, because real
businesses say "from £45/unit/month" and "POA" — a numeric column would force
precision we do not have. `price_from`/`price_to` exist alongside for filtering.

`knowledge_items` uses one `kind` discriminator (faq / policy / about / general /
document / hours_note / pricing_note) so retrieval is a single query regardless of
source. It carries a nullable `vector(1536)` embedding and an IVFFlat index —
unused by default, available for tenants whose corpus outgrows trigram matching.

`needs_review` is the important flag. Firecrawl-created rows are `true` and
`business_ai_context` filters them out, so **unapproved scrape output cannot reach
a prompt**.

### Telephony and conversations — `0004_telephony_and_conversations.sql`

| Table | Notes |
|---|---|
| `phone_numbers` | `e164` unique **platform-wide** — the routing key. One indexed lookup maps a dialled number to a tenant with no tenant hint. |
| `contacts` | Not in the brief's list; earns its place twice. Dedupes repeat callers (so the assistant can acknowledge one, and the dashboard can show history), and makes GDPR erasure a single-row anchor rather than a scan across four tables. |
| `calls` | Every inbound attempt. `is_missed` drives the SMS workflow and the dashboard metric. Kept distinct from conversations because one caller may ring three times before replying. |
| `conversations` | The unit both the AI and the dashboard work on. |
| `messages` | Append-only transcript. |

`conversations` carries denormalised counters (`message_count`, `inbound_count`,
`ai_turn_count`, `first_response_seconds`, `last_message_at`, `summary`,
`lead_status`) so the list view renders from one table with no aggregation. All
maintained by trigger rather than application code — that way they are correct
whichever path wrote the message: internal API, n8n, or a manual SQL fix.

`first_response_seconds` is computed in that trigger, once, and is the headline
dashboard metric.

**Idempotency** lives in a partial unique index:

```sql
create unique index messages_provider_id_idx
  on public.messages (business_id, provider_message_id)
  where provider_message_id is not null;
```

Twilio retries webhooks it believes failed. Without this, a retry sends the
customer a second reply.

### Leads and appointments — `0005_leads_and_appointments.sql`

`leads` is **one row per conversation** (`unique (conversation_id)`), upserted
after each inbound message. Modelling it as an upsert target rather than an
append-only extraction log means the dashboard always reads the latest, most
complete picture with no aggregation; the per-run raw output is preserved in
`ai_logs` for debugging.

`completeness` is derived by trigger, not by the model — a model asked to score
its own output gives inconsistent numbers across runs. `score` (0–100) is computed
in TypeScript for the same reason: "higher is more worth ringing" must mean the
same thing on Tuesday as it did on Monday.

`appointments` links to the calendar provider via `provider_event_id`, and
booking one moves the lead to `booked` by trigger so an owner never does it by
hand.

### Notifications, AI logs, analytics — `0006`

`notifications` is an **outbox**, not a send log. `dedupe_key` is unique per
tenant, which is what stops a flapping workflow texting the owner eleven times
about the same lead. `notification_recipients` handles routing — the owner gets
handovers by SMS while the office manager gets everything by email.

`ai_logs` is one row per model call: provider, model, tokens, cost, latency,
stop reason, and a **redacted** prompt/response. Redaction matters: an unredacted
prompt is a second copy of the customer's personal data in an observability table
that support engineers browse.

`analytics_daily` is the sealed nightly rollup. Trend charts read it; "today"
reads live views. This is the difference between an analytics page that stays fast
at two million messages and one that does not.

### Audit, onboarding, GDPR — `0007`

`audit_logs` is append-only (SELECT-only policy; writes arrive via `SECURITY
DEFINER` triggers). It stores **only changed keys**, not whole rows, which keeps
it small and makes diffs readable. Attached to the tables where "who changed
this?" is a question someone will actually ask — deliberately *not* to
`messages`/`ai_logs`, which are already append-only records and would double
storage for no information gain.

`onboarding_jobs` is a durable job because a crawl takes 30–120s and the owner
must be able to close the tab. `raw_pages` is kept so re-extraction after a prompt
change costs no further crawl credits. `extracted` vs `applied` preserves the diff
between what the model drafted and what the owner approved — the clearest
available signal for improving the extraction prompt.

`gdpr_requests` makes the compliance story defensible: every request has a
requester, a timestamp, an operator and an outcome.

---

## RPCs — `0009_rpc_functions.sql`

These exist because the alternative — n8n issuing four sequential HTTP calls that
each touch one table — is not atomic.

| Function | Guarantee |
|---|---|
| `resolve_inbound` | Number → tenant, upsert contact, find-or-open conversation. Reusing an open thread is what makes the assistant feel like it remembers the customer. |
| `append_message` | Idempotent on `(business_id, provider_message_id)`. Returns `was_created` so a caller knows to stop rather than reply twice. |
| `record_missed_call` | Idempotent on the call SID. |
| `upsert_lead` | **Merge, never overwrite**: every field is `coalesce(new, existing)`, so a later extraction that fails to restate the postcode cannot erase it. Won/lost/booked never walks backwards. Coerces a bad enum to a default rather than aborting. |
| `request_handover` | Idempotent — a second trigger on an escalated thread is a no-op, so an owner is not alerted twice. |
| `enqueue_notification` | Fans one event to subscribed recipients; dedupe key namespaced per recipient, so two people both get told and neither gets told twice. |
| `claim_notifications` | `FOR UPDATE SKIP LOCKED`. Parallel workers, disjoint batches. |
| `rollup_analytics_daily` | Idempotent upsert. Day boundaries in the **tenant's own timezone**. |
| `erase_contact` | GDPR. Anonymises rather than deletes. |
| `purge_expired_data` | Batched retention sweep. |

All are `SECURITY DEFINER` and granted to `service_role` only — the last block of
`0009` revokes them from `public`, `anon` and `authenticated`. The functional
suite asserts an authenticated session gets `insufficient_privilege`.

One implementation note worth knowing: several use
`#variable_conflict use_column`. Their `RETURNS TABLE` names (`business_id`,
`contact_id`) collide with real column names, which makes a bare reference inside
`ON CONFLICT` ambiguous. Without the directive, `resolve_inbound` fails at runtime
with `column reference "business_id" is ambiguous` — found by the functional test,
not by reading.

---

## Views — `0010_views.sql`

All `security_invoker = true`, so the caller's RLS applies and a view can never
become a way around tenant isolation. The functional suite asserts each one is
tenant-scoped.

| View | Purpose |
|---|---|
| `business_ai_context` | **One row containing everything the prompt builder needs** — profile, settings, services, areas, hours, published knowledge, numbers, pre-aggregated as JSON. One round trip instead of six on a path where a customer is waiting. |
| `dashboard_today` | Live today-metrics. Scans one tenant-day. |
| `handling_split_30d` | AI vs human share, from the sealed rollups. |
| `lead_sources_30d` | Attribution. |
| `handover_queue` | Conversations awaiting a human, with an SLA-breach flag. |
| `business_theme` | White-label chrome, nothing sensitive. |
| `integration_status` | Credential metadata **without ciphertext**. |

---

## Growth plan

Current shape holds comfortably to the low thousands of tenants. Two things to
watch:

**`ai_logs` and `messages` volume.** ~3 AI rows per inbound message. At
10M+ rows, convert to monthly range partitions on `created_at`:

```sql
-- The shape is already partition-ready: created_at leads every index that matters.
create table public.ai_logs_2027_01 partition of public.ai_logs
  for values from ('2027-01-01') to ('2027-02-01');
```

Retention sweeping already caps unbounded growth, so this is an optimisation
rather than a rescue.

**IVFFlat `lists`.** Currently 100, appropriate to ~100k rows. Rule of thumb is
rows/1000, minimum 10; rebuild the index when the corpus grows an order of
magnitude. Only relevant for tenants using embeddings at all.

Not needed yet, and worth saying so explicitly: no read replicas, no sharding, no
caching layer. The indexes do the work, and adding infrastructure before the
indexes stop working is how a simple system becomes an unmaintainable one.

---

## Enum reference

Declared centrally in `0001` so no later migration guesses at a spelling.

| Enum | Values |
|---|---|
| `business_status` | trialing, active, past_due, suspended, cancelled |
| `member_role` | owner, admin, agent, viewer |
| `platform_role` | user, platform_admin |
| `plan_tier` | trial, starter, growth, scale, enterprise |
| `comms_channel` | sms, whatsapp, voice, web, email |
| `conversation_status` | active, waiting_for_human, human_handling, resolved, closed, archived |
| `message_direction` | inbound, outbound |
| `message_sender` | customer, ai, human, system |
| `message_status` | queued, sending, sent, delivered, read, undelivered, failed, received |
| `handover_reason` | customer_request, emergency, urgent, complaint, repeated_confusion, low_confidence, keyword, manual, ai_error, out_of_scope |
| `lead_status` | new, qualifying, qualified, booked, nurture, unqualified, lost, won |
| `urgency_level` | low, normal, high, emergency |
| `appointment_status` | pending, confirmed, cancelled, completed, no_show |
| `notification_channel` | email, sms, whatsapp, push, dashboard, webhook, slack |
| `notification_event` | missed_call, new_conversation, new_message, lead_captured, lead_qualified, handover_required, appointment_booked, appointment_cancelled, daily_digest, weekly_digest |
| `ai_provider` | anthropic, openai, google |
| `ai_purpose` | reply, extraction, summary, handover_check, onboarding_extract, embedding |
| `ai_call_status` | ok, error, timeout, refused, filtered |
| `knowledge_kind` | faq, policy, about, general, document, hours_note, pricing_note |
| `onboarding_status` | pending, scraping, extracting, awaiting_review, completed, failed |
| `actor_type` | user, system, n8n, api, ai, customer |

`message_sender` is worth a note: `system` exists so a handover notice ("I'm
getting a colleague") is not counted as an AI turn. Otherwise the AI-handled
percentage would flatter itself with messages the platform sent on the
assistant's behalf.
