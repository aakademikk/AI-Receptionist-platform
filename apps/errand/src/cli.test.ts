import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { type CliDeps, USAGE, runCli } from './cli.ts';
import { normaliseUkNumber } from './guards/number.ts';
import { createQuestionInStore } from './readback.ts';
import { sampleBrief, tempDir } from './testing/fixtures.ts';

const NOW = new Date('2026-10-27T14:12:00Z');

let root: string;
let cleanup: () => void;
let deps: CliDeps;
let creates: number;
let sent: string[][];

beforeEach(() => {
  ({ dir: root, cleanup } = tempDir());
  mkdirSync(join(root, 'jobs'));
  creates = 0;
  sent = [];
  deps = {
    home: join(root, 'calls'),
    now: () => NOW,
    notify: async (args) => (sent.push(args), 0),
    readback: { checkNumber: normaliseUkNumber, createQuestion: createQuestionInStore(join(root, 'jobs')) },
    dial: {
      store: join(root, 'jobs'),
      pushLogPath: join(root, 'push-log.jsonl'),
      health: async () => true,
      run: async (command) => ({ code: command === 'pgrep' ? 1 : 0, stdout: '', stderr: '' }),
      createCall: async () => {
        creates += 1;
        return { ok: true, callSid: 'CA0123456789abcdef0123456789abcdef' };
      },
      watchCommand: ['errand'],
    },
  };
});
afterEach(() => cleanup());

function briefFile(brief: unknown = sampleBrief()): string {
  const path = join(root, 'brief.json');
  writeFileSync(path, JSON.stringify(brief));
  return path;
}

describe('errand CLI: usage errors exit 2', () => {
  const ID = '2026-10-27-1412-luigi-s-table';
  const cases: string[][] = [
    [],
    ['frobnicate'],
    ['new'],
    ['new', 'a.json', 'b.json'],
    ['readback'],
    ['readback', '../x'],
    ['readback', ID, 'extra'],
    ['dial'],
    ['dial', 'not-an-id'],
    ['dial', ID, '--force'],
    ['dial', ID, '--check', '--check'],
    ['status'],
    ['status', ID, 'extra'],
    ['watch'],
    ['watch', 'x/../y'],
    ['prune', '--now'],
    ['prune', '--dry-run', 'extra'],
    ['list', 'extra'],
  ];
  for (const argv of cases) {
    it(`errand ${argv.join(' ') || '(nothing)'}`, async () => {
      assert.deepEqual(await runCli(argv, deps), { code: 2, out: [USAGE] });
    });
  }
});

describe('errand CLI: new, status, list', () => {
  it('new prints the id; status shows the brief, events, transcript and outcome', async () => {
    const created = await runCli(['new', briefFile()], deps);
    assert.deepEqual(created, { code: 0, out: ['2026-10-27-1412-luigi-s-table'] });
    const status = await runCli(['status', '2026-10-27-1412-luigi-s-table'], deps);
    assert.equal(status.code, 0);
    const text = status.out.join('\n');
    for (const part of ["Errand 2026-10-27-1412-luigi-s-table: new", "Business: Luigi's", 'Number: 020 7946 0123', 'Goal: book a table for two', 'Window: Wed 28 Oct, between 19:00 and 20:30', 'Detail partySize: 2', 'Contact: Colin Wood, +447700900123', 'Events:', 'created', 'Transcript:', '(none)', 'Outcome: (none yet)']) {
      assert.ok(text.includes(part), part);
    }
    assert.deepEqual(await runCli(['list'], deps), { code: 0, out: ['2026-10-27-1412-luigi-s-table  new'] });
  });

  it('new refuses an invalid brief naming the field (exit 3), and an unreadable file (exit 1)', async () => {
    assert.deepEqual(await runCli(['new', briefFile(sampleBrief({ details: {} }))], deps), {
      code: 3,
      out: ['refused: brief details.partySize: a table booking needs the party size, a whole number of at least 1'],
    });
    assert.equal((await runCli(['new', join(root, 'missing.json')], deps)).code, 1);
  });

  it('status for an unknown errand exits 1', async () => {
    assert.equal((await runCli(['status', '2026-10-27-1412-nobody'], deps)).code, 1);
  });

  it('list with no errands', async () => {
    assert.deepEqual(await runCli(['list'], deps), { code: 0, out: ['(no errands)'] });
  });
});

describe('errand CLI: readback and dial', () => {
  it('readback sends the read-back once and prints it', async () => {
    const id = (await runCli(['new', briefFile()], deps)).out[0]!;
    const result = await runCli(['readback', id], deps);
    assert.equal(result.code, 0);
    assert.ok(result.out[0]!.includes('Number as dialled: +442079460123'));
    assert.equal(sent.length, 1);
    assert.equal((await runCli(['list'], deps)).out[0], `${id}  read back, waiting for Go`);
  });

  it('dial without a go prints the refusal and exits 3, with no call created', async () => {
    const id = (await runCli(['new', briefFile()], deps)).out[0]!;
    await runCli(['readback', id], deps);
    assert.deepEqual(await runCli(['dial', id], deps), { code: 3, out: ['refused: go: not answered yet'] });
    assert.equal(creates, 0);
  });

  it('dial --check prints one line per guard and creates nothing', async () => {
    const id = (await runCli(['new', briefFile()], deps)).out[0]!;
    const result = await runCli(['dial', id, '--check'], deps);
    assert.equal(result.code, 3);
    assert.equal(result.out.length, 6);
    assert.equal(result.out[1], 'go: refused: no read-back');
    assert.equal(creates, 0);
  });

  it('watch and prune run against the temp store', async () => {
    const id = (await runCli(['new', briefFile()], deps)).out[0]!;
    assert.deepEqual(await runCli(['watch', id], deps), { code: 0, out: ['not dialled'] });
    assert.deepEqual(await runCli(['prune', '--dry-run'], deps), { code: 0, out: ['would remove 0 errand folder(s)'] });
  });
});
