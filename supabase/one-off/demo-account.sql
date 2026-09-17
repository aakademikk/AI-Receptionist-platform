-- =============================================================================
-- Provision a read-only demo account on a tenant.
--
-- One prospect, one account, one real email address. They type that address at
-- /login, get a magic link, and land in the dashboard as a `viewer` — every page
-- an owner sees, no ability to change anything. Per-prospect rather than one
-- shared login, because a shared account cannot be revoked for one person and
-- gives no signal about who actually looked.
--
-- Not a migration. This is tenant data for a named individual, and a fresh
-- database must not replay somebody's sales demo.
--
-- Parameters:
--   -v email='someone@theircompany.co.uk'
--   -v full_name='Their Name'
--   -v slug='volta'            -- the tenant to grant access to
--   -v role='viewer'           -- owner | admin | agent | viewer
--
-- Idempotent: running it twice for the same address updates the membership
-- rather than erroring or minting a second account.
--
-- Run it through scripts/demo-account.sh, which validates the arguments and
-- knows where the database lives.
-- =============================================================================

\set ON_ERROR_STOP on

begin;

create temp table _demo_params on commit drop as
select
  lower(trim(:'email'))::text        as email,
  nullif(trim(:'full_name'), '')     as full_name,
  trim(:'slug')::text                as slug,
  trim(:'role')::member_role         as role;

/*
 * The whole account in one block, because every step depends on the id chosen
 * in the first one.
 *
 * `instance_id` and `aud` are load-bearing, not decoration — GoTrue looks an
 * account up by (instance_id, lower(email), aud), so a row missing either is
 * invisible to sign-in. With `shouldCreateUser: false` on the login page that
 * no longer silently mints a second account; it now fails as "no such user"
 * and the prospect sees the generic "check your email" screen forever. Same
 * trap as the seed's dev login, different symptom.
 *
 * `email_confirmed_at` marks the address verified, so the first magic link is
 * a sign-in rather than a signup confirmation.
 */
do $$
declare
  p          record;
  v_user     uuid;
  v_business uuid;
  v_col      text;
  v_existing boolean := false;
begin
  select * into p from _demo_params;

  if p.email is null or p.email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'email is required and must look like an address (got %)', coalesce(p.email, '<null>');
  end if;

  select id into v_business from public.businesses where slug = p.slug;
  if v_business is null then
    raise exception 'no business with slug % — check the tenant', p.slug;
  end if;

  select id into v_user
    from auth.users
   where lower(email) = p.email
     and instance_id = '00000000-0000-0000-0000-000000000000';

  if v_user is not null then
    v_existing := true;
    raise notice 'account already exists for % — reusing it', p.email;
  else
    v_user := gen_random_uuid();

    insert into auth.users (
      instance_id, id, aud, role, email, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    )
    values (
      '00000000-0000-0000-0000-000000000000',
      v_user,
      'authenticated',
      'authenticated',
      p.email,
      now(),
      '{"provider": "email", "providers": ["email"]}'::jsonb,
      jsonb_strip_nulls(jsonb_build_object('full_name', p.full_name, 'demo_account', true)),
      now(),
      now()
    );

    /*
     * GoTrue reads several of auth.users' token columns into non-nullable Go
     * strings, so a NULL in any of them fails to scan and the request errors
     * out with something that never mentions the column. Postgres defaults
     * cover rows GoTrue creates itself; a row inserted by hand has to do it
     * deliberately. Driven off information_schema because the column set
     * differs across GoTrue versions.
     */
    for v_col in
      select column_name
        from information_schema.columns
       where table_schema = 'auth'
         and table_name = 'users'
         and is_nullable = 'YES'
         and data_type in ('character varying', 'text')
         and column_name in (
           'confirmation_token', 'recovery_token', 'email_change',
           'email_change_token_new', 'email_change_token_current',
           'phone_change', 'phone_change_token', 'reauthentication_token'
         )
    loop
      execute format(
        'update auth.users set %1$I = %2$L where id = %3$L and %1$I is null',
        v_col, '', v_user
      );
    end loop;

    /*
     * The matching identity row. A bare auth.users row is enough to be found,
     * but an email-provider account is expected to have one, and its absence
     * shows up later in account linking and in the `identities` claim. The
     * table's shape changed across GoTrue versions, so adapt rather than pin.
     */
    if to_regclass('auth.identities') is not null then
      if exists (
        select 1 from information_schema.columns
         where table_schema = 'auth'
           and table_name = 'identities'
           and column_name = 'provider_id'
      ) then
        insert into auth.identities (
          provider_id, user_id, identity_data, provider,
          last_sign_in_at, created_at, updated_at
        )
        values (
          v_user::text, v_user,
          jsonb_build_object('sub', v_user::text, 'email', p.email, 'email_verified', true),
          'email', now(), now(), now()
        )
        on conflict do nothing;
      else
        insert into auth.identities (
          id, user_id, identity_data, provider,
          last_sign_in_at, created_at, updated_at
        )
        values (
          v_user::text, v_user,
          jsonb_build_object('sub', v_user::text, 'email', p.email, 'email_verified', true),
          'email', now(), now(), now()
        )
        on conflict do nothing;
      end if;
    end if;
  end if;

  /*
   * public.users is written by the on_auth_user_created trigger. Assert it
   * rather than assume it: without that row the membership's foreign key fails,
   * and the failure would otherwise read as a membership problem rather than a
   * missing trigger.
   */
  if not exists (select 1 from public.users where id = v_user) then
    raise exception
      'public.users row missing for % — the on_auth_user_created trigger did not fire', p.email;
  end if;

  insert into public.memberships (business_id, user_id, role, accepted_at)
  values (v_business, v_user, p.role, now())
  on conflict (business_id, user_id) do update
    set role = excluded.role,
        accepted_at = coalesce(public.memberships.accepted_at, excluded.accepted_at);

  raise notice '% % as % on % (user %)',
    case when v_existing then 'Updated' else 'Created' end,
    p.email, p.role, p.slug, v_user;
end $$;

commit;

-- Read back every demo account that exists now, so the run proves itself rather
-- than being trusted. Never prints a token or a link.
select u.email,
       b.slug                                as tenant,
       m.role,
       u.raw_user_meta_data ->> 'full_name'  as full_name,
       u.created_at
  from auth.users u
  join public.memberships m on m.user_id = u.id
  join public.businesses  b on b.id = m.business_id
 where u.raw_user_meta_data ->> 'demo_account' = 'true'
 order by u.created_at;
