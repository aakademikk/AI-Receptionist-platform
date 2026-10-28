import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { type DialDeps, dial, errandServiceHealthy } from './dial.ts';
import type { Runner } from './guards/batch.ts';
import { briefHash, validateBrief } from './brief.ts';
import { normaliseUkNumber } from './guards/number.ts';
import { createQuestionInStore, sendReadback } from './readback.ts';
import { newErrand, readBrief, readEvents, readGoUsed, readOutcome, readReadback, writeBrief, writeReadback } from './store.ts';
import { bridgeAnswer, pushLogEntry, sampleBrief, tempDir } from './testing/fixtures.ts';
import type { CreateCallResult } from './twilio-call.ts';

/** 14:12 GMT, inside calling hours. */
const T0 = Date.parse('2026-10-27T14:12:00Z');
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);
const stamp = (seconds: number): string => `${at(seconds).toISOString().slice(0, 19)}Z`;

let root: string;
let cleanup: () => void;
let home: string;
let store: string;
let pushLogPath: string;

beforeEach(() => {
  ({ dir: root, cleanup } = tempDir());
  home = join(root, 'calls');
  store = join(root, 'jobs');
  pushLogPath = join(root, 'push-log.jsonl');
  mkdirSync(store);
});
afterEach(() => cleanup());

/** A fake Twilio that counts creates, a fake runner, a fake reporter, and a settable clock. */
function harness(options: { create?: () => Promise<CreateCallResult>; healthy?: boolean; units?: string } = {}) {
  const creates: Array<{ errandId: string; to: string }> = [];
  const runs: string[][] = [];
  const reported: string[] = [];
  let clock = at(120);
  const run: Runner = async (command, args) => {
    runs.push([command, ...args]);
    if (command === 'systemctl') return { code: 0, stdout: options.units ?? '', stderr: '' };
    if (command === 'pgrep') return { code: 1, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const deps: DialDeps = {
    home,
    store,
    pushLogPath,
    now: () => clock,
    health: async () => options.healthy ?? true,
    run,
    createCall: async (input) => {
      creates.push(input);
      return options.create ? options.create() : { ok: true, callSid: 'CA0123456789abcdef0123456789abcdef' };
    },
    sendOutcome: async (id) => void reported.push(id),
    watchCommand: ['/home/col/.local/bin/errand'],
  };
  return { deps, creates, runs, reported, setClock: (date: Date) => (clock = date) };
}

/** An errand with a read-back sent at T0 and the push logged; returns its ids. */
async function errandWithReadback(business = "Luigi's") {
  const { id } = newErrand(sampleBrief({ business }), at(0), home);
  const result = await sendReadback(id, {
    checkNumber: normaliseUkNumber,
    createQuestion: createQuestionInStore(store),
    notify: async () => 0,
    now: () => at(0),
    home,
  });
  assert.ok(result.ok);
  pushLogEntry(pushLogPath, result.readback.questionId, result.readback.jobId, T0 + 1000);
  const tapGo = (seconds = 60) =>
    bridgeAnswer(store, result.readback.jobId, result.readback.questionId, {
      state: 'accepted',
      result: 'Chose Go',
      answeredAt: stamp(seconds),
      answeredVia: 'tab',
    });
  return { id, tapGo };
}

describe('dial: the go guard (Done-means 2)', () => {
  it('no go: zero creates and the reason', async () => {
    const { id } = await errandWithReadback();
    const h = harness();
    assert.deepEqual(await dial(id, {}, h.deps), { code: 3, lines: ['refused: go: not answered yet'] });
    assert.equal(h.creates.length, 0);
  });

  it('a go for a brief edited after read-back: zero creates', async () => {
    const { id, tapGo } = await errandWithReadback();
    tapGo();
    writeBrief(id, { ...readBrief(id, home)!, details: { partySize: 3 } }, at(90), home);
    const h = harness();
    assert.deepEqual(await dial(id, {}, h.deps), { code: 3, lines: ['refused: go: brief edited after read-back'] });
    assert.equal(h.creates.length, 0);
  });

  it('a go moved to another number and after hours by rewriting readback.json: zero creates (Wave C R2)', async () => {
    const { id, tapGo } = await errandWithReadback();
    tapGo();
    const edited = { ...readBrief(id, home)!, number: '020 7946 0999', afterHours: true };
    writeBrief(id, edited, at(90), home);
    const checked = validateBrief(edited);
    assert.ok(checked.ok);
    const rb = readReadback(id, home)!;
    writeReadback(id, { ...rb, briefHash: briefHash(checked.brief), dialNumber: '+442079460999' }, home);
    const h = harness();
    assert.deepEqual(await dial(id, {}, h.deps), { code: 3, lines: ['refused: go: brief edited after read-back'] });
    assert.equal(h.creates.length, 0);
    assert.equal(readGoUsed(id, home), null);
  });

  it('an expired go: zero creates', async () => {
    const { id, tapGo } = await errandWithReadback();
    tapGo(60);
    const h = harness();
    h.setClock(at(60 + 30 * 60));
    assert.deepEqual(await dial(id, {}, h.deps), { code: 3, lines: ['refused: go: go expired (30 minutes)'] });
    assert.equal(h.creates.length, 0);
  });

  it('a used go: the second dial on the same errand gives zero creates (must-do 18)', async () => {
    const { id, tapGo } = await errandWithReadback();
    tapGo();
    const h = harness();
    assert.deepEqual(await dial(id, {}, h.deps), { code: 0, lines: ['placed: CA01...cdef'] });
    assert.deepEqual(await dial(id, {}, h.deps), { code: 3, lines: ['refused: go: go already used'] });
    assert.equal(h.creates.length, 1);
  });

  it('a valid go: exactly one create, to the read-back number, with the go consumed first', async () => {
    const { id, tapGo } = await errandWithReadback();
    tapGo();
    const h = harness();
    const result = await dial(id, {}, h.deps);
    assert.deepEqual(result, { code: 0, lines: ['placed: CA01...cdef'] });
    assert.deepEqual(h.creates, [{ errandId: id, to: '+442079460123' }]);
    assert.ok(readGoUsed(id, home));
    const dialled = readEvents(id, home).find((event) => event.kind === 'dialled');
    assert.equal(dialled?.callSid, 'CA01...cdef');
  });
});

describe('dial: the other guards and the create', () => {
  it('refuses "errand service down" first, before reading the go', async () => {
    const { id, tapGo } = await errandWithReadback();
    tapGo();
    const h = harness({ healthy: false });
    assert.deepEqual(await dial(id, {}, h.deps), { code: 3, lines: ['refused: health: errand service down'] });
    assert.equal(h.creates.length, 0);
    assert.equal(readGoUsed(id, home), null);
  });

  it('refuses during a robot batch, naming the unit', async () => {
    const { id, tapGo } = await errandWithReadback();
    tapGo();
    const h = harness({ units: 'robot-guardtest-1.service loaded active running sleep\n' });
    assert.deepEqual(await dial(id, {}, h.deps), { code: 3, lines: ['refused: batch: robot batch: unit robot-guardtest-1.service loaded'] });
    assert.equal(h.creates.length, 0);
  });

  it('refuses outside calling hours with a fresh go', async () => {
    const { id } = newErrand(sampleBrief(), new Date('2026-10-27T20:45:00Z'), home);
    const result = await sendReadback(id, {
      checkNumber: normaliseUkNumber,
      createQuestion: createQuestionInStore(store),
      notify: async () => 0,
      now: () => new Date('2026-10-27T20:45:00Z'),
      home,
    });
    assert.ok(result.ok);
    pushLogEntry(pushLogPath, result.readback.questionId, result.readback.jobId, Date.parse('2026-10-27T20:45:01Z'));
    bridgeAnswer(store, result.readback.jobId, result.readback.questionId, { state: 'accepted', result: 'Chose Go', answeredAt: '2026-10-27T20:59:00Z', answeredVia: 'tab' });
    const h = harness();
    h.setClock(new Date('2026-10-27T21:00:00Z'));
    assert.deepEqual(await dial(id, {}, h.deps), { code: 3, lines: ['refused: hours: outside calling hours (08:00 to 21:00 UK); it is 21:00 UK time now'] });
    assert.equal(h.creates.length, 0);
  });

  it('dials at 02:00 UK only when the brief says afterHours and Colin tapped Go on that read-back (T34)', async () => {
    const night = (iso: string) => new Date(`2026-10-28T${iso}Z`);
    const setUp = async (brief: ReturnType<typeof sampleBrief>) => {
      const { id } = newErrand(brief, night('01:50:00'), home);
      const result = await sendReadback(id, {
        checkNumber: normaliseUkNumber,
        createQuestion: createQuestionInStore(store),
        notify: async () => 0,
        now: () => night('01:50:00'),
        home,
      });
      assert.ok(result.ok);
      pushLogEntry(pushLogPath, result.readback.questionId, result.readback.jobId, Date.parse('2026-10-28T01:50:01Z'));
      bridgeAnswer(store, result.readback.jobId, result.readback.questionId, { state: 'accepted', result: 'Chose Go', answeredAt: '2026-10-28T01:55:00Z', answeredVia: 'tab' });
      return id;
    };
    const plain = await setUp(sampleBrief({ business: 'Plain' }));
    const h = harness();
    h.setClock(night('02:00:00'));
    assert.deepEqual(await dial(plain, {}, h.deps), { code: 3, lines: ['refused: hours: outside calling hours (08:00 to 21:00 UK); it is 02:00 UK time now'] });
    assert.equal(h.creates.length, 0);

    const late = await setUp({ ...sampleBrief({ business: 'Late' }), afterHours: true });
    const checked = await dial(late, { check: true }, h.deps);
    assert.ok(checked.lines.includes('hours: pass (after hours, on the brief)'));
    assert.equal((await dial(late, {}, h.deps)).code, 0);
    assert.equal(h.creates.length, 1);
    assert.ok(readEvents(late, home).some((event) => event.kind === 'after_hours' && event.ukTime === '02:00'));
  });

  it('refuses while another errand is live', async () => {
    const first = await errandWithReadback();
    first.tapGo();
    const second = await errandWithReadback('Second');
    second.tapGo();
    const h = harness();
    assert.equal((await dial(first.id, {}, h.deps)).code, 0);
    assert.deepEqual(await dial(second.id, {}, h.deps), { code: 3, lines: [`refused: live: errand ${first.id} is live`] });
    assert.equal(h.creates.length, 1);
  });

  it('schedules the watchdog as errand-watch-<id>, never robot-', async () => {
    const { id, tapGo } = await errandWithReadback();
    tapGo();
    const h = harness();
    await dial(id, {}, h.deps);
    const scheduled = h.runs.find((args) => args[0] === 'systemd-run');
    assert.deepEqual(scheduled, ['systemd-run', '--user', '--on-active=20m', `--unit=errand-watch-${id}`, '/home/col/.local/bin/errand', 'watch', id]);
  });

  it('a failed create is not retried: one create, outcome "not reached: failed to place", reported once', async () => {
    const { id, tapGo } = await errandWithReadback();
    tapGo();
    const h = harness({ create: async () => ({ ok: false, failure: 'timeout', message: 'no answer from Twilio in 15 s' }) });
    const result = await dial(id, {}, h.deps);
    assert.deepEqual(result, { code: 1, lines: ['failed: could not place the call (timeout); not retried'] });
    assert.equal(h.creates.length, 1);
    assert.deepEqual(readOutcome(id, home) && { kind: readOutcome(id, home)!.kind, reason: readOutcome(id, home)!.reason }, { kind: 'not_reached', reason: 'failed to place' });
    assert.deepEqual(h.reported, [id]);
    assert.equal(h.runs.some((args) => args[0] === 'systemd-run'), false);
    // And the Go is spent: dialling again is refused, still one create.
    assert.equal((await dial(id, {}, h.deps)).code, 3);
    assert.equal(h.creates.length, 1);
  });

  it('refuses an unknown or malformed errand', async () => {
    const h = harness();
    assert.deepEqual(await dial('2026-10-27-1412-nobody', {}, h.deps), { code: 3, lines: ['refused: no such errand'] });
    assert.equal((await dial('../x', {}, h.deps)).code, 1);
  });
});

describe('dial --check', () => {
  it('runs every guard, prints one line each, and never creates or consumes the go', async () => {
    const { id } = newErrand(sampleBrief(), at(0), home);
    const h = harness({ units: 'robot-guardtest-1.service loaded active running sleep\n' });
    const result = await dial(id, { check: true }, h.deps);
    assert.deepEqual(result, {
      code: 3,
      lines: ['health: pass', 'go: refused: no read-back', 'number: pass', 'hours: pass', 'batch: refused: robot batch: unit robot-guardtest-1.service loaded', 'live: pass'],
    });
    assert.equal(h.creates.length, 0);
  });

  it('passes every line with a valid go and still creates nothing', async () => {
    const { id, tapGo } = await errandWithReadback();
    tapGo();
    const h = harness();
    const result = await dial(id, { check: true }, h.deps);
    assert.deepEqual(result, { code: 0, lines: ['health: pass', 'go: pass', 'number: pass', 'hours: pass', 'batch: pass', 'live: pass'] });
    assert.equal(h.creates.length, 0);
    assert.equal(readGoUsed(id, home), null);
  });
});

describe('errandServiceHealthy', () => {
  it('is true on a 200 and false on anything else or no answer', async () => {
    assert.equal(await errandServiceHealthy((async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch), true);
    assert.equal(await errandServiceHealthy((async () => new Response('', { status: 404 })) as typeof fetch), false);
    assert.equal(await errandServiceHealthy((async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch), false);
  });
});
