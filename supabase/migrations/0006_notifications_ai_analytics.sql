-- =============================================================================
-- 0006 — Notifications, AI logs, analytics
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Notification recipients — who gets told what, and how.
--
-- business_settings carries the tenant-wide defaults; this table lets an owner
-- route "handover_required" to their mobile by SMS while the office manager gets
-- everything by email. Empty `events` means "all subscribed events".
-- -----------------------------------------------------------------------------
create table public.notification_recipients (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id     uuid references public.users (id) on delete cascade,
  channel     notification_channel not null,
  destination text not null,                    -- email address, E.164, webhook URL, device token
  events      notification_event[] not null default '{}'::notification_event[],
  label       text,
  is_active   boolean not null default true,
  verified_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (business_id, channel, destination)
);

comment on table public.notification_recipients is
  'Per-business notification routing. Empty events array = all events the business subscribes to.';

create index notification_recipients_lookup_idx
  on public.notification_recipients (business_id, channel) where is_active;

create trigger notification_recipients_set_updated_at
  before update on public.notification_recipients
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Notifications — the outbox.
--
-- Written by the notification engine, drained by a worker. dedupe_key is what
-- stops a flapping workflow from texting the owner eleven times about the same
-- lead: the unique index makes a duplicate insert a no-op.
-- -----------------------------------------------------------------------------
create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  event        notification_event not null,
  channel      notification_channel not null,
  recipient_id uuid references public.notification_recipients (id) on delete set null,
  destination  text not null,

  subject      text,
  body         text,
  payload      jsonb not null default '{}'::jsonb,

  -- Deep-link targets for the dashboard/push notification.
  conversation_id uuid references public.conversations (id) on delete set null,
  lead_id      uuid references public.leads (id) on delete set null,
  appointment_id uuid references public.appointments (id) on delete set null,

  status       notification_status not null default 'pending',
  attempts     int not null default 0,
  last_error   text,
  dedupe_key   text,
  scheduled_for timestamptz not null default now(),
  sent_at      timestamptz,
  read_at      timestamptz,          -- dashboard/in-app notifications
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.notifications is
  'Outbox with dedupe. Drained by the notification worker; dashboard channel is read in-app.';

-- Idempotency for the notification engine.
create unique index notifications_dedupe_idx
  on public.notifications (business_id, dedupe_key)
  where dedupe_key is not null;

-- The worker's claim query.
create index notifications_due_idx
  on public.notifications (scheduled_for)
  where status = 'pending';

create index notifications_business_created_idx
  on public.notifications (business_id, created_at desc);

-- Unread in-app badge count.
create index notifications_unread_idx
  on public.notifications (business_id, created_at desc)
  where channel = 'dashboard' and read_at is null;

create trigger notifications_set_updated_at
  before update on public.notifications
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- AI logs — one row per model call.
--
-- This is the observability backbone: cost attribution, latency tracking, and
-- "why did the AI say that?" forensics. Prompts are stored redacted (see
-- packages/core/src/utils/redact.ts) so the log itself is not a PII liability.
--
-- Growth: expect ~3 rows per inbound message. At scale, convert to a monthly
-- partitioned table (see docs/01-database-schema.md) — the shape here is
-- partition-ready (created_at is in every index prefix that matters).
-- -----------------------------------------------------------------------------
create table public.ai_logs (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  message_id      uuid references public.messages (id) on delete set null,

  purpose         ai_purpose not null,
  provider        ai_provider not null,
  model           text not null,
  effort          text,

  prompt_tokens     int,
  completion_tokens int,
  cached_tokens     int,
  total_tokens      int generated always as
                      (coalesce(prompt_tokens, 0) + coalesce(completion_tokens, 0)) stored,
  cost_usd          numeric(12,6),
  latency_ms        int,

  status          ai_call_status not null default 'ok',
  stop_reason     text,
  error_message   text,

  -- Redacted request/response for debugging. Never contains raw credentials.
  request         jsonb,
  response        jsonb,
  -- Correlation id shared with the n8n execution that triggered the call.
  trace_id        text,

  created_at      timestamptz not null default now()
);

comment on table public.ai_logs is
  'One row per model call: cost, latency, redacted prompt/response. Retention-managed.';

create index ai_logs_business_created_idx on public.ai_logs (business_id, created_at desc);
create index ai_logs_conversation_idx on public.ai_logs (conversation_id, created_at);
create index ai_logs_errors_idx
  on public.ai_logs (business_id, created_at desc) where status <> 'ok';
create index ai_logs_trace_idx on public.ai_logs (trace_id) where trace_id is not null;

-- Close the loop: a message can point at the AI call that produced it.
alter table public.messages
  add constraint messages_ai_log_fk
  foreign key (ai_log_id) references public.ai_logs (id) on delete set null;

create index messages_ai_log_idx on public.messages (ai_log_id) where ai_log_id is not null;

-- -----------------------------------------------------------------------------
-- Analytics daily rollup.
--
-- Live "today" metrics come from views over the hot tables (0010); this table
-- holds the sealed history so trend charts never scan the message log. Refreshed
-- by the Analytics workflow via public.rollup_analytics_daily().
-- -----------------------------------------------------------------------------
create table public.analytics_daily (
  business_id       uuid not null references public.businesses (id) on delete cascade,
  day               date not null,

  calls_total       int not null default 0,
  calls_missed      int not null default 0,
  conversations_started int not null default 0,
  conversations_resolved int not null default 0,
  messages_inbound  int not null default 0,
  messages_outbound int not null default 0,
  messages_ai       int not null default 0,
  messages_human    int not null default 0,

  leads_captured    int not null default 0,
  leads_qualified   int not null default 0,
  appointments_booked int not null default 0,
  handovers         int not null default 0,

  avg_first_response_seconds numeric(10,2),
  median_first_response_seconds numeric(10,2),
  ai_handled_pct    numeric(5,2),
  human_handled_pct numeric(5,2),

  ai_cost_usd       numeric(12,6) not null default 0,
  messaging_cost_usd numeric(12,6) not null default 0,

  computed_at       timestamptz not null default now(),

  primary key (business_id, day)
);

comment on table public.analytics_daily is
  'Sealed daily rollup. Trend charts read this; today reads the live views in 0010.';

create index analytics_daily_day_idx on public.analytics_daily (day desc);
