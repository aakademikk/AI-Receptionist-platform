-- =============================================================================
-- 0007 — Audit log, onboarding jobs, GDPR requests
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Audit log — who changed what, when.
--
-- Written by a generic trigger attached to the tables where provenance matters.
-- business_id is nullable so platform-level actions (creating a tenant) are also
-- recorded. Nobody can UPDATE or DELETE rows here: the RLS policies in 0008 grant
-- SELECT only, and writes arrive via SECURITY DEFINER triggers.
-- -----------------------------------------------------------------------------
create table public.audit_logs (
  id           bigint generated always as identity primary key,
  business_id  uuid references public.businesses (id) on delete cascade,
  actor_type   actor_type not null default 'system',
  actor_id     uuid,
  actor_label  text,          -- email / workflow name, denormalised for readability
  action       text not null, -- 'insert' | 'update' | 'delete' | 'login' | 'export' | …
  entity_type  text not null,
  entity_id    text,
  -- Only changed keys are stored, not whole rows: keeps the log small and makes
  -- diffs readable in the UI.
  changed_keys text[],
  before       jsonb,
  after        jsonb,
  ip_address   inet,
  user_agent   text,
  trace_id     text,
  created_at   timestamptz not null default now()
);

comment on table public.audit_logs is
  'Append-only provenance log. Written by triggers and the internal API; read-only to tenants.';

create index audit_logs_business_created_idx
  on public.audit_logs (business_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
create index audit_logs_actor_idx on public.audit_logs (actor_id) where actor_id is not null;

-- Generic audit trigger. Attach with:
--   create trigger x_audit after insert or update or delete on public.x
--     for each row execute function public.audit_row_change();
create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
  v_before jsonb;
  v_after  jsonb;
  v_changed text[];
  v_entity_id text;
begin
  if tg_op = 'DELETE' then
    v_before := to_jsonb(old);
    v_after := null;
    v_business_id := (v_before ->> 'business_id')::uuid;
    v_entity_id := v_before ->> 'id';
  elsif tg_op = 'INSERT' then
    v_before := null;
    v_after := to_jsonb(new);
    v_business_id := (v_after ->> 'business_id')::uuid;
    v_entity_id := v_after ->> 'id';
  else
    v_before := to_jsonb(old);
    v_after := to_jsonb(new);
    v_business_id := (v_after ->> 'business_id')::uuid;
    v_entity_id := v_after ->> 'id';

    select array_agg(key order by key) into v_changed
    from jsonb_each(v_after) a(key, value)
    where a.value is distinct from (v_before -> a.key)
      and a.key <> 'updated_at';   -- every update touches this; it is never news

    -- Nothing of substance changed: don't write a row.
    if v_changed is null or cardinality(v_changed) = 0 then
      return new;
    end if;

    -- Store only the changed subset.
    v_before := (select jsonb_object_agg(k, v_before -> k) from unnest(v_changed) k);
    v_after  := (select jsonb_object_agg(k, v_after -> k) from unnest(v_changed) k);
  end if;

  -- For tables that *are* the business (no business_id column), fall back to id.
  if v_business_id is null and tg_table_name = 'businesses' then
    v_business_id := v_entity_id::uuid;
  end if;

  insert into public.audit_logs (
    business_id, actor_type, actor_id, action, entity_type, entity_id,
    changed_keys, before, after
  ) values (
    v_business_id,
    case when auth.uid() is not null then 'user'::actor_type else 'system'::actor_type end,
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    v_entity_id,
    v_changed,
    v_before,
    v_after
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- Audit the tables where "who changed this?" is a question someone will actually
-- ask. Deliberately excludes messages/ai_logs — those are already append-only
-- records and auditing them would double storage for no information gain.
create trigger businesses_audit
  after insert or update or delete on public.businesses
  for each row execute function public.audit_row_change();

create trigger business_profiles_audit
  after insert or update or delete on public.business_profiles
  for each row execute function public.audit_row_change();

create trigger business_settings_audit
  after insert or update or delete on public.business_settings
  for each row execute function public.audit_row_change();

create trigger memberships_audit
  after insert or update or delete on public.memberships
  for each row execute function public.audit_row_change();

create trigger services_audit
  after insert or update or delete on public.services
  for each row execute function public.audit_row_change();

create trigger knowledge_items_audit
  after insert or update or delete on public.knowledge_items
  for each row execute function public.audit_row_change();

create trigger phone_numbers_audit
  after insert or update or delete on public.phone_numbers
  for each row execute function public.audit_row_change();

create trigger integration_credentials_audit
  after insert or update or delete on public.integration_credentials
  for each row execute function public.audit_row_change();

create trigger api_keys_audit
  after insert or update or delete on public.api_keys
  for each row execute function public.audit_row_change();

-- -----------------------------------------------------------------------------
-- Onboarding jobs — the Firecrawl-driven profile bootstrap.
--
-- Modelled as a durable job rather than a synchronous request because scraping a
-- site takes 30–120s, can partially fail, and the owner needs to be able to close
-- the tab and come back.
-- -----------------------------------------------------------------------------
create table public.onboarding_jobs (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses (id) on delete cascade,
  website_url   text not null,
  status        onboarding_status not null default 'pending',

  provider      text not null default 'firecrawl',
  provider_job_id text,

  -- Per-step progress so the UI can show a real checklist rather than a spinner.
  steps         jsonb not null default '[]'::jsonb,
  pages_crawled int not null default 0,
  -- Raw scrape output, kept until the owner approves so re-extraction is free.
  raw_pages     jsonb,
  -- The structured profile the extractor produced, before human review.
  extracted     jsonb,
  -- What the owner actually approved; the diff against `extracted` is useful
  -- signal for improving the extraction prompt.
  applied       jsonb,

  error_message text,
  started_at    timestamptz,
  completed_at  timestamptz,
  applied_at    timestamptz,
  created_by    uuid references public.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.onboarding_jobs is
  'Website-scrape-to-profile job. Survives page reloads; raw_pages allows re-extraction without re-crawling.';

create index onboarding_jobs_business_idx
  on public.onboarding_jobs (business_id, created_at desc);
create index onboarding_jobs_active_idx
  on public.onboarding_jobs (status)
  where status in ('pending', 'scraping', 'extracting');

create trigger onboarding_jobs_set_updated_at
  before update on public.onboarding_jobs
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- GDPR requests — subject access and erasure, tracked as first-class records.
--
-- Having this as a table (rather than an ad-hoc script) is what makes the
-- compliance story defensible: every request has a requester, a timestamp, an
-- operator, and an outcome.
-- -----------------------------------------------------------------------------
create table public.gdpr_requests (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses (id) on delete cascade,
  request_type  text not null,           -- 'access' | 'erasure' | 'rectification' | 'portability'
  subject_phone text,
  subject_email citext,
  contact_id    uuid references public.contacts (id) on delete set null,
  status        text not null default 'pending',  -- pending|in_progress|completed|rejected
  requested_by  text,                    -- who asked (may be the data subject, not a user)
  handled_by    uuid references public.users (id) on delete set null,
  -- For access/portability: where the export landed. For erasure: what was removed.
  result        jsonb,
  notes         text,
  due_at        timestamptz not null default (now() + interval '30 days'),
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint gdpr_request_type_valid
    check (request_type in ('access', 'erasure', 'rectification', 'portability')),
  constraint gdpr_subject_present
    check (subject_phone is not null or subject_email is not null or contact_id is not null)
);

create index gdpr_requests_business_idx on public.gdpr_requests (business_id, created_at desc);
create index gdpr_requests_open_idx on public.gdpr_requests (due_at)
  where status in ('pending', 'in_progress');

create trigger gdpr_requests_set_updated_at
  before update on public.gdpr_requests
  for each row execute function public.set_updated_at();
