-- =============================================================================
-- 0004 — Telephony, contacts, conversations, messages
-- =============================================================================
-- The hot path. Every inbound webhook resolves a phone number to a business here,
-- then appends to a conversation. Indexes in this file are the difference between
-- a 5ms and a 500ms webhook.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Phone numbers — the routing table.
--
-- e164 is globally unique across the platform, which is what makes inbound
-- routing a single indexed lookup with no tenant hint required. Twilio tells us
-- the `To` number; that number tells us the tenant.
-- -----------------------------------------------------------------------------
create table public.phone_numbers (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  e164         text not null unique,
  friendly_name text,
  provider     text not null default 'twilio',
  provider_sid text,
  -- Which channels this number serves. A Twilio number can be voice+SMS; a
  -- WhatsApp sender is its own row.
  channels     comms_channel[] not null default array['sms','voice']::comms_channel[],
  is_primary   boolean not null default false,
  -- Where missed calls are forwarded before we declare them missed.
  forward_to   text,
  missed_call_enabled boolean not null default true,
  voice_greeting_url  text,
  status       text not null default 'active',
  released_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint e164_format check (e164 ~ '^\+[1-9][0-9]{6,15}$')
);

comment on table public.phone_numbers is
  'Platform-wide unique numbers. Inbound routing key: To number -> business.';

create index phone_numbers_business_idx on public.phone_numbers (business_id);
create unique index phone_numbers_one_primary_idx
  on public.phone_numbers (business_id) where is_primary;

create trigger phone_numbers_set_updated_at
  before update on public.phone_numbers
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Contacts — the person on the other end.
--
-- Not in the original table list, but earns its place twice over: it dedupes
-- repeat callers across conversations (so the AI can say "welcome back" and the
-- dashboard can show history), and it makes GDPR erasure a single-row operation
-- instead of a scan across conversations, messages and leads.
-- -----------------------------------------------------------------------------
create table public.contacts (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  phone        text,
  phone_normalized text generated always as (public.normalize_phone(phone)) stored,
  email        citext,
  full_name    text,
  postcode     text,
  notes        text,
  tags         text[] not null default '{}'::text[],
  -- Marketing/consent state, tracked per contact for compliance.
  sms_opt_out  boolean not null default false,
  opt_out_at   timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  conversation_count int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.contacts is
  'Deduplicated end customers per business. Anchor for GDPR erasure and repeat-caller context.';

-- One contact per phone per business. Partial unique so contacts without a phone
-- (web chat, email-only) are still allowed.
create unique index contacts_business_phone_idx
  on public.contacts (business_id, phone_normalized)
  where phone_normalized is not null;

create index contacts_business_email_idx
  on public.contacts (business_id, email) where email is not null;
create index contacts_name_trgm_idx on public.contacts using gin (full_name gin_trgm_ops);

create trigger contacts_set_updated_at
  before update on public.contacts
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Calls — every inbound call attempt, missed or answered.
-- Kept distinct from conversations because one caller may ring three times
-- before replying to the SMS, and the dashboard needs both counts.
-- -----------------------------------------------------------------------------
create table public.calls (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete cascade,
  phone_number_id uuid references public.phone_numbers (id) on delete set null,
  contact_id      uuid references public.contacts (id) on delete set null,
  conversation_id uuid,   -- FK added after conversations exists
  provider        text not null default 'twilio',
  provider_call_sid text,
  direction       message_direction not null default 'inbound',
  from_number     text not null,
  to_number       text not null,
  -- Twilio DialCallStatus / CallStatus: no-answer, busy, failed, completed…
  call_status     text,
  is_missed       boolean not null default false,
  duration_seconds int,
  recording_url   text,
  voicemail_url   text,
  voicemail_transcript text,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  -- Did we manage to send the follow-up SMS?
  followup_sent_at timestamptz,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),

  unique (provider, provider_call_sid)
);

comment on table public.calls is
  'Call log. is_missed drives the missed-call SMS workflow and the dashboard metric.';

create index calls_business_started_idx on public.calls (business_id, started_at desc);
create index calls_missed_idx
  on public.calls (business_id, started_at desc) where is_missed;
create index calls_contact_idx on public.calls (contact_id);

-- -----------------------------------------------------------------------------
-- Conversations — the unit the dashboard and the AI both work on.
--
-- Denormalised counters and summary fields live here so the conversation list
-- renders from one table with no aggregation.
-- -----------------------------------------------------------------------------
create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete cascade,
  contact_id      uuid references public.contacts (id) on delete set null,
  phone_number_id uuid references public.phone_numbers (id) on delete set null,
  channel         comms_channel not null default 'sms',
  status          conversation_status not null default 'active',

  -- Customer identity snapshot, denormalised for list rendering.
  customer_phone  text,
  customer_name   text,

  -- AI control
  ai_enabled      boolean not null default true,
  ai_turn_count   int not null default 0,
  confusion_count int not null default 0,

  -- Human ownership
  assigned_user_id uuid references public.users (id) on delete set null,
  taken_over_at    timestamptz,
  taken_over_by    uuid references public.users (id) on delete set null,

  -- Rolling AI-maintained state
  summary          text,
  current_topic    text,
  last_ai_response text,
  sentiment        text,
  lead_status      lead_status not null default 'new',

  -- Handover
  handover_reason_code handover_reason,
  handover_note        text,
  handover_at          timestamptz,

  -- Counters & timing (maintained by trigger, see below)
  message_count       int not null default 0,
  inbound_count       int not null default 0,
  outbound_count      int not null default 0,
  first_response_seconds int,
  last_message_at     timestamptz,
  last_inbound_at     timestamptz,
  last_outbound_at    timestamptz,

  source          text,   -- 'missed_call' | 'inbound_sms' | 'whatsapp' | 'web'
  opened_at       timestamptz not null default now(),
  closed_at       timestamptz,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.conversations is
  'A threaded exchange with one customer. Counters are denormalised for list views.';

-- Primary list view: newest activity first, per tenant.
create index conversations_business_activity_idx
  on public.conversations (business_id, last_message_at desc nulls last);

-- The "needs a human" queue.
create index conversations_waiting_idx
  on public.conversations (business_id, handover_at desc)
  where status = 'waiting_for_human';

-- Inbound message lookup: find the open thread for this customer on this number.
create index conversations_open_thread_idx
  on public.conversations (business_id, customer_phone, channel)
  where status in ('active', 'waiting_for_human', 'human_handling');

create index conversations_contact_idx on public.conversations (contact_id);
create index conversations_assigned_idx
  on public.conversations (assigned_user_id) where assigned_user_id is not null;
create index conversations_lead_status_idx on public.conversations (business_id, lead_status);

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

alter table public.calls
  add constraint calls_conversation_fk
  foreign key (conversation_id) references public.conversations (id) on delete set null;

create index calls_conversation_idx on public.calls (conversation_id);

-- -----------------------------------------------------------------------------
-- Messages — append-only transcript.
-- -----------------------------------------------------------------------------
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  -- business_id is denormalised from the conversation purely so RLS is a single
  -- indexed predicate and never has to join. Enforced consistent by trigger.
  business_id     uuid not null references public.businesses (id) on delete cascade,
  direction       message_direction not null,
  sender          message_sender not null,
  channel         comms_channel not null default 'sms',
  body            text,
  media           jsonb not null default '[]'::jsonb,

  -- Provider linkage. The unique index below is our idempotency guarantee:
  -- Twilio retries webhooks, and a retry must not duplicate a message.
  provider          text,
  provider_message_id text,
  status            message_status not null default 'received',
  error_code        text,
  error_message     text,

  -- Attribution
  sent_by_user_id uuid references public.users (id) on delete set null,
  ai_log_id       uuid,   -- FK added in 0006 once ai_logs exists

  segments        int,
  price_amount    numeric(12,6),
  price_currency  text,

  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  delivered_at    timestamptz,
  metadata        jsonb not null default '{}'::jsonb
);

comment on table public.messages is
  'Append-only transcript. (business_id, provider_message_id) is the webhook idempotency key.';

-- Transcript read, in order. This is the single most-executed query in the system.
create index messages_conversation_created_idx
  on public.messages (conversation_id, created_at);

-- Idempotency: a provider message id may only land once per tenant.
create unique index messages_provider_id_idx
  on public.messages (business_id, provider_message_id)
  where provider_message_id is not null;

create index messages_business_created_idx on public.messages (business_id, created_at desc);
create index messages_body_trgm_idx on public.messages using gin (body gin_trgm_ops);
create index messages_pending_status_idx
  on public.messages (business_id, status)
  where status in ('queued', 'sending', 'sent');

-- -----------------------------------------------------------------------------
-- Counter maintenance.
--
-- Doing this in a trigger rather than in application code means the counters are
-- correct no matter which path wrote the message — internal API, n8n, or a
-- manual SQL fix. It also computes first_response_seconds, which is the headline
-- dashboard metric.
-- -----------------------------------------------------------------------------
create or replace function public.messages_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first_inbound timestamptz;
begin
  -- Guard against a mismatched denormalised business_id.
  if not exists (
    select 1 from public.conversations c
    where c.id = new.conversation_id and c.business_id = new.business_id
  ) then
    raise exception 'messages.business_id % does not match conversation %',
      new.business_id, new.conversation_id;
  end if;

  update public.conversations c
  set message_count   = c.message_count + 1,
      inbound_count   = c.inbound_count + (case when new.direction = 'inbound' then 1 else 0 end),
      outbound_count  = c.outbound_count + (case when new.direction = 'outbound' then 1 else 0 end),
      ai_turn_count   = c.ai_turn_count + (case when new.sender = 'ai' then 1 else 0 end),
      last_message_at = greatest(coalesce(c.last_message_at, new.created_at), new.created_at),
      last_inbound_at = case when new.direction = 'inbound'
                          then greatest(coalesce(c.last_inbound_at, new.created_at), new.created_at)
                          else c.last_inbound_at end,
      last_outbound_at = case when new.direction = 'outbound'
                          then greatest(coalesce(c.last_outbound_at, new.created_at), new.created_at)
                          else c.last_outbound_at end,
      last_ai_response = case when new.sender = 'ai' then new.body else c.last_ai_response end
  where c.id = new.conversation_id;

  -- First response time: gap between the first inbound message and the first
  -- outbound reply. Only set once.
  if new.direction = 'outbound' then
    select min(m.created_at) into v_first_inbound
    from public.messages m
    where m.conversation_id = new.conversation_id and m.direction = 'inbound';

    if v_first_inbound is not null then
      update public.conversations c
      set first_response_seconds = extract(epoch from (new.created_at - v_first_inbound))::int
      where c.id = new.conversation_id
        and c.first_response_seconds is null;
    end if;
  end if;

  -- Keep the contact's recency fresh for the "repeat caller" signal.
  if new.direction = 'inbound' then
    update public.contacts ct
    set last_seen_at = greatest(ct.last_seen_at, new.created_at)
    where ct.id = (select c.contact_id from public.conversations c where c.id = new.conversation_id);
  end if;

  return new;
end;
$$;

create trigger messages_after_insert_counters
  after insert on public.messages
  for each row execute function public.messages_after_insert();
