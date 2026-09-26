#!/usr/bin/env bash
#
# Drain the AI receptionist's notification outbox.
#
# The platform enqueues an owner alert whenever something happens that the business
# needs to know about — a missed call, a captured lead, a handover request. Writing
# the row is the easy half and it has always worked. Delivering it is the other
# half, and until now nothing on this machine ever ran it: the queue had ten
# undelivered emails in it, the oldest 29 days old, every one with `attempts = 0` —
# not failing, simply never attempted.
#
# The delivery logic itself already exists and lives in the platform
# (`drainNotifications` in packages/core, behind POST /api/internal/v1/notifications/drain).
# The repo ships an n8n workflow — "Atwood — 09 Notification Engine" — whose entire
# content is a one-minute schedule trigger pointed at that endpoint. It is a cron and
# nothing more, and the n8n instance running on this box does not have it loaded.
#
# So this script replaces it, because a scheduled POST does not need a workflow
# engine, and making the product's core promise depend on an n8n container that
# nobody is watching is how it came to be silently broken for a month.
#
# Draining is safe to run concurrently and safe to run often: `claim_notifications`
# claims with FOR UPDATE SKIP LOCKED, so overlapping runs take disjoint batches
# rather than sending anything twice.
#
# The secret is never passed as an argument. A command line is world-readable via
# `ps`, so the header is fed to curl through a config file on stdin instead.

set -euo pipefail

# Deliberately NOT ATWOOD_API_URL. That name is already in the shared env file,
# set to `host.docker.internal` so the n8n container can reach the host — a name
# that does not resolve from a process running on the host itself. systemd lets
# EnvironmentFile= override Environment=, so inheriting it here is not something
# the unit can defend against; a separate name is the fix. This always talks to
# the local app.
BASE_URL="${ATWOOD_DRAIN_URL:-http://127.0.0.1:3001}"
LIMIT="${ATWOOD_DRAIN_LIMIT:-25}"

if [[ -z "${INTERNAL_API_SECRET:-}" ]]; then
  echo "atwood-drain: INTERNAL_API_SECRET is not set; refusing to call the internal API" >&2
  exit 78 # EX_CONFIG
fi

# --fail-with-body so an HTTP error still shows the API's own message (which never
# contains the secret) rather than a bare exit code.
response="$(
  printf 'header = "x-atwood-secret: %s"\n' "$INTERNAL_API_SECRET" |
    curl --silent --show-error --fail-with-body \
      --max-time 60 \
      --config - \
      --header 'content-type: application/json' \
      --data "{\"limit\":${LIMIT}}" \
      "${BASE_URL}/api/internal/v1/notifications/drain"
)"

# One line per run, so `journalctl --user -u atwood-notify-drain` reads as a history
# of what was delivered rather than a wall of JSON.
echo "atwood-drain: ${response}"
