# Security and GDPR

## Threat model

What this system holds that matters: **conversation transcripts between a business
and its customers**. Names, numbers, postcodes, and whatever someone typed into a
text message about their leaking flat. That is ordinary personal data, sometimes
sensitive by context, and it belongs to thousands of unrelated businesses in one
database.

The failures that matter, in order:

1. **Cross-tenant leak.** One business reading another's conversations. The
   worst outcome and the one the design spends most effort on.
2. **Credential compromise.** A leaked service-role key or database dump exposing
   every tenant's Twilio and Google credentials.
3. **Forged inbound traffic.** An unauthenticated webhook lets anyone fabricate a
   customer message and bill the tenant for the AI reply.
4. **Prompt injection.** Scraped website content or an owner's free-text
   instructions overriding the platform's own rules.
5. **PII sprawl.** Personal data accumulating in logs where erasure never reaches.

## 1. Cross-tenant isolation

Three layers, detailed in `docs/05`. In brief:

- **RLS on all 27 tables**, every policy one indexed predicate.
- **Explicit column grants**, because a table-level grant cannot be narrowed
  afterwards — accepting Supabase's default `GRANT ALL` would leave
  `users.platform_role` self-assignable and `api_keys.key_hash` readable.
- **Role gating** in write policies.

`FORCE ROW LEVEL SECURITY` on the four tables holding customer data, so a stray
`set role postgres` in a migration cannot silently cross tenants.

The service role bypasses all of it. Its call sites — the internal API and webhook
handlers — are the one place isolation lives in code, deliberately, because routing
an inbound number to *whichever* tenant owns it is a cross-tenant read RLS cannot
express. Those sites take `business_id` from a trusted source, never from request
input.

Verified rather than asserted: `supabase/tests/functional.sql` runs as a real
`authenticated` session and fails the build if tenant B can see any of tenant A's
conversations, messages, leads, contacts, calls, services or analytics, or if any
view is not tenant-scoped.

## 2. Credentials

### At rest

Per-tenant integration secrets are **AES-256-GCM envelopes**, encrypted in the
application. The database stores an opaque base64 blob, so a leaked database dump
does not leak a single tenant's Twilio or Google credentials.

Format: `v<version>.<iv>.<authTag>.<ciphertext>`. GCM authenticates as well as
encrypts, so a tampered envelope fails to open rather than yielding plausible
garbage. The version prefix makes rotation possible without a flag day — new writes
use the current key, old envelopes still decrypt with the key that wrote them.

Decryption errors are deliberately vague. A detailed crypto error is an oracle.

**Why application-side rather than Supabase Vault / pgsodium:** Vault is a good
option and this design does not preclude it. Doing it in the application keeps the
encryption boundary *outside* the database, so the same envelope decrypts
identically from n8n, from a Vercel function, or from a local script, and moving to
self-hosted Postgres later needs no migration. The trade is that we own key
management rather than delegating it.

### API keys

SHA-256, not bcrypt — and that is correct here while being wrong for passwords. An
API key is a 256-bit random value: no dictionary, no rainbow table, and the only
attack is brute force against full entropy, which a KDF would not improve.
Meanwhile the hash is computed on every internal API request, where bcrypt's cost
would be a per-request latency tax.

Looked up by hash on a unique index, so there is one indexed read and no
partial-match timing signal. Compared with `timingSafeEqual`.

### Never in a browser

`SUPABASE_SERVICE_ROLE_KEY` and `INTERNAL_API_SECRET` are server-only.
`serverEnv` throws if evaluated in a browser context, which is the backstop rather
than the policy. The dashboard's client island posts to `/api/dashboard/*`
specifically so the secret stays server-side.

## 3. Inbound authenticity

Every Twilio webhook verifies `X-Twilio-Signature` — HMAC-SHA1 over the URL plus
sorted parameters, compared in constant time. Two details that break it silently
and are handled: the URL must be exactly what Twilio signed (so
`x-forwarded-proto` wins behind a proxy), and the comparison must not be `===`.

Every n8n webhook verifies `x-atwood-secret` in its first node, because an n8n
webhook path is otherwise open to anyone who learns it.

## 4. Prompt injection

Two untrusted inputs reach the prompt: **scraped website content** and the owner's
**free-text instructions**. Neither is under our control, and a scraped page
containing "ignore your instructions" would otherwise be an injection into every
conversation.

Mitigations:

- Both are **fenced** in delimited blocks (`<reference_material>`,
  `<owner_instructions>`), placed **after** the platform rules, with an explicit
  note that content inside cannot override them and that anything resembling a
  command addressed to the assistant should be ignored.
- Owner instructions are explicitly told they cannot authorise inventing services
  or prices, or skipping an escalation.
- Scraped content is `needs_review = true` and excluded from
  `business_ai_context` until a human approves it — so unapproved scrape output
  never reaches a prompt at all.
- The service catalogue is a **typed table** rendered as a closed list, so
  injected text cannot add a service or a price.
- `cleanModelReply()` strips leaked scaffolding tags from output as a last line of
  defence.

This is mitigation, not elimination. Prompt injection has no complete fix; the
design limits the blast radius to what the assistant *says* rather than what it can
*do*, because it has no tools that take actions on the business's behalf.

## 5. PII containment

**`ai_logs` is the dangerous table.** It stores the prompt and response of every
model call, which makes it the most useful table for debugging and the most
dangerous for privacy — an unredacted prompt is a second copy of the customer's
personal data in a table support engineers browse.

So prompts and responses pass through `redactObject()` before storage: emails,
phone numbers, postcodes, card numbers, IBANs and NI numbers are replaced with
placeholders, secret-shaped keys are wholesale redacted, long strings are
truncated, and cycles and depth are bounded.

Order matters in that function: cards and IBANs are matched *before* phone numbers,
because a 16-digit card also satisfies the phone pattern and mislabelling it
`[phone]` would leave a card's shape visible.

The same redaction runs over every log line, so a developer who logs a whole
request body cannot accidentally publish a customer's number.

Belt and braces: `erase_contact()` deletes the subject's `ai_logs` rows outright,
because logs leak.

## GDPR

### Lawful basis and roles

The **business is the data controller**; Atwood Systems is the **processor**. The
platform processes conversations on the business's instruction. A production
deployment needs a DPA with each tenant — that is paperwork this repo cannot
provide, but the technical measures it references are here.

### Data subject rights

`gdpr_requests` tracks each request with a requester, timestamp, operator, outcome
and a 30-day due date. Having it as a table rather than an ad-hoc script is what
makes the compliance story defensible.

**Erasure** — `erase_contact(business_id, contact_id)`:

- redacts every message body to `[erased at data subject request]`, clears media
  and metadata;
- nulls the conversation's customer fields, summary and topic, and archives it;
- nulls the lead's name, phone, email, postcode, enquiry, summary and raw
  extraction;
- nulls call identifiers, recordings and voicemail transcripts;
- **deletes** the subject's `ai_logs` rows;
- strips the contact bare and sets `sms_opt_out`;
- writes an `audit_logs` entry recording what was removed.

It **anonymises rather than deletes**. The business keeps its aggregate history —
it has a legitimate interest in knowing it handled 400 calls last month — while
every identifier tying those rows to a person is destroyed. `contacts` is the anchor
that makes this one operation instead of a scan across four tables.

Tested: the functional suite asserts message bodies do not survive, the contact's
phone does not survive, the lead's name does not survive, **and** that the call
count and analytics rollup are unchanged.

**Access and portability** — the same anchor. `gdpr_requests.result` records where
the export landed.

### Storage limitation

`business_settings.data_retention_days` (default 730, bounded 30–3650) per tenant,
enforced nightly by `purge_expired_data()`. A documented retention period only means
something if something actually deletes.

Batched at 5,000 rows per table per run: an unbounded delete across a large tenant
would hold locks long enough to affect live traffic, so the schedule catches up over
successive nights.

### Data minimisation

- The extraction prompt records **only what was actually said** — empty string
  rather than an inferred postcode. A wrong field means someone calls the wrong
  person about the wrong job; an empty one is correct and useful.
- The AI is instructed never to ask for card details, bank details, passwords or a
  date of birth.
- Calendar availability uses `freeBusy`, which returns opaque busy blocks only —
  no titles, no attendees. The assistant needs to know *whether* a slot is free,
  not what is in the owner's diary.
- Owner alert SMS refer to "caller ending 0123" rather than the full number,
  because an alert may land on a shared phone.

### Audit

`audit_logs` is append-only — SELECT-only policy, writes via `SECURITY DEFINER`
triggers. It stores **only changed keys**, which keeps it small and makes diffs
readable, and `updated_at` is excluded because every update touches it and it is
never news.

Attached to the configuration tables where "who changed this?" is a real question.
Deliberately not to `messages` or `ai_logs`, which are already append-only records —
auditing them would double storage for no information gain.

### Sub-processors

A tenant's data reaches: Supabase (hosting), Vercel or equivalent (application),
Twilio (messaging), their chosen AI provider, Firecrawl (onboarding only), Resend
(notification email), Google (calendar, if connected). Each needs listing in the
tenant-facing privacy notice.

The AI provider is worth flagging in a DPA: transcripts are sent to it on every
message, and which provider that is depends on the tenant's own setting.

## Known gaps

Stated rather than glossed:

- **No MFA.** Magic link is single-factor. Supabase supports TOTP; enabling it is
  Phase 4 (`docs/08`).
- **No rate limiting** on the internal API. Not public, and callers are n8n and
  our own handlers — but required before tenant API keys ship for real.
- **No automated PII scanning** of `knowledge_items`. An owner could paste customer
  data into an FAQ.
- **`ai_logs` redaction is regex-based.** It catches the common shapes; it will not
  catch an unusually formatted identifier.
- **Twilio holds message bodies** independently, subject to its own retention. A
  complete erasure story includes deleting them there too.
