-- =============================================================================
-- 0002 — Tenancy: businesses, users, memberships, credentials
-- =============================================================================
-- `businesses` is the tenant root. Every other tenant-scoped table carries a
-- business_id column (denormalised where necessary) so RLS is a single indexed
-- predicate rather than a join chain — this is what makes the model hold up at
-- thousands of tenants.
-- =============================================================================

create table public.businesses (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  name            text not null,
  status          business_status not null default 'trialing',
  plan            plan_tier not null default 'trial',
  timezone        text not null default 'Europe/London',
  locale          text not null default 'en-GB',
  default_region  text not null default 'GB',   -- ISO-3166-1 alpha-2, for phone parsing
  currency        text not null default 'GBP',
  trial_ends_at   timestamptz,
  -- Billing linkage kept deliberately thin; the billing provider owns the detail.
  billing_customer_id text,
  billing_subscription_id text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint businesses_slug_format check (slug = public.slugify(slug) and length(slug) between 2 and 63)
);

comment on table public.businesses is 'Tenant root. One row per customer business.';

create index businesses_status_idx on public.businesses (status) where deleted_at is null;
create index businesses_plan_idx on public.businesses (plan) where deleted_at is null;

create trigger businesses_set_updated_at
  before update on public.businesses
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Users — a mirror of auth.users holding application-level profile data.
-- Kept separate so we never write to the auth schema and so profile reads don't
-- require elevated privileges.
-- -----------------------------------------------------------------------------
create table public.users (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         citext not null unique,
  full_name     text,
  avatar_url    text,
  phone         text,
  platform_role platform_role not null default 'user',
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.users is
  'Application mirror of auth.users. platform_role is for Atwood staff, not tenant roles.';

create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

-- Auto-provision a public.users row when someone signs up.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'avatar_url', '')
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(users.full_name, excluded.full_name);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- -----------------------------------------------------------------------------
-- Memberships — the join table that drives all RLS.
-- A user may belong to many businesses (agencies managing multiple clients).
-- -----------------------------------------------------------------------------
create table public.memberships (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id     uuid not null references public.users (id) on delete cascade,
  role        member_role not null default 'agent',
  invited_by  uuid references public.users (id) on delete set null,
  accepted_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (business_id, user_id)
);

comment on table public.memberships is
  'Grants a user access to a business. The single source of truth for RLS.';

create index memberships_user_idx on public.memberships (user_id);
create index memberships_business_idx on public.memberships (business_id);

create trigger memberships_set_updated_at
  before update on public.memberships
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Invitations — pending members who have no auth.users row yet.
-- -----------------------------------------------------------------------------
create table public.invitations (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  email       citext not null,
  role        member_role not null default 'agent',
  token_hash  text not null unique,
  invited_by  uuid references public.users (id) on delete set null,
  expires_at  timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at  timestamptz not null default now(),

  unique (business_id, email)
);

create index invitations_email_idx on public.invitations (email) where accepted_at is null;

-- -----------------------------------------------------------------------------
-- Integration credentials — per-business third-party secrets.
--
-- Values are stored as application-layer AES-256-GCM envelopes (see
-- packages/core/src/crypto/secrets.ts). The database never sees plaintext, and
-- the ciphertext column is unreadable through RLS by tenant users — only the
-- service role (the internal API and n8n) can decrypt.
-- -----------------------------------------------------------------------------
create table public.integration_credentials (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  provider     text not null,            -- 'twilio' | 'google_calendar' | 'openai' | ...
  label        text,
  ciphertext   text not null,            -- base64 AES-256-GCM envelope
  key_version  int not null default 1,   -- supports key rotation
  -- Non-secret metadata safe to render in the dashboard (account SID, calendar id…)
  public_metadata jsonb not null default '{}'::jsonb,
  expires_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  unique (business_id, provider, label)
);

comment on table public.integration_credentials is
  'Encrypted per-tenant third-party secrets. ciphertext is opaque to the database.';

create trigger integration_credentials_set_updated_at
  before update on public.integration_credentials
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- API keys — machine access to the internal API (n8n, customer integrations).
-- Only the hash is stored; the plaintext key is shown once at creation.
-- -----------------------------------------------------------------------------
create table public.api_keys (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references public.businesses (id) on delete cascade,
  name          text not null,
  key_prefix    text not null,            -- first 8 chars, for display + lookup
  key_hash      text not null unique,     -- sha256 of the full key
  scopes        text[] not null default array['read']::text[],
  created_by    uuid references public.users (id) on delete set null,
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

comment on table public.api_keys is
  'Hashed API keys. business_id NULL = platform-scoped key (used by n8n).';

create index api_keys_prefix_idx on public.api_keys (key_prefix) where revoked_at is null;
create index api_keys_business_idx on public.api_keys (business_id);

-- =============================================================================
-- RLS helper functions
--
-- These are SECURITY DEFINER and read memberships directly, which is what stops
-- the "policy on table A queries table B whose policy queries table A" recursion
-- problem. They are STABLE so the planner calls them once per query, not per row.
-- =============================================================================

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.platform_role = 'platform_admin'
  );
$$;

create or replace function public.is_business_member(target_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_business_id is not null and (
    exists (
      select 1 from public.memberships m
      where m.business_id = target_business_id
        and m.user_id = auth.uid()
    )
    or public.is_platform_admin()
  );
$$;

comment on function public.is_business_member is
  'True when the current JWT belongs to a member of the business (or platform staff).';

create or replace function public.has_business_role(
  target_business_id uuid,
  allowed_roles member_role[]
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_business_id is not null and (
    exists (
      select 1 from public.memberships m
      where m.business_id = target_business_id
        and m.user_id = auth.uid()
        and m.role = any (allowed_roles)
    )
    or public.is_platform_admin()
  );
$$;

comment on function public.has_business_role is
  'Role-gated variant of is_business_member, for write policies.';

-- Convenience for the dashboard: every business the caller can see.
create or replace function public.current_business_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.business_id from public.memberships m where m.user_id = auth.uid();
$$;

-- These helpers must never be callable by unauthenticated clients.
revoke execute on function public.is_platform_admin() from anon;
revoke execute on function public.is_business_member(uuid) from anon;
revoke execute on function public.has_business_role(uuid, member_role[]) from anon;
revoke execute on function public.current_business_ids() from anon;
