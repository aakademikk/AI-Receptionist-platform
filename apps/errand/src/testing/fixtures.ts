import { createHmac } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Brief } from '../brief.ts';
import { FIXED_LIMITS } from '../brief.ts';

/**
 * Shared test fixtures. Imported by tests only; nothing here runs in the service.
 *
 * Every number is from Ofcom's drama ranges (07700 900xxx, 020 7946 0xxx), which are
 * reserved for fiction and can never reach a real line.
 */

export const COLIN_MOBILE = '+447700900123';

export function sampleBrief(overrides: Partial<Brief> = {}): Brief {
  return {
    business: "Luigi's",
    number: '020 7946 0123',
    goal: 'book a table for two',
    goalKind: 'table',
    window: { date: '2026-10-28', earliest: '19:00', latest: '20:30' },
    details: { partySize: 2 },
    contact: { name: 'Colin Wood', mobile: COLIN_MOBILE },
    limits: { fixed: [...FIXED_LIMITS], added: [] },
    ...overrides,
  };
}

/** A fresh temp folder and a function that removes it. */
export function tempDir(prefix = 'errand-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Play the bridge: set the answer fields on a question in a temp closer store, the way
 * `closer_answer.py` does when Colin taps. Test-only; the live file is never written here.
 */
export function bridgeAnswer(
  store: string,
  jobId: string,
  questionId: string,
  answer: { state?: string; result?: string | null; answeredAt?: string | null; answeredVia?: string | null; text?: string; options?: string[] },
): void {
  const path = join(store, jobId, 'closer.json');
  const record = JSON.parse(readFileSync(path, 'utf8')) as { questions: Array<Record<string, unknown>> };
  const question = record.questions.find((item) => item.id === questionId);
  if (!question) throw new Error('no such question in the fake store');
  Object.assign(question, answer);
  writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });
}

/** Append a `sam-push` send entry for a question to a temp push-log. */
export function pushLogEntry(path: string, questionId: string, jobId: string, ts: number): void {
  appendFileSync(path, `${JSON.stringify({ id: `p${ts}`, ts, title: 'Errand read-back', questionId, jobId, tag: `q-${questionId}` })}\n`);
}

/** Twilio's signing scheme, for tests: HMAC-SHA1 over the URL plus sorted key+value pairs, base64. */
export function twilioSign(token: string, url: string, params: Record<string, string> = {}): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', token).update(Buffer.from(payload, 'utf8')).digest('base64');
}

export const TEST_TOKEN = 'test-token-0123456789abcdef012345';
export const PUBLIC = 'https://receptionist.atwoodsystems.co.uk';

/** Listen on an ephemeral loopback port; resolves to the port. */
export function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

/** POST a form to the test server, signed as Twilio would sign the public URL (or with `signature` given). */
export async function postForm(
  port: number,
  pathAndQuery: string,
  params: Record<string, string>,
  options: { signature?: string | null; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  const signature = options.signature === undefined ? twilioSign(TEST_TOKEN, `${PUBLIC}${pathAndQuery}`, params) : options.signature;
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', ...options.headers };
  if (signature !== null) headers['x-twilio-signature'] = signature;
  const response = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, { method: 'POST', headers, body: new URLSearchParams(params) });
  return { status: response.status, body: await response.text() };
}
