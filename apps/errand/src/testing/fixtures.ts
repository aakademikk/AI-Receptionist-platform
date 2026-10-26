import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
