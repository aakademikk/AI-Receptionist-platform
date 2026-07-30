-- =============================================================================
-- 0001 — Extensions, enums and shared helpers
-- =============================================================================
-- Everything in this file is dependency-free and must run first. Enums are
-- declared centrally so later migrations never have to guess at a spelling,
-- and every table gets the same updated_at behaviour from one trigger fn.
-- =============================================================================

create extension if not exists "pgcrypto";      -- gen_random_uuid(), digest()
create extension if not exists "pg_trgm";       -- fuzzy search over conversations/leads
create extension if not exists "citext";        -- case-insensitive email
create extension if not exists "vector";        -- knowledge base embeddings (pgvector)

-- -----------------------------------------------------------------------------
-- Tenancy
-- -----------------------------------------------------------------------------
create type business_status as enum (
  'trialing', 'active', 'past_due', 'suspended', 'cancelled'
);

-- Role within a single business. Ordered least->most privileged in intent:
--   viewer  : read-only dashboard
--   agent   : can reply to conversations, take over from the AI
--   admin    : agent + edit profile/knowledge/settings
--   owner   : admin + billing + manage members
create type member_role as enum ('owner', 'admin', 'agent', 'viewer');

-- Platform-level role, independent of business membership.
create type platform_role as enum ('user', 'platform_admin');

create type plan_tier as enum ('trial', 'starter', 'growth', 'scale', 'enterprise');

-- -----------------------------------------------------------------------------
-- Messaging
-- -----------------------------------------------------------------------------
create type comms_channel as enum ('sms', 'whatsapp', 'voice', 'web', 'email');

create type conversation_status as enum (
  'active',            -- AI is handling it
  'waiting_for_human', -- handover triggered, nobody has picked it up
  'human_handling',    -- a human has taken over; AI is muted
  'resolved',          -- outcome reached (lead captured / booked / answered)
  'closed',            -- closed without resolution
  'archived'
);

create type message_direction as enum ('inbound', 'outbound');
create type message_sender as enum ('customer', 'ai', 'human', 'system');
create type message_status as enum (
  'queued', 'sending', 'sent', 'delivered', 'read', 'undelivered', 'failed', 'received'
);

create type handover_reason as enum (
  'customer_request', 'emergency', 'urgent', 'complaint',
  'repeated_confusion', 'low_confidence', 'keyword', 'manual',
  'ai_error', 'out_of_scope'
);

-- -----------------------------------------------------------------------------
-- Leads & bookings
-- -----------------------------------------------------------------------------
create type lead_status as enum (
  'new', 'qualifying', 'qualified', 'booked', 'nurture', 'unqualified', 'lost', 'won'
);

create type urgency_level as enum ('low', 'normal', 'high', 'emergency');

create type appointment_status as enum (
  'pending', 'confirmed', 'cancelled', 'completed', 'no_show'
);

-- -----------------------------------------------------------------------------
-- Notifications
-- -----------------------------------------------------------------------------
create type notification_channel as enum (
  'email', 'sms', 'whatsapp', 'push', 'dashboard', 'webhook', 'slack'
);

create type notification_status as enum (
  'pending', 'sending', 'sent', 'failed', 'suppressed'
);

-- Events a business owner can subscribe to.
create type notification_event as enum (
  'missed_call',
  'new_conversation',
  'new_message',
  'lead_captured',
  'lead_qualified',
  'handover_required',
  'appointment_booked',
  'appointment_cancelled',
  'daily_digest',
  'weekly_digest'
);

-- -----------------------------------------------------------------------------
-- AI
-- -----------------------------------------------------------------------------
create type ai_provider as enum ('anthropic', 'openai', 'google');

create type ai_purpose as enum (
  'reply', 'extraction', 'summary', 'handover_check', 'onboarding_extract', 'embedding'
);

create type ai_call_status as enum ('ok', 'error', 'timeout', 'refused', 'filtered');

-- -----------------------------------------------------------------------------
-- Knowledge base
-- -----------------------------------------------------------------------------
create type knowledge_kind as enum (
  'faq', 'policy', 'about', 'general', 'document', 'hours_note', 'pricing_note'
);

-- -----------------------------------------------------------------------------
-- Onboarding & audit
-- -----------------------------------------------------------------------------
create type onboarding_status as enum (
  'pending', 'scraping', 'extracting', 'awaiting_review', 'completed', 'failed'
);

create type actor_type as enum ('user', 'system', 'n8n', 'api', 'ai', 'customer');

-- =============================================================================
-- Shared helpers
-- =============================================================================

-- Standard updated_at trigger. Attached to every mutable table.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at is
  'Trigger function: stamps updated_at on every UPDATE.';

-- Normalises a phone number to loose E.164 for storage and lookup.
-- Deliberately conservative: strips formatting, keeps a leading +, and does NOT
-- attempt country inference (that happens in the application layer where we know
-- the business default region). Used by unique indexes, so it must be IMMUTABLE.
create or replace function public.normalize_phone(raw text)
returns text
language sql
immutable
as $$
  select case
    when raw is null or btrim(raw) = '' then null
    else '+' || regexp_replace(raw, '[^0-9]', '', 'g')
  end;
$$;

comment on function public.normalize_phone is
  'Loose E.164 normalisation for phone lookup keys. IMMUTABLE so it can back indexes.';

-- Slug generator used for business subdomains / white-label URLs.
create or replace function public.slugify(raw text)
returns text
language sql
immutable
as $$
  select btrim(
    regexp_replace(
      regexp_replace(lower(coalesce(raw, '')), '[^a-z0-9]+', '-', 'g'),
      '(^-+|-+$)', '', 'g'
    ),
    '-'
  );
$$;
