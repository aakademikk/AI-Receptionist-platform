-- =============================================================================
-- 0008 — Privileges and Row Level Security
-- =============================================================================
-- The isolation model in one sentence: every tenant-scoped table carries
-- business_id, and every policy is `public.is_business_member(business_id)` —
-- one STABLE SECURITY DEFINER call, backed by an index on memberships.
--
-- Three actors:
--   anon           — no access to anything. Revoked outright.
--   authenticated  — dashboard users. Row-filtered by RLS, column-filtered by
--                    the explicit grants below.
--   service_role   — the internal API and n8n. Bypasses RLS by design; this is
--                    why the service key never reaches the browser.
--
-- Grants are written out in full rather than relying on Supabase's default
-- `GRANT ALL ... TO authenticated`. Two reasons:
--
--   1. A table-level GRANT cannot be narrowed afterwards. `REVOKE UPDATE (col)`
--      against a table-level UPDATE grant emits a warning and changes nothing —
--      so `users.platform_role` would stay self-assignable. Column privileges
--      only work if the table-level privilege was never granted.
--   2. Least privilege should be readable. Below, the set of tables a tenant can
--      write is a list you can audit, not an inference from policy names.
--
-- RLS filters rows; these grants filter columns and verbs. Both are load-bearing.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Lock the front door.
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all functions in schema public from anon;
revoke all on all sequences in schema public from anon;

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on functions from anon;

-- Start from zero for tenants too, then grant back deliberately.
revoke all on all tables in schema public from authenticated;

grant usage on schema public to authenticated, service_role;

-- The service role is the internal API's identity; it needs everything and
-- bypasses RLS.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;

-- =============================================================================
-- Enable RLS everywhere.
--
-- A table without RLS in a multi-tenant database is a data breach waiting for a
-- bug, so this list must stay exhaustive — the RLS-coverage assertion in
-- supabase/tests/validate_local.sh fails the build if a table is missing.
-- =============================================================================
alter table public.businesses               enable row level security;
alter table public.users                    enable row level security;
alter table public.memberships              enable row level security;
alter table public.invitations              enable row level security;
alter table public.integration_credentials  enable row level security;
alter table public.api_keys                 enable row level security;
alter table public.business_profiles        enable row level security;
alter table public.business_settings        enable row level security;
alter table public.services                 enable row level security;
alter table public.service_areas            enable row level security;
alter table public.opening_hours            enable row level security;
alter table public.opening_hours_overrides  enable row level security;
alter table public.knowledge_items          enable row level security;
alter table public.phone_numbers            enable row level security;
alter table public.contacts                 enable row level security;
alter table public.calls                    enable row level security;
alter table public.conversations            enable row level security;
alter table public.messages                 enable row level security;
alter table public.leads                    enable row level security;
alter table public.appointments             enable row level security;
alter table public.notification_recipients  enable row level security;
alter table public.notifications            enable row level security;
alter table public.ai_logs                  enable row level security;
alter table public.analytics_daily          enable row level security;
alter table public.audit_logs               enable row level security;
alter table public.onboarding_jobs          enable row level security;
alter table public.gdpr_requests            enable row level security;

-- Force RLS even for the table owner, so a stray `set role postgres` in a
-- migration cannot silently cross tenants.
alter table public.conversations force row level security;
alter table public.messages      force row level security;
alter table public.leads         force row level security;
alter table public.contacts      force row level security;

-- =============================================================================
-- SELECT grants
--
-- Two tables are column-restricted because they hold secrets: api_keys.key_hash
-- and integration_credentials.ciphertext are never granted to a tenant at all.
-- =============================================================================
grant select on
  public.businesses,
  public.users,
  public.memberships,
  public.invitations,
  public.business_profiles,
  public.business_settings,
  public.services,
  public.service_areas,
  public.opening_hours,
  public.opening_hours_overrides,
  public.knowledge_items,
  public.phone_numbers,
  public.contacts,
  public.calls,
  public.conversations,
  public.messages,
  public.leads,
  public.appointments,
  public.notification_recipients,
  public.notifications,
  public.ai_logs,
  public.analytics_daily,
  public.audit_logs,
  public.onboarding_jobs,
  public.gdpr_requests
to authenticated;

-- Secrets: metadata columns only. Note the absence of `ciphertext` and `key_hash`.
grant select (id, business_id, provider, label, key_version, public_metadata,
              expires_at, last_used_at, created_at, updated_at)
  on public.integration_credentials to authenticated;

grant select (id, business_id, name, key_prefix, scopes, created_by,
              last_used_at, expires_at, revoked_at, created_at)
  on public.api_keys to authenticated;

-- =============================================================================
-- Write grants — the complete list of what a tenant user may mutate.
-- =============================================================================

-- Full CRUD (row access still gated by policy + role).
grant insert, update, delete on
  public.memberships,
  public.invitations,
  public.services,
  public.service_areas,
  public.opening_hours,
  public.opening_hours_overrides,
  public.knowledge_items,
  public.phone_numbers,
  public.contacts,
  public.leads,
  public.appointments,
  public.notification_recipients,
  public.onboarding_jobs,
  public.gdpr_requests
to authenticated;

-- Profile and settings: editable, never deletable (they are 1:1 with the tenant).
grant insert, update on public.business_profiles, public.business_settings to authenticated;

-- The business record: a narrow column list. Notably absent — `status`, `plan`,
-- `slug`, and the billing columns, which only the platform may change.
grant update (name, timezone, locale, default_region, currency)
  on public.businesses to authenticated;

-- Own profile only, and `platform_role` is not in the list, so nobody can
-- promote themselves to platform staff.
grant update (full_name, avatar_url, phone, last_seen_at)
  on public.users to authenticated;

-- Conversations are created by inbound traffic, never by a user. Agents may
-- triage them.
grant update (status, ai_enabled, assigned_user_id, taken_over_at, taken_over_by,
              summary, current_topic, sentiment, lead_status, handover_note,
              closed_at, metadata, confusion_count)
  on public.conversations to authenticated;

-- The transcript is append-only: INSERT, and no UPDATE or DELETE.
grant insert on public.messages to authenticated;

-- Marking an in-app notification read is the only notification write.
grant update (read_at) on public.notifications to authenticated;

-- Revoking a key is the only api_keys write.
grant update (revoked_at) on public.api_keys to authenticated;

-- Deliberately read-only for tenants: calls, ai_logs, analytics_daily,
-- audit_logs, integration_credentials. All are written by the service role.

-- =============================================================================
-- businesses
-- =============================================================================
create policy businesses_select_member on public.businesses
  for select to authenticated
  using (public.is_business_member(id));

create policy businesses_update_owner on public.businesses
  for update to authenticated
  using (public.has_business_role(id, array['owner']::member_role[]))
  with check (public.has_business_role(id, array['owner']::member_role[]));

-- Creation goes through the internal API (service role), which also creates the
-- founding membership in the same transaction. There is deliberately no INSERT
-- policy: a user must never be able to create an orphan tenant.

-- =============================================================================
-- users
-- =============================================================================
create policy users_select_self on public.users
  for select to authenticated
  using (id = auth.uid());

-- Teammates must be visible to render "assigned to" and the member list.
create policy users_select_teammates on public.users
  for select to authenticated
  using (
    exists (
      select 1
      from public.memberships mine
      join public.memberships theirs on theirs.business_id = mine.business_id
      where mine.user_id = auth.uid() and theirs.user_id = public.users.id
    )
  );

create policy users_update_self on public.users
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- =============================================================================
-- memberships & invitations
-- =============================================================================
create policy memberships_select_member on public.memberships
  for select to authenticated
  using (public.is_business_member(business_id));

create policy memberships_write_admin on public.memberships
  for all to authenticated
  using (public.has_business_role(business_id, array['owner','admin']::member_role[]))
  with check (public.has_business_role(business_id, array['owner','admin']::member_role[]));

create policy invitations_manage_admin on public.invitations
  for all to authenticated
  using (public.has_business_role(business_id, array['owner','admin']::member_role[]))
  with check (public.has_business_role(business_id, array['owner','admin']::member_role[]));

-- =============================================================================
-- integration_credentials
--
-- The column grant above already makes ciphertext unreachable. This policy adds
-- the row filter, and restricts even metadata to owners/admins — an agent has no
-- reason to know which integrations are wired up.
--
-- The dashboard reads public.integration_status, a security_invoker view over the
-- granted columns.
-- =============================================================================
create policy integration_credentials_select_metadata on public.integration_credentials
  for select to authenticated
  using (public.has_business_role(business_id, array['owner','admin']::member_role[]));

create view public.integration_status
with (security_invoker = true) as
  select id, business_id, provider, label, key_version, public_metadata,
         expires_at, last_used_at, created_at, updated_at
  from public.integration_credentials;

comment on view public.integration_status is
  'Credential metadata without ciphertext. security_invoker means the caller''s RLS and column grants apply.';

grant select on public.integration_status to authenticated;

-- =============================================================================
-- api_keys
-- =============================================================================
create policy api_keys_select_admin on public.api_keys
  for select to authenticated
  using (business_id is not null
         and public.has_business_role(business_id, array['owner','admin']::member_role[]));

create policy api_keys_revoke_admin on public.api_keys
  for update to authenticated
  using (business_id is not null
         and public.has_business_role(business_id, array['owner','admin']::member_role[]))
  with check (business_id is not null
         and public.has_business_role(business_id, array['owner','admin']::member_role[]));

-- =============================================================================
-- Profile, settings and knowledge — read for all members, write for admins.
-- =============================================================================
create policy business_profiles_select on public.business_profiles
  for select to authenticated using (public.is_business_member(business_id));

create policy business_profiles_write on public.business_profiles
  for all to authenticated
  using (public.has_business_role(business_id, array['owner','admin']::member_role[]))
  with check (public.has_business_role(business_id, array['owner','admin']::member_role[]));

create policy business_settings_select on public.business_settings
  for select to authenticated using (public.is_business_member(business_id));

create policy business_settings_write on public.business_settings
  for all to authenticated
  using (public.has_business_role(business_id, array['owner','admin']::member_role[]))
  with check (public.has_business_role(business_id, array['owner','admin']::member_role[]));

create policy services_select on public.services
  for select to authenticated using (public.is_business_member(business_id));

create policy services_write on public.services
  for all to authenticated
  using (public.has_business_role(business_id, array['owner','admin']::member_role[]))
  with check (public.has_business_role(business_id, array['owner','admin']::member_role[]));

create policy service_areas_select on public.service_areas
  for select to authenticated using (public.is_business_member(business_id));

create policy service_areas_write on public.service_areas
  for all to authenticated
  using (public.has_business_role(business_id, array['owner','admin']::member_role[]))
  with check (public.has_business_role(business_id, array['owner','admin']::member_role[]));

create policy opening_hours_select on public.opening_hours
  for select to authenticated using (public.is_business_member(business_id));

create policy opening_hours_write on public.opening_hours
  for all to authenticated
  using (public.has_business_role(business_id, array['owner','admin']::member_role[]))
  with check (public.has_business_role(business_id, array['owner','admin']::member_role[]));

create policy opening_hours_overrides_select on public.opening_hours_overrides
  for select to authenticated using (public.is_business_member(business_id));

create policy opening_hours_overrides_write on public.opening_hours_overrides
  for all to authenticated
  using (public.has_business_role(business_id, array['owner','admin']::member_role[]))
  with check (public.has_business_role(business_id, array['owner','admin']::member_role[]));

create policy knowledge_items_select on public.knowledge_items
  for select to authenticated using (public.is_business_member(business_id));

create policy knowledge_items_write on public.knowledge_items
  for all to authenticated
  using (public.has_business_role(business_id, array['owner','admin']::member_role[]))
  with check (public.has_business_role(business_id, array['owner','admin']::member_role[]));

-- =============================================================================
-- Telephony
-- =============================================================================
create policy phone_numbers_select on public.phone_numbers
  for select to authenticated using (public.is_business_member(business_id));

-- Provisioning/releasing numbers touches billing, so owner/admin only — and in
-- practice it happens through the internal API so Twilio stays in step.
create policy phone_numbers_write on public.phone_numbers
  for all to authenticated
  using (public.has_business_role(business_id, array['owner','admin']::member_role[]))
  with check (public.has_business_role(business_id, array['owner','admin']::member_role[]));

create policy calls_select on public.calls
  for select to authenticated using (public.is_business_member(business_id));

-- =============================================================================
-- Contacts, conversations, messages
-- =============================================================================
create policy contacts_select on public.contacts
  for select to authenticated using (public.is_business_member(business_id));

create policy contacts_write on public.contacts
  for all to authenticated
  using (public.has_business_role(business_id, array['owner','admin','agent']::member_role[]))
  with check (public.has_business_role(business_id, array['owner','admin','agent']::member_role[]));

create policy conversations_select on public.conversations
  for select to authenticated using (public.is_business_member(business_id));

create policy conversations_update_agent on public.conversations
  for update to authenticated
  using (public.has_business_role(business_id, array['owner','admin','agent']::member_role[]))
  with check (public.has_business_role(business_id, array['owner','admin','agent']::member_role[]));

create policy messages_select on public.messages
  for select to authenticated using (public.is_business_member(business_id));

-- A human reply written straight from the dashboard. The WITH CHECK pins sender
-- and attribution so a user cannot forge a message as the AI or as a colleague.
create policy messages_insert_human on public.messages
  for insert to authenticated
  with check (
    public.has_business_role(business_id, array['owner','admin','agent']::member_role[])
    and sender = 'human'
    and direction = 'outbound'
    and sent_by_user_id = auth.uid()
  );

-- =============================================================================
-- Leads & appointments
-- =============================================================================
create policy leads_select on public.leads
  for select to authenticated using (public.is_business_member(business_id));

create policy leads_write_agent on public.leads
  for all to authenticated
  using (public.has_business_role(business_id, array['owner','admin','agent']::member_role[]))
  with check (public.has_business_role(business_id, array['owner','admin','agent']::member_role[]));

create policy appointments_select on public.appointments
  for select to authenticated using (public.is_business_member(business_id));

create policy appointments_write_agent on public.appointments
  for all to authenticated
  using (public.has_business_role(business_id, array['owner','admin','agent']::member_role[]))
  with check (public.has_business_role(business_id, array['owner','admin','agent']::member_role[]));

-- =============================================================================
-- Notifications
-- =============================================================================
create policy notification_recipients_select on public.notification_recipients
  for select to authenticated using (public.is_business_member(business_id));

create policy notification_recipients_write on public.notification_recipients
  for all to authenticated
  using (public.has_business_role(business_id, array['owner','admin']::member_role[]))
  with check (public.has_business_role(business_id, array['owner','admin']::member_role[]));

create policy notifications_select on public.notifications
  for select to authenticated using (public.is_business_member(business_id));

create policy notifications_mark_read on public.notifications
  for update to authenticated
  using (public.is_business_member(business_id))
  with check (public.is_business_member(business_id));

-- =============================================================================
-- Observability — read-only for tenants, written by the service role.
-- =============================================================================
create policy ai_logs_select_admin on public.ai_logs
  for select to authenticated
  using (public.has_business_role(business_id, array['owner','admin']::member_role[]));

create policy analytics_daily_select on public.analytics_daily
  for select to authenticated using (public.is_business_member(business_id));

create policy audit_logs_select_admin on public.audit_logs
  for select to authenticated
  using (business_id is not null
         and public.has_business_role(business_id, array['owner','admin']::member_role[]));

-- =============================================================================
-- Onboarding & GDPR
-- =============================================================================
create policy onboarding_jobs_select on public.onboarding_jobs
  for select to authenticated using (public.is_business_member(business_id));

create policy onboarding_jobs_write on public.onboarding_jobs
  for all to authenticated
  using (public.has_business_role(business_id, array['owner','admin']::member_role[]))
  with check (public.has_business_role(business_id, array['owner','admin']::member_role[]));

create policy gdpr_requests_select on public.gdpr_requests
  for select to authenticated
  using (public.has_business_role(business_id, array['owner','admin']::member_role[]));

create policy gdpr_requests_write on public.gdpr_requests
  for all to authenticated
  using (public.has_business_role(business_id, array['owner','admin']::member_role[]))
  with check (public.has_business_role(business_id, array['owner','admin']::member_role[]));
