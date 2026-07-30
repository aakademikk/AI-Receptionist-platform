# Roadmap

## Built and verified

Everything below is implemented, typechecks, and is covered by tests.

**Database** — 27 tables, RLS on all of them, explicit column grants, 13
transactional RPCs, 7 views, audit triggers, GDPR erasure, retention sweep.
`validate_local.sh` applies every migration to a throwaway cluster and runs a
functional suite proving tenant isolation, hot-path idempotency,
merge-not-overwrite extraction, privilege gating and erasure.

**Domain core** — provider abstraction over Claude/GPT/Gemini; dynamic prompt
builder with the closed-list service catalogue; deterministic handover detection
(20 tests); lead extraction with schema-constrained output and code-computed
scoring; both pipelines; notification outbox; booking engine; onboarding
extraction. 52 unit tests.

**API** — signature-verified Twilio webhooks (voice, SMS, delivery receipts);
15 internal endpoints; session-authenticated dashboard bridge; health and
revalidation.

**Dashboard** — overview with the handover queue first, conversation list with
server-side search, conversation viewer with human takeover and reply, leads sorted
by score, appointments, analytics from the sealed rollups, knowledge viewer,
settings for model and escalation. Tenant-themed chrome, validated data palette,
light and dark.

**Orchestration** — 13 n8n workflows, validated in CI.

**Infrastructure** — Docker stack, production image, three-job CI.

## Not built

Honestly, rather than by omission.

| | Where it stands |
|---|---|
| Onboarding review form | API, prompt and job state machine are complete. The review UI is not — an owner cannot yet approve the draft from the dashboard. |
| Knowledge/service editing | Read-only. Seeing exactly what the assistant was told matters more first; editing is form-heavy. |
| Realtime conversation viewer | Schema and client support it; the page renders on request. |
| Analytics trend charts | Tiles and a day table only. A trend line over a handful of seeded days looks like a feature while telling the owner nothing. |
| Push notifications | Enum value exists; suppressed at delivery. Needs a device-token registry. |
| Billing | `plan`, `billing_customer_id` and `billing_subscription_id` columns exist; no provider wired. |
| Number provisioning UI | Numbers are inserted by SQL. |
| MFA | Magic link is single-factor. |
| Voicemail transcription | Columns exist; no transcription step. |
| Public tenant API | `api_keys` and scopes exist; no documented public surface. |

---

## Phase 1 — Close the onboarding loop

The largest gap between "works" and "sellable". A new tenant currently needs SQL.

- Onboarding wizard: URL → progress → editable review form → apply.
- Number provisioning through the Twilio API, with webhook configuration.
- Self-serve business creation with the founding membership in one transaction.
- Invite flow using the existing `invitations` table.

**Why first:** every other improvement compounds across tenants, and tenants cannot
be added without a developer.

## Phase 2 — Give owners control of the content

- Service catalogue editing, with a preview of how it renders in the prompt.
- FAQ and policy editing, and approving `needs_review` scrape output.
- Brand editing with a live preview.
- A prompt preview showing exactly what the model receives — the fastest way for an
  owner to understand why the assistant said something.

**Why second:** it converts support tickets into self-service, and the prompt
preview in particular removes the "why did it say that?" conversation entirely.

## Phase 3 — Make the dashboard live

- Realtime subscription on the conversation viewer, so an inbound SMS appears
  without a refresh.
- Unread badges and a notification centre.
- Assignment and internal notes on conversations.
- Saved views.

**Why third:** it is polish, but it is the polish that makes the product feel like
somewhere you sit rather than somewhere you check.

## Phase 4 — Trust and scale

- MFA (Supabase TOTP).
- Rate limiting on the internal API — required before any public tenant API.
- n8n queue mode before ~100k executions a day.
- `ai_logs` and `messages` monthly partitioning. The schema shape is already
  partition-ready.
- Per-tenant spend caps with a degrade path (drop to a cheaper model rather than
  stop replying).
- Sentry or equivalent, correlated on the existing `trace_id`.

## Phase 5 — Depth

- **Analytics charts.** Trend lines for missed calls, leads and response time; the
  recovery rate over time. Needs enough real data to be honest.
- **Voice AI.** The natural extension: answer the call rather than text back. A
  different latency regime (sub-second, streaming) and a much larger build.
- **Vector knowledge retrieval** for tenants whose corpus outgrows trigram
  matching. Column and index already exist.
- **Outbound campaigns** — following up leads that went quiet. Needs care: a
  consent and opt-out story is a prerequisite, not an afterthought.
- **CRM integrations** (HubSpot, Pipedrive) via the `api_keys` surface.
- **Multi-language.** The prompt already carries locale; the templates do not.

## Explicitly not planned

- **A no-code prompt builder.** The prompt is the product's quality, and it is
  data-driven from typed tables already. Exposing raw prompt editing would produce
  tenants whose assistant invents prices, which is the one failure the design exists
  to prevent.
- **Tenant-supplied AI keys.** Tempting for cost pass-through, but it means
  supporting three providers' billing failures as customer-facing errors, and the
  client cache would need re-keying per credential.
- **Self-hosted single-tenant.** The whole architecture assumes shared
  infrastructure. A customer needing isolation gets their own deployment of the same
  code, not a fork.
