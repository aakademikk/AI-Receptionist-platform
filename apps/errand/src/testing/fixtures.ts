import { mkdtempSync, rmSync } from 'node:fs';
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
