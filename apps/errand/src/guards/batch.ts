import { execFile } from 'node:child_process';

/**
 * The robot-batch guard (must-do 5; fact F5; OPEN 9).
 *
 * The robot number is shared with the Amy speed test. A batch is a set of transient user
 * units named `robot-<variant>-<n>` scheduled by `robot-batch.sh` (`systemd-run --user`), and a
 * manual run is a `robot-run.mjs` process. While either exists, an errand must not dial: the
 * two would ring from the same number and the speed test's measurements would be spoiled.
 *
 * The guard is one-way (OPEN 9): errands look for batches, `robot-batch.sh` is not changed to
 * look for errands. It names every unit and process that blocked it, so Colin can see what is
 * running. If either listing cannot be taken, it refuses — "cannot check robot batch" — and
 * never passes open, because an unknown state is not a clear one.
 */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (command: string, args: string[]) => Promise<RunResult>;

export type BatchCheckResult = { ok: true } | { ok: false; reason: string };

export const LIST_UNITS = ['systemctl', ['--user', 'list-units', '--all', '--plain', '--no-legend', 'robot-*']] as const;
export const LIST_PROCESSES = ['pgrep', ['-af', 'robot-run.mjs']] as const;

export async function checkBatch(deps: { run: Runner }): Promise<BatchCheckResult> {
  let units: RunResult;
  let processes: RunResult;
  try {
    units = await deps.run(LIST_UNITS[0], [...LIST_UNITS[1]]);
    processes = await deps.run(LIST_PROCESSES[0], [...LIST_PROCESSES[1]]);
  } catch {
    return { ok: false, reason: 'cannot check robot batch' };
  }
  // `systemctl list-units` exits 0 with an empty listing when nothing matches.
  if (units.code !== 0) return { ok: false, reason: 'cannot check robot batch' };
  // `pgrep` exits 1 when nothing matched; anything above 1 is an error.
  if (processes.code !== 0 && processes.code !== 1) return { ok: false, reason: 'cannot check robot batch' };

  const unitNames = units.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    // A failed unit is listed with a leading marker on some systemd versions.
    .map((name) => name.replace(/^[^a-zA-Z0-9]+/, ''))
    .filter((name) => name.startsWith('robot-'));
  const pids =
    processes.code === 0
      ? processes.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.includes('robot-run.mjs'))
          .map((line) => line.split(/\s+/)[0] ?? '')
          .filter((pid) => /^\d+$/.test(pid))
      : [];

  if (unitNames.length === 0 && pids.length === 0) return { ok: true };
  const parts = [
    ...unitNames.map((name) => `unit ${name} loaded`),
    ...pids.map((pid) => `robot-run.mjs PID ${pid} live`),
  ];
  return { ok: false, reason: `robot batch: ${parts.join('; ')}` };
}

/** The live runner: no shell, a short timeout, and the exit code rather than a throw. */
export const runCommand: Runner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5000 }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code !== 'number') return reject(error);
      const code = error ? Number((error as { code?: unknown }).code) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
