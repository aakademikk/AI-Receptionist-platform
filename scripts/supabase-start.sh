#!/usr/bin/env bash
#
# Start the local Supabase stack with the variables config.toml needs.
#
# `[auth.email.smtp]` references `env(RESEND_API_KEY)` and
# `env(NOTIFICATION_FROM_EMAIL)` so no secret is ever written into a file that is
# committed. Measured on CLI 2.110, that substitution reads the **process
# environment only** — a .env file in the working directory is not loaded — and an
# unresolved `env()` in a string field is **not an error**: it silently becomes an
# empty string. A bare `supabase start` therefore hands GoTrue an empty SMTP
# password and every magic link fails quietly, which looks identical to a mail
# provider problem.
#
# So this wrapper does two things: injects the values, and refuses to start
# without them. Loud beats quiet.
#
# Same parser as ~/.local/bin/receptionist-app.mjs, for the same reason: sourcing
# a dotenv in bash breaks on a value containing a space, quote or '#', and this
# file is already proven against the real one. Values are read into the
# environment and never printed.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/apps/web/.env.local"
NODE="${ATWOOD_NODE:-/home/col/.local/node/bin/node}"

# The variables config.toml interpolates. Add to this list when config.toml grows
# another env() — the guard below is only as good as this list.
REQUIRED=(RESEND_API_KEY NOTIFICATION_FROM_EMAIL)

[[ -f "$ENV_FILE" ]] || { echo "supabase-start: no env file at $ENV_FILE" >&2; exit 66; }
[[ -x "$NODE" ]] || { echo "supabase-start: node not found at $NODE" >&2; exit 69; }

# Export the ones we need, and only those. Printed output is variable NAMES with a
# set/missing verdict — never a value.
READER="$ROOT/scripts/lib/read-env-vars.mjs"
[[ -f "$READER" ]] || { echo "supabase-start: missing $READER" >&2; exit 66; }

while IFS= read -r line; do
  [[ -n "$line" ]] && export "${line?}"
done < <("$NODE" "$READER" "$ENV_FILE" "${REQUIRED[@]}")

missing=()
for name in "${REQUIRED[@]}"; do
  [[ -n "${!name:-}" ]] || missing+=("$name")
done

if (( ${#missing[@]} > 0 )); then
  echo "supabase-start: refusing to start — these are empty or absent in the env file:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo "Auth email would silently fail rather than error, so this stops here." >&2
  exit 78 # EX_CONFIG
fi

echo "supabase-start: ${#REQUIRED[@]} variables present; starting the stack"
cd "$ROOT"
# No `exec`: the port check below has to run after the stack is up.
npx --yes supabase@2.110.0 start "$@"

# Guard (2026-10-16, LAN exposure): Docker publishes on 0.0.0.0 by default and that
# bypasses ufw, which left Postgres and Studio open to the wifi from 17 Sep. The
# durable fix is "ip": "127.0.0.1" in /etc/docker/daemon.json; this catches the day
# that file is lost (a Docker reinstall, say). Fail loudly rather than carry on.
if ! ports=$(docker ps --filter "label=com.supabase.cli.project=atwood-systems" --format '{{.Ports}}'); then
  echo "supabase-start: could not read container ports from docker, so the loopback check did not run" >&2
  exit 1
fi
if grep -qE '(^|[ ,])(0\.0\.0\.0|\[::\]):' <<< "$ports"; then
  echo "supabase-start: ports published beyond loopback (0.0.0.0 or [::]):" >&2
  grep -oE '(0\.0\.0\.0|\[::\]):[0-9]+' <<< "$ports" | sort -u | sed 's/^/  /' >&2
  echo 'Anything on the wifi can reach these. Set "ip": "127.0.0.1" in /etc/docker/daemon.json and restart Docker.' >&2
  exit 1
fi
echo "supabase-start: all published ports are on loopback"
