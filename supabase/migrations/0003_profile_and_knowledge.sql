-- =============================================================================
-- 0003 — Business profile, settings, and knowledge base
-- =============================================================================
-- Split into three concerns rather than one wide table:
--
--   business_profiles  — identity, branding, content (what the AI says *about*
--                        the business, and what the dashboard renders)
--   business_settings  — behaviour switches (AI model, notifications, booking,
--                        escalation). Changed by different people, at a
--                        different cadence, than the profile.
--   knowledge_*        — the retrievable corpus the AI is allowed to draw on
--
-- Services, service areas and opening hours are typed tables, not JSON. This is
-- deliberate: the core product promise is "never invent a service and never
-- invent a price", and a typed table is the only way the prompt builder can
-- enumerate exactly what exists.
-- =============================================================================

create table public.business_profiles (
  business_id       uuid primary key references public.businesses (id) on delete cascade,

  -- Identity
  legal_name        text,
  trading_name      text,
  tagline           text,
  description       text,
  industry          text,
  founded_year      int,

  -- Contact
  website_url       text,
  email             citext,
  phone             text,
  address_line1     text,
  address_line2     text,
  city              text,
  region            text,
  postcode          text,
  country           text,

  -- White-label branding
  logo_url          text,
  logo_dark_url     text,
  favicon_url       text,
  brand_primary     text not null default '#0F172A',
  brand_accent      text not null default '#2563EB',
  brand_background  text not null default '#FFFFFF',
  brand_foreground  text not null default '#0F172A',
  brand_font        text,
  custom_domain     text unique,

  -- Voice & tone injected into every prompt
  tone_of_voice     text not null default 'warm, professional, concise',
  ai_assistant_name text not null default 'Assistant',
  greeting_template text,
  signature         text,
  -- Free-form extra instructions the owner writes; appended to the system prompt
  -- inside a clearly delimited, lower-trust section.
  custom_instructions text,

  social_links      jsonb not null default '{}'::jsonb,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint brand_primary_hex check (brand_primary ~* '^#[0-9a-f]{6}$'),
  constraint brand_accent_hex check (brand_accent ~* '^#[0-9a-f]{6}$'),
  constraint brand_background_hex check (brand_background ~* '^#[0-9a-f]{6}$'),
  constraint brand_foreground_hex check (brand_foreground ~* '^#[0-9a-f]{6}$')
);

comment on table public.business_profiles is
  'One row per business: identity, branding and AI voice. 1:1 with businesses.';

create trigger business_profiles_set_updated_at
  before update on public.business_profiles
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Settings — behaviour, not content.
-- -----------------------------------------------------------------------------
create table public.business_settings (
  business_id uuid primary key references public.businesses (id) on delete cascade,

  -- === AI ===
  ai_provider          ai_provider not null default 'anthropic',
  ai_model             text not null default 'claude-opus-5',
  ai_effort            text not null default 'low',      -- low|medium|high|xhigh|max
  ai_max_output_tokens int not null default 2048,
  -- Providers that still accept sampling params; ignored for models that reject it.
  ai_temperature       numeric(3,2),
  extraction_provider  ai_provider not null default 'anthropic',
  extraction_model     text not null default 'claude-opus-5',
  ai_enabled           boolean not null default true,
  -- Hard ceiling on AI replies per conversation before forcing a human handover.
  ai_max_turns         int not null default 20,

  -- === Messaging ===
  missed_call_sms_enabled boolean not null default true,
  missed_call_sms_delay_seconds int not null default 5,
  missed_call_template text,
  after_hours_template text,
  -- Quiet hours: outbound AI messages are queued rather than sent.
  quiet_hours_enabled boolean not null default false,
  quiet_hours_start   time,
  quiet_hours_end     time,
  max_sms_segments    int not null default 3,

  -- === Escalation / handover ===
  handover_enabled       boolean not null default true,
  handover_keywords      text[] not null default array[
                           'speak to a human','real person','talk to someone','manager',
                           'complaint','urgent','emergency','solicitor','lawyer'
                         ]::text[],
  handover_on_emergency  boolean not null default true,
  handover_on_complaint  boolean not null default true,
  handover_confusion_threshold int not null default 3,
  handover_sla_minutes   int not null default 15,

  -- === Notifications ===
  notify_events        notification_event[] not null default array[
                         'missed_call','lead_captured','handover_required','appointment_booked'
                       ]::notification_event[],
  notify_channels      notification_channel[] not null default array['email','dashboard']::notification_channel[],
  digest_hour_local    int not null default 8,

  -- === Booking ===
  booking_enabled          boolean not null default false,
  booking_provider         text,                       -- 'google_calendar'
  booking_calendar_id      text,
  booking_slot_minutes     int not null default 30,
  booking_buffer_minutes   int not null default 15,
  booking_min_notice_hours int not null default 4,
  booking_max_days_ahead   int not null default 30,
  booking_requires_confirmation boolean not null default true,

  -- === Compliance ===
  data_retention_days  int not null default 730,
  recording_consent_text text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ai_effort_valid check (ai_effort in ('low','medium','high','xhigh','max')),
  constraint digest_hour_valid check (digest_hour_local between 0 and 23),
  constraint ai_max_turns_valid check (ai_max_turns between 1 and 200),
  constraint retention_valid check (data_retention_days between 30 and 3650)
);

comment on table public.business_settings is
  'Per-tenant behaviour switches: model selection, escalation rules, notifications, booking.';

create trigger business_settings_set_updated_at
  before update on public.business_settings
  for each row execute function public.set_updated_at();

-- Every business gets a profile and settings row the moment it is created, so the
-- rest of the system can assume they exist and skip null-handling everywhere.
create or replace function public.provision_business_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.business_profiles (business_id, trading_name)
  values (new.id, new.name)
  on conflict (business_id) do nothing;

  insert into public.business_settings (business_id)
  values (new.id)
  on conflict (business_id) do nothing;

  return new;
end;
$$;

create trigger businesses_provision_defaults
  after insert on public.businesses
  for each row execute function public.provision_business_defaults();

-- -----------------------------------------------------------------------------
-- Services — the authoritative list of what the business sells.
-- The AI is instructed to offer nothing outside this table.
-- -----------------------------------------------------------------------------
create table public.services (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  name         text not null,
  slug         text,
  description  text,
  category     text,
  -- Price is text, not numeric, on purpose: real businesses say "from £85" or
  -- "POA". A numeric column would force us to invent precision we don't have.
  price_text   text,
  price_from   numeric(12,2),
  price_to     numeric(12,2),
  duration_minutes int,
  is_bookable  boolean not null default false,
  is_published boolean not null default true,
  sort_order   int not null default 0,
  source_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  unique (business_id, name)
);

comment on table public.services is
  'Typed service catalogue. The prompt builder enumerates this so the AI cannot invent services or prices.';

create index services_business_idx on public.services (business_id) where is_published;
create index services_bookable_idx on public.services (business_id) where is_bookable and is_published;

create trigger services_set_updated_at
  before update on public.services
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Service areas — where the business operates.
-- -----------------------------------------------------------------------------
create table public.service_areas (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses (id) on delete cascade,
  name          text not null,
  -- Outward-code prefixes ("SW1", "M4") used for cheap in-area checks.
  postcode_prefixes text[] not null default '{}'::text[],
  radius_miles  int,
  notes         text,
  is_published  boolean not null default true,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (business_id, name)
);

create index service_areas_business_idx on public.service_areas (business_id);
create index service_areas_prefixes_idx on public.service_areas using gin (postcode_prefixes);

create trigger service_areas_set_updated_at
  before update on public.service_areas
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Opening hours — one row per weekday, plus dated overrides for holidays.
-- -----------------------------------------------------------------------------
create table public.opening_hours (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  day_of_week int not null,        -- 0 = Sunday … 6 = Saturday (matches JS getDay)
  opens_at    time,
  closes_at   time,
  is_closed   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (business_id, day_of_week),
  constraint day_of_week_valid check (day_of_week between 0 and 6),
  constraint hours_present_unless_closed check (
    is_closed or (opens_at is not null and closes_at is not null)
  )
);

create trigger opening_hours_set_updated_at
  before update on public.opening_hours
  for each row execute function public.set_updated_at();

create table public.opening_hours_overrides (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  on_date     date not null,
  opens_at    time,
  closes_at   time,
  is_closed   boolean not null default true,
  label       text,
  created_at  timestamptz not null default now(),

  unique (business_id, on_date)
);

create index opening_hours_overrides_lookup_idx
  on public.opening_hours_overrides (business_id, on_date);

-- -----------------------------------------------------------------------------
-- Knowledge items — FAQs, policies, about copy, scraped page chunks.
-- One table with a `kind` discriminator keeps retrieval simple: a single query
-- returns everything relevant regardless of source.
-- -----------------------------------------------------------------------------
create table public.knowledge_items (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  kind         knowledge_kind not null default 'faq',
  title        text,
  content      text not null,
  -- Optional 1536-dim embedding (text-embedding-3-small / voyage-3-lite class).
  -- Nullable so keyword-only tenants cost nothing extra.
  embedding    vector(1536),
  source_url   text,
  tags         text[] not null default '{}'::text[],
  is_published boolean not null default true,
  -- Set when Firecrawl created the row and a human has not yet approved it.
  needs_review boolean not null default false,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint knowledge_content_not_blank check (length(btrim(content)) > 0)
);

comment on table public.knowledge_items is
  'Retrievable corpus for the AI: FAQs, policies, about copy, scraped chunks.';

create index knowledge_items_business_idx
  on public.knowledge_items (business_id, kind) where is_published;

-- Trigram index powers keyword retrieval without requiring embeddings.
create index knowledge_items_content_trgm_idx
  on public.knowledge_items using gin (content gin_trgm_ops);

create index knowledge_items_title_trgm_idx
  on public.knowledge_items using gin (title gin_trgm_ops);

-- IVFFlat for vector search. Tune `lists` upward as the corpus grows
-- (rule of thumb: rows/1000, min 10). Only used when embeddings are populated.
create index knowledge_items_embedding_idx
  on public.knowledge_items using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create trigger knowledge_items_set_updated_at
  before update on public.knowledge_items
  for each row execute function public.set_updated_at();
