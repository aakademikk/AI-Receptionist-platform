#!/usr/bin/env node
/*
 * Read — and optionally change — a Twilio number's webhook routing.
 *
 * Exists because switching a number to the conversational voice path and back is a console
 * chore that is easy to half-do, and because the value to *restore* should be read from the
 * account rather than remembered. It never prints a credential: the account SID, auth token
 * and messaging service SID are used but never echoed.
 *
 * Usage:
 *   node scripts/twilio-number.mjs --show
 *   node scripts/twilio-number.mjs --set-voice <url>     # prints the old value first
 *   node scripts/twilio-number.mjs --restore             # puts back the last --set-voice old value
 *
 * The number is read from TWILIO_PHONE_NUMBER, or passed with --number +44...
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const envFile = resolve(root, 'apps/web/.env.local');
const savedFile = resolve(root, 'scripts/.twilio-number-previous.json');

if (existsSync(envFile)) process.loadEnvFile(envFile);

const apiBase = (process.env.TWILIO_API_BASE_URL || 'https://api.twilio.com/2010-04-01').replace(/\/+$/, '');
const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();

if (!accountSid || !authToken) {
  console.error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in the app environment.');
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = args[0];
const number = (args.includes('--number') ? args[args.indexOf('--number') + 1] : null)
  ?? process.env.TWILIO_PHONE_NUMBER?.trim();

if (!number) {
  console.error('No number given. Set TWILIO_PHONE_NUMBER or pass --number +44...');
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

async function call(path, init = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { Authorization: auth, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 400) }; }
  if (!res.ok) {
    console.error(`Twilio API ${res.status}: ${body.message ?? JSON.stringify(body)}`);
    process.exit(1);
  }
  return body;
}

/** The number's resource SID, which the update call needs. */
async function findNumber() {
  const list = await call(
    `/Accounts/${accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`,
  );
  const found = list.incoming_phone_numbers?.[0];
  if (!found) {
    console.error(`No incoming number matching ${number} on this account.`);
    process.exit(1);
  }
  return found;
}

function report(n) {
  console.log(`  number   ${n.phone_number}`);
  console.log(`  sid      ${n.sid}`);
  console.log(`  voice    ${n.voice_method?.toUpperCase() ?? 'POST'} ${n.voice_url ?? '(none)'}`);
  console.log(`  sms      ${n.sms_method?.toUpperCase() ?? 'POST'} ${n.sms_url ?? '(none)'}`);
  if (n.status_callback) console.log(`  status   ${n.status_callback}`);
}

const current = await findNumber();

if (flag === '--show' || !flag) {
  console.log('Current routing:');
  report(current);
  process.exit(0);
}

if (flag === '--set-voice') {
  const url = args[1];
  if (!url) { console.error('--set-voice needs a URL.'); process.exit(1); }

  // Remember what to put back, before changing anything.
  writeFileSync(
    savedFile,
    JSON.stringify({ sid: current.sid, voice_url: current.voice_url, voice_method: current.voice_method }, null, 2),
  );

  console.log('Before (saved for --restore):');
  report(current);

  const updated = await call(`/Accounts/${accountSid}/IncomingPhoneNumbers/${current.sid}.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ VoiceUrl: url, VoiceMethod: 'POST' }).toString(),
  });

  console.log('\nAfter:');
  report(updated);
  console.log(`\nRun "node scripts/twilio-number.mjs --restore" to put the previous value back.`);
  process.exit(0);
}

if (flag === '--restore') {
  if (!existsSync(savedFile)) { console.error('Nothing saved to restore.'); process.exit(1); }
  const saved = JSON.parse(readFileSync(savedFile, 'utf8'));

  const updated = await call(`/Accounts/${accountSid}/IncomingPhoneNumbers/${saved.sid}.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      VoiceUrl: saved.voice_url ?? '',
      VoiceMethod: saved.voice_method ?? 'POST',
    }).toString(),
  });

  console.log('Restored:');
  report(updated);
  process.exit(0);
}

console.error(`Unknown option ${flag}. Use --show, --set-voice <url>, or --restore.`);
process.exit(1);
