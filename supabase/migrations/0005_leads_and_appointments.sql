-- =============================================================================
-- 0005 — Leads and appointments
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Leads — the structured extraction output.
--
-- One lead per conversation, upserted after every inbound message. Modelling it
-- as an upsert target (rather than an append-only extraction log) means the
-- dashboard always reads the latest, most complete picture with no aggregation,
-- and the raw per-run output is preserved in ai_logs for debugging.
-- -----------------------------------------------------------------------------
create table public.leads (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  contact_id      uuid references public.contacts (id) on delete set null,

  -- The extracted fields, matching the extraction JSON schema exactly.
  name            text,
  phone           text,
  email           citext,
  postcode        text,
  service_id      uuid references public.services (id) on delete set null,
  service_text    text,            -- what the customer actually said
  enquiry         text,
  summary         text,
  urgency         urgency_level not null default 'normal',
  status          lead_status not null default 'new',
  callback_at     timestamptz,
  callback_text   text,            -- "tomorrow afternoon" — unparsed original

  -- Scoring. completeness is derived (how many key fields we have); score is a
  -- weighted business value the owner can sort by.
  completeness    numeric(4,3) not null default 0,
  score           int not null default 0,

  source          text,
  -- Full extraction payload from the most recent run, for audit and re-processing.
  raw_extraction  jsonb not null default '{}'::jsonb,
  extraction_version int not null default 1,
  extracted_at    timestamptz,

  -- Human follow-up
  owner_user_id   uuid references public.users (id) on delete set null,
  notes           text,
  contacted_at    timestamptz,
  won_at          timestamptz,
  lost_at         timestamptz,
  lost_reason     text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- One lead per conversation: makes the extractor a clean upsert.
  unique (conversation_id),
  constraint completeness_range check (completeness between 0 and 1),
  constraint score_range check (score between 0 and 100)
);

comment on table public.leads is
  'Structured lead extracted from a conversation. Upserted on conversation_id after each inbound message.';

create index leads_business_created_idx on public.leads (business_id, created_at desc);
create index leads_business_status_idx on public.leads (business_id, status, created_at desc);
create index leads_qualified_idx
  on public.leads (business_id, created_at desc)
  where status in ('qualified', 'booked', 'won');
create index leads_urgency_idx
  on public.leads (business_id, urgency, created_at desc)
  where urgency in ('high', 'emergency');
create index leads_contact_idx on public.leads (contact_id);
create index leads_callback_idx
  on public.leads (business_id, callback_at)
  where callback_at is not null and status not in ('won', 'lost', 'unqualified');
create index leads_search_idx on public.leads using gin (
  (coalesce(name, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(email::text, '') || ' ' || coalesce(summary, ''))
  gin_trgm_ops
);

create trigger leads_set_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at();

-- Keep the conversation's denormalised lead_status in step with the lead, so the
-- conversation list can filter by lead status without a join.
create or replace function public.leads_sync_conversation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.conversations c
  set lead_status = new.status,
      customer_name = coalesce(new.name, c.customer_name)
  where c.id = new.conversation_id
    and (c.lead_status is distinct from new.status
         or (new.name is not null and c.customer_name is distinct from new.name));
  return new;
end;
$$;

create trigger leads_sync_conversation_status
  after insert or update of status, name on public.leads
  for each row execute function public.leads_sync_conversation();

-- Completeness is mechanical — derive it rather than trusting the model to score
-- its own output.
create or replace function public.leads_compute_completeness()
returns trigger
language plpgsql
as $$
declare
  filled int := 0;
  total  int := 7;
begin
  if nullif(btrim(coalesce(new.name, '')), '') is not null then filled := filled + 1; end if;
  if nullif(btrim(coalesce(new.phone, '')), '') is not null then filled := filled + 1; end if;
  if new.email is not null then filled := filled + 1; end if;
  if nullif(btrim(coalesce(new.postcode, '')), '') is not null then filled := filled + 1; end if;
  if new.service_id is not null or nullif(btrim(coalesce(new.service_text, '')), '') is not null
    then filled := filled + 1; end if;
  if nullif(btrim(coalesce(new.enquiry, '')), '') is not null then filled := filled + 1; end if;
  if new.callback_at is not null or nullif(btrim(coalesce(new.callback_text, '')), '') is not null
    then filled := filled + 1; end if;

  new.completeness := round(filled::numeric / total, 3);
  return new;
end;
$$;

create trigger leads_completeness
  before insert or update on public.leads
  for each row execute function public.leads_compute_completeness();

-- -----------------------------------------------------------------------------
-- Appointments — optional, driven by the booking engine.
-- -----------------------------------------------------------------------------
create table public.appointments (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  lead_id         uuid references public.leads (id) on delete set null,
  contact_id      uuid references public.contacts (id) on delete set null,
  service_id      uuid references public.services (id) on delete set null,

  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  timezone        text not null default 'Europe/London',
  status          appointment_status not null default 'pending',

  -- Snapshot of who the appointment is for; survives contact deletion.
  customer_name   text,
  customer_phone  text,
  customer_email  citext,
  location        text,
  notes           text,

  -- Calendar provider linkage
  provider        text,               -- 'google_calendar'
  calendar_id     text,
  provider_event_id text,

  confirmed_at    timestamptz,
  cancelled_at    timestamptz,
  cancelled_by    actor_type,
  cancel_reason   text,
  reminder_sent_at timestamptz,

  created_by      actor_type not null default 'ai',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint appointment_time_order check (ends_at > starts_at),
  unique (provider, provider_event_id)
);

comment on table public.appointments is
  'Bookings created by the AI or a human. provider_event_id links to the external calendar.';

create index appointments_business_start_idx on public.appointments (business_id, starts_at);
create index appointments_upcoming_idx
  on public.appointments (business_id, starts_at)
  where status in ('pending', 'confirmed');
create index appointments_conversation_idx on public.appointments (conversation_id);
create index appointments_reminder_due_idx
  on public.appointments (starts_at)
  where status = 'confirmed' and reminder_sent_at is null;

create trigger appointments_set_updated_at
  before update on public.appointments
  for each row execute function public.set_updated_at();

-- Booking an appointment moves the lead to 'booked' — the owner should never have
-- to do this by hand.
create or replace function public.appointments_sync_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.lead_id is not null and new.status in ('pending', 'confirmed') then
    update public.leads l
    set status = 'booked'
    where l.id = new.lead_id
      and l.status not in ('won', 'lost');
  end if;
  return new;
end;
$$;

create trigger appointments_sync_lead_status
  after insert or update of status on public.appointments
  for each row execute function public.appointments_sync_lead();
