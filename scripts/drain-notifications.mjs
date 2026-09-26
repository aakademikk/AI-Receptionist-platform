#!/usr/bin/env node
/*
 * Drain the notification outbox once, by calling the platform's own drain route.
 *
 * Exists because the only other thing that calls that route is n8n workflow 09, and n8n
 * is optional. Without either, every owner alert is enqueued and then sits `pending` at
 * attempts = 0 for ever: nothing claims it, so nothing fails, so nothing looks wrong.
 * scripts/systemd/atwood-notify-drain.timer runs this every minute.
 *
 * Safe to run alongside workflow 09: the claim uses FOR UPDATE SKIP LOCKED, so two
 * drainers take disjoint batches rather than sending anything twice.
 *
 * Usage:
 *   node scripts/drain-notifications.mjs            # one batch of up to 50
 *   node scripts/drain-notifications.mjs --limit 10
 *
 * Reads apps/web/.env.local. The route is DRAIN_API_URL if set, otherwise
 * NEXT_PUBLIC_APP_URL; the secret is INTERNAL_API_SECRET, and it is never printed.
 *
 * Exits non-zero when the route could not be reached or refused the request, so a
 * broken drain shows up as a failed unit in `systemctl --user` and the journal rather
 * than as silence. Per-row delivery failures are not an exit failure: they are retried
 * on the next run, and the counts are printed.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '..', 'apps/web/.env.local');

if (existsSync(envFile)) process.loadEnvFile(envFile);

const base = (process.env.DRAIN_API_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim() || '')
  .replace(/\/+$/, '');
const secret = process.env.INTERNAL_API_SECRET?.trim();

if (!base || !secret) {
  console.error('Missing DRAIN_API_URL/NEXT_PUBLIC_APP_URL or INTERNAL_API_SECRET in the app environment.');
  process.exit(1);
}

const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 50;

if (!Number.isInteger(limit) || limit < 1) {
  console.error('--limit must be a positive whole number.');
  process.exit(1);
}

const url = `${base}/api/internal/v1/notifications/drain`;

let response;
try {
  response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-atwood-secret': secret,
      'x-atwood-trace-id': `atw_drain_${Date.now()}`,
    },
    body: JSON.stringify({ limit }),
    signal: AbortSignal.timeout(120_000),
  });
} catch (error) {
  console.error(`Drain request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const text = await response.text();

if (!response.ok) {
  console.error(`Drain refused: ${response.status} from ${url}: ${text.slice(0, 300)}`);
  process.exit(1);
}

let result;
try {
  result = JSON.parse(text);
} catch {
  console.error(`Drain returned ${response.status} but not JSON from ${url}: ${text.slice(0, 300)}`);
  process.exit(1);
}

const { claimed = 0, sent = 0, failed = 0, suppressed = 0 } = result;
const line = JSON.stringify({ message: 'notification drain', claimed, sent, failed, suppressed });

// Silent when the outbox was empty: this runs 1,440 times a day, and systemd already
// records each run's exit status.
if (failed > 0) console.warn(line);
else if (claimed > 0) console.log(line);
