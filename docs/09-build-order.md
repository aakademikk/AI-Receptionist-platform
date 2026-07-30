# Build order

The order this was built in, and the order to rebuild it in. Each step is
verifiable before the next depends on it, which is the only property that matters —
a system where you cannot tell whether step 3 works until step 8 is finished is a
system you debug rather than build.

## 1. Schema and RLS first

Everything else is downstream of the data model, and RLS retrofitted onto a
schema is far harder than RLS designed in — the choice to carry `business_id` on
every table (including where redundant) has to be made before anything queries.

**Order:** extensions and enums → tenancy → profile and knowledge → telephony and
conversations → leads and appointments → notifications, logs, analytics → audit and
GDPR → **privileges and RLS** → RPCs → views.

RLS comes after the tables but before anything reads them, so no code is ever
written against an unprotected table and later "secured".

**Verify:** `validate_local.sh` — migrations apply, every table has RLS *and* at
least one policy (a table with RLS and no policy is unreadable, not protected), and
the functional suite proves isolation.

Do this before writing a line of TypeScript. Getting it wrong here is a migration;
getting it wrong later is a migration plus every query that assumed the old shape.

## 2. Prove isolation with a test, not by reading

Two tenants, two users, a viewer. Assert tenant B sees zero of tenant A's rows,
that `authenticated` cannot call the service-role RPCs, and that a viewer cannot
write.

This is step 2 rather than step 9 because it is the assertion the entire product
rests on, and because it caught two real bugs during this build: an ambiguous column
reference that made `resolve_inbound` fail at runtime, and `authenticated` having no
table grants at all once the default `GRANT ALL` was revoked.

Note the trap the test itself fell into: asserting "tenant B sees zero rows" from a
*view* passes even if the view is broken open in the other direction. Assert "sees
exactly its own row, and not tenant A's".

## 3. The provider abstraction

Before any prompt work, because the shape of "call a model" determines the shape of
everything above it — and because the per-provider quirks are exactly the things
that leak everywhere if not absorbed early: Claude rejecting `temperature`, thinking
sharing the token budget, a refusal arriving as a 200, OpenAI's strict-mode schema
requirements, Gemini's `responseJsonSchema`.

**Verify:** typecheck against the real SDKs. Do not hand-write SDK call shapes from
memory — install the package and read the types. That found `output_config.effort`
and `JSONOutputFormat` rather than a plausible guess at them.

## 4. Prompts, and the guarantee they encode

The service catalogue as a closed list is not a prompt-writing detail — it is the
mechanism behind "never invent a price", and it dictates that services are a typed
table (step 1). Fencing untrusted content belongs here too.

**Verify:** by reading, mostly. Prompt quality is not unit-testable, but the
*structure* is: the builder is a pure function of `BusinessContext` and
`ConversationMemory`, so it can be snapshot-tested and inspected without a model
call.

## 5. Handover detection

Before the reply pipeline, because the pipeline's step ordering depends on it: the
escalation check sits *in front of* generation, and an emergency must never receive
an AI reply.

Rules, not a model call — latency, auditability, and recall over precision.

**Verify:** this is where tests pay for themselves. 20 cases, one per trigger. They
found a real recall gap: the gas pattern matched "gas smell" but not "smell gas",
which is at least as common and is the single highest-consequence miss in the
system.

## 6. The pipelines

Now the pieces exist, wire them — and the ordering *is* the work. Record before
replying, escalate before generating, extract after composing, notify last.

**Verify:** the SQL functional suite already covers the transactional behaviour, so
what is left is the sequencing, which is readable top to bottom in one function.

## 7. Internal API

Thin handlers over the pipelines, plus the auth wrapper and the error mapping n8n
branches on.

**Verify:** typecheck, then build. `next build` catches route-shape mistakes that
`tsc` alone does not.

## 8. Twilio webhooks

Signature verification first — an unauthenticated inbound endpoint is a way to
forge customer messages and bill the tenant.

**Verify:** end-to-end with a real number and a tunnel. This is the first moment
the system does something visible from a phone, and it is worth reaching early
enough to be encouraging.

## 9. Dashboard

Server components reading Postgres directly through RLS. Overview, conversations,
viewer with takeover, leads.

**Verify:** `next build`, then click through it. Render the pages and look at them;
a typechecked layout can still overflow.

## 10. n8n workflows

Last, because they are thin wrappers over an API that already works. Building them
first would mean debugging orchestration and business logic simultaneously.

**Verify:** import each one; CI validates connection integrity.

## 11. Docs, CI, Docker

CI last only because it needs something to run. Everything it runs was already
being run by hand at each step above — CI is the automation of a habit, not a
replacement for it.

---

## What to do differently

Three things this build learned the hard way.

**Commit after every verified step.** Not at the end. Two hours of work sat
uncommitted while a shell `cd` quietly wrote four config files into
`packages/core/apps/web/` — recoverable, but only because nothing had been lost.
A commit after step 1, step 2, step 3 would have made that a non-event.

**Install dependencies and read the types before writing against an SDK.** Every
SDK shape in this codebase was verified against the installed package. Guessing
produces code that typechecks against nothing and fails at runtime.

**Write the test that would embarrass you.** The isolation test and the handover
tests both found real bugs within minutes of being written. The tests that only
confirm what you already believe are the ones that take the longest to pay off.
