# API architecture

Three surfaces, three auth models, three audiences. Keeping them separate is what
allows the internal API to hold a platform-wide credential without that credential
ever being reachable from a browser.

| Surface | Path | Auth | Called by |
|---|---|---|---|
| **Webhooks** | `/api/webhooks/twilio/*` | Twilio HMAC-SHA1 signature | Twilio |
| **Internal** | `/api/internal/v1/*` | Shared secret or tenant API key | n8n, workers, integrations |
| **Dashboard** | `/api/dashboard/*` | Supabase session cookie | The browser |

---

## Webhooks

Public, unauthenticated by URL, authenticated by signature. `X-Twilio-Signature`
is HMAC-SHA1 over the request URL plus every POST parameter sorted by key and
concatenated as `key + value`, base64-encoded.

Two things break this silently and both are handled:

- **The URL must be exactly what Twilio signed**, including scheme. Behind a
  TLS-terminating proxy, `request.url` reports `http` and every signature fails —
  which looks like a bad auth token rather than a proxy detail.
  `reconstructUrl()` honours `x-forwarded-proto` / `x-forwarded-host`.
- **The comparison must be constant-time.** `timingSafeEqual`, after a length check.

Without signature verification, the inbound endpoint is a way for anyone who
guesses a phone number to forge a customer message and bill the tenant for the AI
reply.

| Route | Returns | Notes |
|---|---|---|
| `POST /voice` | TwiML | Dials the business's line. Must be fast — the caller is listening to silence. |
| `POST /voice/missed` | Hangup TwiML | `<Dial>` action callback. Hands off in `after()`. |
| `POST /sms` | Empty TwiML | Acknowledges; the reply goes via the REST API so it is recorded, priced and idempotency-keyed. |
| `POST /status` | 204 | Delivery receipts. Terminal states are never overwritten by a late intermediate one. |

`after()` rather than a dangling promise is load-bearing: it keeps the serverless
invocation alive until the work settles. A bare `void promise` is terminated when
the response flushes, and the follow-up SMS silently never sends.

---

## Internal API

### Authentication

Two credential types, both in `apps/web/src/lib/internal-auth.ts`:

**Shared secret** — `x-atwood-secret`. Platform-wide, used by n8n. One value to
rotate, no per-tenant bookkeeping. Compared in constant time after hashing both
sides, so the comparison length is fixed regardless of what was presented.

**Tenant API key** — `authorization: Bearer atw_…`. Hashed in `api_keys`, carries
a `business_id`.

Looked up **by hash**, not by prefix-then-compare: the hash column is
unique-indexed, so it is one indexed read with no partial-match timing signal.

SHA-256 rather than a slow KDF, deliberately. This is the right call here and the
wrong call for passwords: an API key is a 256-bit random value, so there is no
dictionary to attack and no rainbow table to build — the only attack is brute force
against full entropy, which bcrypt would not improve. Meanwhile the hash is
computed on every request, where a KDF's cost would be a latency tax.

A key-scoped request must never act on another tenant. `assertBusinessScope(auth,
businessId)` is the check; the shared secret passes it, a key must match.

### Error semantics

n8n branches on status, so the mapping is a contract:

| Status | Meaning | n8n behaviour |
|---|---|---|
| 400 / 422 | Our bug or bad input | **Do not retry.** Retrying a validation error forever is how a customer gets eleven texts. |
| 401 / 403 | Bad credential or wrong tenant | Do not retry. |
| 404 | Unknown resource | Do not retry. |
| 429 | Rate limited | Retry with backoff. |
| 5xx | Transient | Retry. |

`withInternalAuth()` wraps every handler and maps thrown `AppError`s centrally, so
handlers throw domain errors and the wrapper decides the status. 5xx logs at
`error`, 4xx at `warn` — which keeps the error channel signal rather than noise.

Every response carries `x-atwood-trace-id`, reusing an inbound one where present,
so an n8n execution, the API calls it made, and the `ai_logs` rows those produced
all correlate.

`provider_refused` (422) is worth calling out: a model declining is an HTTP 200
from the provider and retrying will not help, so it is a distinct code that routes
to a human rather than into a retry loop.

### Endpoints

#### Pipelines

**`POST /calls/missed`** — the missed-call pipeline. Routes, opens the
conversation, records the call, sends the branded SMS, alerts the owner.

```json
{ "to_number": "+441134960001", "from_number": "+447700900123",
  "call_sid": "CA…", "call_status": "no-answer", "started_at": "2026-07-30T…" }
```

Returns `is_new_call` — `false` on a webhook retry, telling the caller to stop.
`reason` explains any no-op so a quiet skip is not mistaken for a bug.

**`POST /messages/inbound`** — the conversation pipeline. Records, checks
escalation, generates, extracts, notifies, sends.

```json
{ "to_number": "+441134960001", "from_number": "+447700900123",
  "body": "I need a valuation", "channel": "sms",
  "provider_message_id": "SM…" }
```

Returns `is_new_message`, `reply_sent`, `handover`, `lead`.

Both endpoints **send the message themselves** rather than returning it for the
caller to send. The alternative — return the body, let n8n send, then call back to
record it — has a window where the message is delivered but unrecorded, and a
customer holding an SMS the dashboard has never heard of is the worst available
failure mode.

Both record as `queued` **before** sending, and reconcile the provider id and
price after. Recording after a successful send would lose any message whose send
worked and whose write did not.

#### Conversation control

| Endpoint | Purpose |
|---|---|
| `GET /conversations/:id/memory` | Transcript window, rolling summary, topic, known lead fields. |
| `POST /conversations/:id/handover` | Escalate. Idempotent; only alerts on a state change. |
| `POST /conversations/:id/takeover` | A named human adopts it. Verifies the user is a member of *that* tenant. |
| `POST /conversations/:id/resume` | Hand back to the assistant; resets the confusion counter. |
| `POST /messages/send` | Outbound on an existing thread. A human sender implicitly takes over. |

`handover` and `takeover` are separate on purpose: handover is the system deciding
a person is needed; takeover is a specific person saying "this is mine". A thread
can be taken over without ever having been escalated.

#### Everything else

| Endpoint | Notes |
|---|---|
| `GET /businesses/:id/context` | Business Loader + Knowledge Loader in one. Cached `private, max-age=5`. |
| `POST /leads/extract` | Off-path re-extraction. Safe to repeat — merge semantics. |
| `POST /bookings/slots` | Real availability **plus `prompt_block`**, the exact text for the prompt. |
| `POST /bookings/create` | Re-validates availability before writing. |
| `POST /notifications/drain` | Platform-scoped. Rejects a tenant key. |
| `POST /analytics/rollup` | Idempotent. Empty body = all tenants, yesterday. |
| `POST /maintenance/purge` | Retention sweep. Batched. |
| `POST /onboarding/:jobId/run` | Advances the job one step. |

`bookings/slots` returning `prompt_block` is not a convenience: the wording is
what stops the model inventing a time, so it ships next to the logic that computed
the slots rather than being re-written in a workflow where it would drift.

---

## Dashboard API

`POST /api/dashboard/conversations/:id/:action` where action is
`reply | takeover | resume | handover`.

This exists because of a boundary that must not be crossed: the internal API's
shared secret is platform-wide — it can act on *any* tenant — and it can never be
in a browser bundle. So the browser talks to this route with its session cookie,
and this route:

1. verifies the session with `getUser()` (not `getSession()`, which reads the
   cookie without validating it and will happily report a user from a forged token);
2. loads the conversation through the **RLS-scoped** client, so another tenant's
   thread simply is not returned;
3. checks the caller's role permits writing;
4. only then presents the secret, server-side.

Step 2 returning nothing yields a **404, not a 403** — telling a user that a
conversation exists but is not theirs is an information leak.

Attribution comes from the verified session (`sent_by_user_id: user.id`), never
from the request body, so a user cannot post a message as a colleague.

`/api/revalidate` is similar but simpler: shared-secret authenticated, and every
requested path is validated against the tenant's own `/app/:slug` prefix. Without
that check, one request could purge another tenant's pages or the whole site.

---

## What is deliberately not here

**No public tenant-facing REST API.** `api_keys` and the scope machinery exist so
one can be added, but shipping a versioned public API before a customer has asked
for a specific integration means guessing at a contract and then living with the
guess. The internal API is versioned (`/v1/`) so the day that changes, the path is
already carved.

**No GraphQL.** The dashboard reads Postgres directly through PostgREST with RLS,
which is a better fit than a resolver layer that would need its own authorization
story duplicating the policies.

**No rate limiting on the internal API.** It is not public, and the callers are
n8n and our own webhook handlers. If tenant API keys ship for real, this becomes
required rather than optional.
