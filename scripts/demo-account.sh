#!/usr/bin/env bash
#
# Give a prospect a read-only login to a demo tenant.
#
#   scripts/demo-account.sh --email andy@acbennett.co.uk --name "Andy Bennett"
#
# They then sign in at /login with that address. No password exists — the app is
# magic-link only — so nothing here mints, prints or stores a credential.
#
# `viewer` by default, which is the whole point of a demo account: every page an
# owner sees, and no ability to change the tenant. Pass --role to override, but
# think before you do — anything above `viewer` lets a stranger edit the demo
# business that every other prospect is also being shown.
#
# The database is the local Supabase stack's Postgres container, not a host
# psql: there is no psql on this box, and the container is where the data lives.

set -euo pipefail

CONTAINER="${ATWOOD_DB_CONTAINER:-supabase_db_atwood-systems}"
SQL_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/supabase/one-off/demo-account.sql"

EMAIL=""
FULL_NAME=""
SLUG="volta"
ROLE="viewer"

usage() {
  cat >&2 <<'USAGE'
Usage: demo-account.sh --email <address> [--name "<full name>"] [--slug <tenant>] [--role <role>]

  --email  the prospect's real address; it is where their sign-in link goes
  --name   shown in the dashboard; optional
  --slug   tenant to grant access to (default: volta)
  --role   owner | admin | agent | viewer (default: viewer)

Running it twice for the same address is safe — it updates the membership
rather than creating a second account.
USAGE
  exit 64 # EX_USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email) EMAIL="${2:-}"; shift 2 ;;
    --name)  FULL_NAME="${2:-}"; shift 2 ;;
    --slug)  SLUG="${2:-}"; shift 2 ;;
    --role)  ROLE="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "demo-account: unknown argument '$1'" >&2; usage ;;
  esac
done

[[ -n "$EMAIL" ]] || { echo "demo-account: --email is required" >&2; usage; }

# Checked here as well as in the SQL, so a typo fails before a transaction opens
# rather than inside one.
case "$ROLE" in
  owner|admin|agent|viewer) ;;
  *) echo "demo-account: --role must be owner, admin, agent or viewer (got '$ROLE')" >&2; exit 64 ;;
esac

if [[ "$ROLE" != "viewer" ]]; then
  echo "demo-account: WARNING — '$ROLE' can change the demo tenant that every" >&2
  echo "              other prospect is also shown. 'viewer' is the safe default." >&2
fi

[[ -f "$SQL_FILE" ]] || { echo "demo-account: cannot find $SQL_FILE" >&2; exit 66; }

docker exec -i "$CONTAINER" psql \
  --username postgres \
  --dbname postgres \
  --quiet \
  --set ON_ERROR_STOP=on \
  --set "email=$EMAIL" \
  --set "full_name=$FULL_NAME" \
  --set "slug=$SLUG" \
  --set "role=$ROLE" \
  < "$SQL_FILE"

cat <<EOF

Done. $EMAIL can now sign in as '$ROLE' on '$SLUG'.

Tell them to go to /login and enter that address — the link is emailed, so it
works from their own phone or laptop with nothing to install and no password.
EOF
