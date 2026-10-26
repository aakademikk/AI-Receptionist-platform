import assert from 'node:assert/strict';
import { mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { checkGo, markGoUsed } from './go.ts';
import { createQuestionInStore, sendReadback } from './readback.ts';
import { newErrand, readBrief, readReadback, writeBrief } from './store.ts';
import { bridgeAnswer, pushLogEntry, sampleBrief, tempDir } from './testing/fixtures.ts';

const T0 = Date.parse('2026-10-27T14:12:00Z');
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);
const stamp = (seconds: number): string => `${at(seconds).toISOString().slice(0, 19)}Z`;

let root: string;
let cleanup: () => void;
let home: string;
let store: string;
let pushLogPath: string;
let id: string;
let jobId: string;
let questionId: string;

const deps = () => ({ home, store, pushLogPath });

beforeEach(async () => {
  ({ dir: root, cleanup } = tempDir());
  home = join(root, 'calls');
  store = join(root, 'jobs');
  pushLogPath = join(root, 'push-log.jsonl');
  mkdirSync(store);
  id = newErrand(sampleBrief(), at(0), home).id;
  const result = await sendReadback(id, {
    checkNumber: (input) => ({ ok: true, e164: `+44${input.replace(/\D/g, '').slice(1)}` }),
    createQuestion: createQuestionInStore(store),
    notify: async () => 0,
    now: () => at(0),
    home,
  });
  assert.ok(result.ok);
  ({ jobId, questionId } = result.readback);
  pushLogEntry(pushLogPath, questionId, jobId, T0 + 1000);
});
afterEach(() => cleanup());

function tapGo(seconds = 60, via: string | null = 'tab'): void {
  bridgeAnswer(store, jobId, questionId, { state: 'accepted', result: 'Chose Go', answeredAt: stamp(seconds), answeredVia: via });
}

describe('checkGo', () => {
  it('passes a valid Go and returns what it consumed', () => {
    tapGo();
    const result = checkGo(id, at(120), deps());
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.go, { questionId, jobId, answeredAt: stamp(60), answeredVia: 'tab', briefHash: readReadback(id, home)!.briefHash });
  });

  it('accepts a Go answered by push as well as tab', () => {
    tapGo(60, 'push');
    assert.equal(checkGo(id, at(120), deps()).ok, true);
  });

  it('refuses with no read-back', () => {
    const other = newErrand(sampleBrief({ business: 'Other' }), at(0), home).id;
    assert.deepEqual(checkGo(other, at(120), deps()), { ok: false, reason: 'no read-back' });
  });

  it('refuses with no bridge record for the question', () => {
    rmSync(join(store, jobId, 'closer.json'));
    assert.deepEqual(checkGo(id, at(120), deps()), { ok: false, reason: "no bridge record for the read-back's question" });
  });

  it('refuses a bridge record that is a symlink', () => {
    tapGo();
    const real = join(root, 'elsewhere.json');
    renameSync(join(store, jobId, 'closer.json'), real);
    symlinkSync(real, join(store, jobId, 'closer.json'));
    assert.deepEqual(checkGo(id, at(120), deps()), { ok: false, reason: 'bridge record is not a regular file' });
  });

  it('refuses a bridge record owned by someone else', () => {
    tapGo();
    assert.deepEqual(checkGo(id, at(120), { ...deps(), uid: 999_999 }), { ok: false, reason: 'bridge record is not owned by this user' });
  });

  it('refuses an unanswered question', () => {
    assert.deepEqual(checkGo(id, at(120), deps()), { ok: false, reason: 'not answered yet' });
  });

  it('refuses Cancel, which the closer also marks accepted', () => {
    bridgeAnswer(store, jobId, questionId, { state: 'accepted', result: 'Chose Cancel', answeredAt: stamp(60), answeredVia: 'tab' });
    assert.deepEqual(checkGo(id, at(120), deps()), { ok: false, reason: 'Colin chose Cancel' });
  });

  it('refuses declined and failed states', () => {
    for (const state of ['declined', 'failed']) {
      bridgeAnswer(store, jobId, questionId, { state, result: 'Chose Go', answeredAt: stamp(60), answeredVia: 'tab' });
      assert.deepEqual(checkGo(id, at(120), deps()), { ok: false, reason: 'answer is not Go' }, state);
    }
  });

  it('refuses an answer the bridge did not write', () => {
    for (const via of [null, 'sam', 'cli']) {
      tapGo(60, via);
      assert.deepEqual(checkGo(id, at(120), deps()), { ok: false, reason: 'answer was not written by the bridge' }, String(via));
    }
  });

  it('refuses when the question text or options changed', () => {
    tapGo();
    bridgeAnswer(store, jobId, questionId, { text: 'something else' });
    assert.deepEqual(checkGo(id, at(120), deps()), { ok: false, reason: 'bridge question does not match the read-back' });
    bridgeAnswer(store, jobId, questionId, { text: readReadback(id, home)!.questionText, options: ['Go', 'No'] });
    assert.deepEqual(checkGo(id, at(120), deps()), { ok: false, reason: 'bridge question does not match the read-back' });
  });

  it('refuses when the push-log has no entry for the question, or only one after the answer', () => {
    tapGo();
    rmSync(pushLogPath);
    assert.deepEqual(checkGo(id, at(120), deps()), { ok: false, reason: 'no push-log entry for the Go question before the answer' });
    pushLogEntry(pushLogPath, questionId, jobId, T0 + 90_000);
    assert.deepEqual(checkGo(id, at(120), deps()), { ok: false, reason: 'no push-log entry for the Go question before the answer' });
  });

  it('refuses an answer timed before the read-back was sent', () => {
    pushLogEntry(pushLogPath, questionId, jobId, T0 - 10_000);
    tapGo(-5);
    assert.deepEqual(checkGo(id, at(120), deps()), { ok: false, reason: 'answered before the read-back was sent' });
  });

  it('passes a Go 29 minutes 59 seconds old and refuses one 30 minutes old', () => {
    tapGo(60);
    assert.equal(checkGo(id, at(60 + 29 * 60 + 59), deps()).ok, true);
    assert.deepEqual(checkGo(id, at(60 + 30 * 60), deps()), { ok: false, reason: 'go expired (30 minutes)' });
  });

  it('refuses a Go tapped more than 30 minutes after the read-back', () => {
    tapGo(30 * 60 + 1);
    assert.deepEqual(checkGo(id, at(30 * 60 + 5), deps()), {
      ok: false,
      reason: 'go expired (answered more than 30 minutes after the read-back)',
    });
  });

  it('refuses a Go for a brief edited after read-back', () => {
    tapGo();
    writeBrief(id, { ...readBrief(id, home)!, window: { date: '2026-10-28', earliest: '19:00', latest: '21:00' } }, at(90), home);
    assert.deepEqual(checkGo(id, at(120), deps()), { ok: false, reason: 'brief edited after read-back' });
  });

  it('refuses a used Go', () => {
    tapGo();
    const first = checkGo(id, at(120), deps());
    assert.ok(first.ok);
    assert.deepEqual(markGoUsed(id, first.go, at(121), home), { ok: true });
    assert.deepEqual(checkGo(id, at(122), deps()), { ok: false, reason: 'go already used' });
  });
});

describe('markGoUsed', () => {
  it('lets exactly one of two racing dials consume the Go', () => {
    tapGo();
    const result = checkGo(id, at(120), deps());
    assert.ok(result.ok);
    assert.deepEqual(markGoUsed(id, result.go, at(121), home), { ok: true });
    assert.deepEqual(markGoUsed(id, result.go, at(121), home), { ok: false, reason: 'go already used' });
  });
});
