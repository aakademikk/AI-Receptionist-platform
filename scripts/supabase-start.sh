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
exec npx --yes supabase@2.110.0 start "$@"
