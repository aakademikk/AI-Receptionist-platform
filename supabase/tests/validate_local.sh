#!/usr/bin/env bash
# =============================================================================
# validate_local.sh — run every migration against a throwaway Postgres cluster.
#
# This is a syntax and semantics check, not a substitute for `supabase db reset`.
# It exists so schema changes can be verified in CI without a Supabase project.
#
# It stubs two things the real platform provides:
#   * the `auth` schema (auth.users, auth.uid()) — Supabase's GoTrue owns this
#   * the anon / authenticated / service_role roles
#
# If pgvector is unavailable locally, embeddings are checked as text and the
# ivfflat index is skipped; set REQUIRE_VECTOR=1 to fail instead of degrading.
# =============================================================================
set -euo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
WORKDIR="$(mktemp -d)"
PGDATA="$WORKDIR/data"
SOCKET="$WORKDIR/socket"
PORT="${PGPORT:-55432}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS="$REPO_ROOT/supabase/migrations"

cleanup() {
  "$PGBIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

mkdir -p "$SOCKET"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-p $PORT -k $SOCKET -c listen_addresses=''" -w start >/dev/null

export PGHOST="$SOCKET" PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres

psql -v ON_ERROR_STOP=1 -q <<'SQL'
-- Supabase-provided roles.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

-- Minimal GoTrue stand-in. Only the columns our triggers touch.
create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

-- In Supabase this reads the request JWT. Locally it reads a session GUC so
-- tests can impersonate a user with: set local request.jwt.claim.sub = '<uuid>';
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to authenticated, service_role;
SQL

HAS_VECTOR=0
if [ -f /usr/share/postgresql/16/extension/vector.control ]; then
  HAS_VECTOR=1
fi

if [ "$HAS_VECTOR" -eq 0 ]; then
  if [ "${REQUIRE_VECTOR:-0}" = "1" ]; then
    echo "FAIL: pgvector not installed and REQUIRE_VECTOR=1" >&2
    exit 1
  fi
  echo "note: pgvector unavailable — embeddings checked as text, ivfflat index skipped"
fi

status=0
for file in "$MIGRATIONS"/*.sql; do
  name="$(basename "$file")"
  if [ "$HAS_VECTOR" -eq 1 ]; then
    sql="$(cat "$file")"
  else
    # Degrade the two pgvector-specific constructs, leaving everything else intact.
    sql="$(sed \
      -e 's/^create extension if not exists "vector".*$/-- (pgvector shimmed)/' \
      -e 's/vector(1536)/text/' \
      "$file" | perl -0pe 's/create index knowledge_items_embedding_idx.*?lists = 100\);/-- (ivfflat index skipped: pgvector unavailable)/s')"
  fi

  if printf '%s' "$sql" | psql -v ON_ERROR_STOP=1 -q >/dev/null 2>"$WORKDIR/err"; then
    echo "  ok   $name"
  else
    echo "  FAIL $name"
    sed 's/^/       /' "$WORKDIR/err" >&2
    status=1
    break
  fi
done

if [ "$status" -ne 0 ]; then
  echo "migration validation failed" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Structural assertions: catch a table that was added without RLS, which is the
# one mistake in a multi-tenant schema that silently leaks data.
# -----------------------------------------------------------------------------
psql -v ON_ERROR_STOP=1 -q <<'SQL'
do $$
declare
  missing text[];
begin
  select array_agg(c.relname order by c.relname) into missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not c.relrowsecurity;

  if missing is not null then
    raise exception 'tables in public without RLS enabled: %', array_to_string(missing, ', ');
  end if;
end;
$$;

do $$
declare
  n int;
begin
  -- Every RLS-enabled table must actually have at least one policy, or it is
  -- simply unreadable rather than protected.
  select count(*) into n
  from pg_class c
  join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid);

  if n > 0 then
    raise exception '% RLS-enabled table(s) have no policies', n;
  end if;
end;
$$;
SQL

echo "  ok   structural assertions (RLS coverage, policy coverage)"

# -----------------------------------------------------------------------------
# Functional tests: hot path, idempotency, tenant isolation, GDPR erasure.
# -----------------------------------------------------------------------------
if [ "${SKIP_FUNCTIONAL:-0}" != "1" ]; then
  if psql -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/tests/functional.sql" \
       >"$WORKDIR/func.out" 2>&1; then
    echo "  ok   functional tests"
  else
    echo "  FAIL functional tests"
    sed 's/^/       /' "$WORKDIR/func.out" >&2
    exit 1
  fi
fi

echo "schema validation passed"
