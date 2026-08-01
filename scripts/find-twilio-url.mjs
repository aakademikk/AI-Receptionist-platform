#!/usr/bin/env node
/**
 * `pnpm twilio:find` — work out what Twilio actually signed.
 *
 * A rejected `X-Twilio-Signature` says nothing about which of its three inputs is
 * wrong, and the console shows you the value you believe is correct. This takes a
 * request the app has already rejected and searches the plausible space offline:
 * every URL a console entry might hold, and every way the body might reasonably have
 * been decoded. Whichever combination reproduces the signature is, by definition,
 * what Twilio signed.
 *
 * Nothing leaves the machine, and the token is read from apps/web/.env.local rather
 * than passed on the command line, where it would land in shell history.
 *
 * Usage — copy the three values from a `Twilio raw body` / `Twilio signature payload`
 * pair in the debug log:
 *
 *   pnpm twilio:find --url "https://…/api/webhooks/twilio/sms" \
 *                    --signature "I04Hm2cGWqU6VUl2eBw9ihLqUO8=" \
 *                    --body "ToCountry=GB&ToState=&…"
 *
 * Add --also-host to try another hostname (a previous tunnel, say).
 */

import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const url = arg('url');
const signature = arg('signature');
const body = arg('body');
const alsoHost = arg('also-host');

if (!url || !signature || !body) {
  console.error('\nNeed --url, --signature and --body. See the header of this file.\n');
  process.exit(1);
}

/* -- The token, from the file the app reads ------------------------------------- */

const envPath = path.join(ROOT, 'apps', 'web', '.env.local');
if (!existsSync(envPath)) {
  console.error(`\nNo ${path.relative(ROOT, envPath)} — nothing to read the token from.\n`);
  process.exit(1);
}

let token;
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^\s*TWILIO_AUTH_TOKEN\s*=\s*(.*)$/.exec(line);
  if (m) token = m[1].trim().replace(/^["']|["']$/g, '');
}
if (!token) {
  console.error('\nTWILIO_AUTH_TOKEN is not set in apps/web/.env.local.\n');
  process.exit(1);
}

/* -- Candidate parameter decodings ---------------------------------------------- */

/*
 * Two readings of the same bytes. Standard form decoding treats `+` as a space, which
 * is correct for a body Twilio encoded — it sends `%2B` for a literal plus. The
 * alternative exists only to rule out a chain that decoded the body before we saw it,
 * which would make every phone number arrive with a leading space and produce exactly
 * this failure at exactly this length.
 */
const decodings = {
  'standard form decoding': (raw) => {
    const out = {};
    for (const [k, v] of new URLSearchParams(raw).entries()) out[k] = v;
    return out;
  },
  'plus kept literal': (raw) => {
    const out = {};
    for (const pair of raw.split('&')) {
      if (!pair) continue;
      const idx = pair.indexOf('=');
      const k = idx === -1 ? pair : pair.slice(0, idx);
      const v = idx === -1 ? '' : pair.slice(idx + 1);
      out[decodeURIComponent(k)] = decodeURIComponent(v);
    }
    return out;
  },
};

/* -- Candidate URLs -------------------------------------------------------------- */

function urlCandidates(base) {
  const parsed = new URL(base);
  const hosts = new Set([parsed.hostname]);
  if (alsoHost) hosts.add(alsoHost.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));

  const bare = parsed.pathname.replace(/\/+$/, '');
  const paths = new Set([bare, `${bare}/`, bare.toLowerCase(), parsed.pathname]);

  const out = new Set();
  for (const host of hosts) {
    for (const scheme of ['https', 'http']) {
      for (const p of paths) {
        // Explicit default ports are worth trying: some consoles store them, and the
        // signature covers the string, not the resolved address.
        for (const hostPart of [host, `${host}:${scheme === 'https' ? 443 : 80}`]) {
          out.add(`${scheme}://${hostPart}${p || '/'}${parsed.search}`);
          if (parsed.search) out.add(`${scheme}://${hostPart}${p || '/'}`);
        }
      }
    }
  }
  return out;
}

/* -- Search ---------------------------------------------------------------------- */

function sign(candidateUrl, params) {
  let payload = candidateUrl;
  for (const key of Object.keys(params).sort()) payload += key + params[key];
  return createHmac('sha1', token).update(Buffer.from(payload, 'utf8')).digest('base64');
}

console.log(`\nSearching for the URL and decoding that reproduce:\n  ${signature}\n`);

let tried = 0;
let found = null;

for (const [decodingName, decode] of Object.entries(decodings)) {
  const params = decode(body);
  for (const candidate of urlCandidates(url)) {
    tried += 1;
    if (sign(candidate, params) === signature) {
      found = { candidate, decodingName };
      break;
    }
  }
  if (found) break;
}

if (found) {
  console.log(`MATCH after ${tried} combinations.\n`);
  console.log(`  Twilio signed : ${found.candidate}`);
  console.log(`  Body decoded  : ${found.decodingName}`);
  console.log(`\n  Set that URL in the Twilio console (or point TWILIO_WEBHOOK_BASE_URL at`);
  console.log(`  its origin) and the signature will verify.\n`);
  process.exit(0);
}

console.log(`No match after ${tried} combinations.\n`);
console.log('  That is a real result, not an inconclusive one: with this token, no');
console.log('  plausible URL or decoding reproduces the signature. The signature was');
console.log('  therefore produced by a different key than the one in .env.local —');
console.log('  which points at Twilio rather than at this codebase.\n');
console.log('  Worth doing next:');
console.log('    * regenerate the auth token in the console, update .env.local, retry;');
console.log('    * or raise it with Twilio support, quoting a MessageSid from the log.\n');
process.exit(1);
