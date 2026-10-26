import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type RunResult, type Runner, checkBatch, runCommand } from './batch.ts';

/** A fake runner: canned output per command, and a record of what was asked. */
function fakeRunner(units: Partial<RunResult> | Error, processes: Partial<RunResult> | Error = { code: 1 }): Runner & { calls: string[] } {
  const calls: string[] = [];
  const run = (async (command: string, args: string[]) => {
    calls.push([command, ...args].join(' '));
    const canned = command === 'systemctl' ? units : processes;
    if (canned instanceof Error) throw canned;
    return { code: 0, stdout: '', stderr: '', ...canned };
  }) as Runner & { calls: string[] };
  run.calls = calls;
  return run;
}

describe('checkBatch', () => {
  it('passes on an empty listing and no robot-run.mjs process, asking exactly the two listings', async () => {
    const run = fakeRunner({ stdout: '' });
    assert.deepEqual(await checkBatch({ run }), { ok: true });
    assert.deepEqual(run.calls, ["systemctl --user list-units --all --plain --no-legend robot-*", 'pgrep -af robot-run.mjs']);
  });

  it('refuses while robot-guardtest-1.service is loaded and names it', async () => {
    const run = fakeRunner({ stdout: 'robot-guardtest-1.service loaded active running /usr/bin/sleep 600\n' });
    assert.deepEqual(await checkBatch({ run }), { ok: false, reason: 'robot batch: unit robot-guardtest-1.service loaded' });
  });

  it('refuses on a pending robot-today-3.timer', async () => {
    const run = fakeRunner({ stdout: 'robot-today-3.timer loaded active waiting /usr/bin/node robot-run.mjs\n' });
    assert.deepEqual(await checkBatch({ run }), { ok: false, reason: 'robot batch: unit robot-today-3.timer loaded' });
  });

  it('refuses with the PID of a live robot-run.mjs', async () => {
    const run = fakeRunner({ stdout: '' }, { code: 0, stdout: '48211 /home/col/.local/node/bin/node robot-run.mjs --variant today\n' });
    assert.deepEqual(await checkBatch({ run }), { ok: false, reason: 'robot batch: robot-run.mjs PID 48211 live' });
  });

  it('names every blocker at once', async () => {
    const run = fakeRunner(
      { stdout: 'robot-today-1.service loaded active running x\nrobot-today-2.timer loaded active waiting x\n' },
      { code: 0, stdout: '101 node robot-run.mjs\n' },
    );
    assert.deepEqual(await checkBatch({ run }), {
      ok: false,
      reason: 'robot batch: unit robot-today-1.service loaded; unit robot-today-2.timer loaded; robot-run.mjs PID 101 live',
    });
  });

  it('refuses when either listing fails, never passing open', async () => {
    for (const run of [
      fakeRunner(new Error('spawn systemctl ENOENT')),
      fakeRunner({ code: 1, stderr: 'Failed to connect to bus' }),
      fakeRunner({ stdout: '' }, new Error('spawn pgrep ENOENT')),
      fakeRunner({ stdout: '' }, { code: 3 }),
    ]) {
      assert.deepEqual(await checkBatch({ run }), { ok: false, reason: 'cannot check robot batch' });
    }
  });
});

describe('runCommand', () => {
  it('resolves an exit code rather than throwing, and rejects a missing program', async () => {
    assert.equal((await runCommand(process.execPath, ['-e', 'process.exit(1)'])).code, 1);
    assert.equal((await runCommand(process.execPath, ['-e', 'process.stdout.write("x")'])).stdout, 'x');
    await assert.rejects(runCommand('/nonexistent/errand-test-program', []));
  });
});
