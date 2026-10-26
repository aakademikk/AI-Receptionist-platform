import { rmSync } from 'node:fs';

import { RETENTION_DAYS, errandHome } from './config.ts';
import { dialledAt, errandDir, listErrands, readOutcome } from './store.ts';

/**
 * Retention: errand folders are kept 90 days (OPEN 12), then removed by a daily timer
 * (installed at deploy, after the nightly backup; T20, T22).
 *
 * Age comes from the date in the errand id, so a folder's age cannot be reset by touching
 * it. A folder with no outcome that was dialled less than a day ago is never removed,
 * whatever its id says: that would be a call in progress or just finished, and its record is
 * not yet complete. Paths are built only from validated ids inside `ERRAND_HOME`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneResult {
  removed: string[];
  dryRun: boolean;
}

/** Whole days from the id's date (00:00 UTC) to `now`. */
export function ageInDays(errandId: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(`${errandId.slice(0, 10)}T00:00:00Z`)) / DAY_MS);
}

export function prune(now: Date, options: { dryRun?: boolean } = {}, deps: { home?: string } = {}): PruneResult {
  const home = deps.home ?? errandHome();
  const dryRun = options.dryRun === true;
  const removed: string[] = [];
  for (const id of listErrands(home)) {
    if (!(ageInDays(id, now) > RETENTION_DAYS)) continue;
    const dialled = dialledAt(id, home);
    if (!readOutcome(id, home) && dialled && now.getTime() - dialled.getTime() < DAY_MS) continue;
    if (!dryRun) rmSync(errandDir(id, home), { recursive: true, force: true });
    removed.push(id);
  }
  return { removed, dryRun };
}

export function describePrune(result: PruneResult): string {
  const verb = result.dryRun ? 'would remove' : 'removed';
  return `${verb} ${result.removed.length} errand folder(s)${result.removed.length ? `: ${result.removed.join(', ')}` : ''}`;
}
