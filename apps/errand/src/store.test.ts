import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { briefHash } from './brief.ts';
import {
  appendEvent,
  appendTranscript,
  assertErrandId,
  errandDir,
  isErrandId,
  listErrands,
  newErrand,
  readAlert,
  readBrief,
  readEvents,
  readGoUsed,
  readOutcome,
  readReadback,
  readTranscript,
  writeAlert,
  writeGoUsed,
  writeOutcome,
  writeReadback,
} from './store.ts';
import { sampleBrief, tempDir } from './testing/fixtures.ts';

const NOW = new Date('2026-10-27T14:12:00Z'); // 14:12 GMT, the clocks went back on the 25th

let home: string;
let cleanup: () => void;

beforeEach(() => {
  ({ dir: home, cleanup } = tempDir());
});
afterEach(() => cleanup());

describe('errand ids', () => {
  it('accepts the date, time and slug shape', () => {
    assert.equal(isErrandId('2026-10-27-1412-luigis-table'), true);
  });

  it('refuses a bad id before any path is built', () => {
    for (const bad of ['../../jobs/x', '2026-10-27-1412-Luigis', '2026-10-27-1412-', '2026-10-27-1412-a/b', '', '2026-10-27-1412-' + 'a'.repeat(41)]) {
      assert.equal(isErrandId(bad), false, bad);
      assert.throws(() => errandDir(bad, home), /not a valid errand id/);
    }
    assert.throws(() => assertErrandId(undefined), /not a valid errand id/);
    assert.deepEqual(readdirSync(home), []);
  });
});

describe('newErrand', () => {
  it('creates a mode 700 folder named by UK date, time and slug, with the brief', () => {
    const { id } = newErrand(sampleBrief(), NOW, home);
    assert.equal(id, '2026-10-27-1412-luigi-s-table');
    const dir = join(home, id);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'brief.json')).mode & 0o777, 0o600);
    assert.deepEqual(readBrief(id, home), sampleBrief());
  });

  it('uses BST in summer', () => {
    const { id } = newErrand(sampleBrief(), new Date('2026-07-01T11:05:00Z'), home);
    assert.ok(id.startsWith('2026-07-01-1205-'), id);
  });

  it('gives a second errand in the same minute its own folder', () => {
    const first = newErrand(sampleBrief(), NOW, home).id;
    const second = newErrand(sampleBrief(), NOW, home).id;
    assert.notEqual(first, second);
    assert.equal(second, `${first}-2`);
  });

  it('creates nothing for an invalid brief and names the field', () => {
    assert.throws(() => newErrand(sampleBrief({ details: {} }), NOW, home), /details\.partySize/);
    assert.deepEqual(listErrands(home), []);
  });
});

describe('write-once files', () => {
  it('go-used.json cannot be written twice', () => {
    const { id } = newErrand(sampleBrief(), NOW, home);
    const go = { questionId: 'q_0123abcd', jobId: 'job_errand-x', answeredAt: NOW.toISOString(), answeredVia: 'tab', briefHash: 'h', usedAt: NOW.toISOString() };
    writeGoUsed(id, go, home);
    assert.throws(() => writeGoUsed(id, go, home), /EEXIST/);
    assert.deepEqual(readGoUsed(id, home), go);
  });

  it('outcome.json and alert.json are written once', () => {
    const { id } = newErrand(sampleBrief(), NOW, home);
    assert.equal(writeOutcome(id, { kind: 'voicemail_left', source: 'session', at: NOW.toISOString() }, home), true);
    assert.equal(writeOutcome(id, { kind: 'booked', source: 'session', at: NOW.toISOString() }, home), false);
    assert.equal(readOutcome(id, home)?.kind, 'voicemail_left');
    assert.equal(writeAlert(id, { text: 'one', at: NOW.toISOString() }, home), true);
    assert.equal(writeAlert(id, { text: 'two', at: NOW.toISOString() }, home), false);
    assert.equal(readAlert(id, home)?.text, 'one');
  });
});

describe('a scripted errand', () => {
  it('leaves every must-do 17 part in the folder', () => {
    const { id, brief } = newErrand(sampleBrief(), NOW, home);
    const at = (s: number): Date => new Date(NOW.getTime() + s * 1000);
    writeReadback(id, {
      text: 'read-back text',
      briefHash: briefHash(brief),
      dialNumber: '+442079460123',
      questionId: 'q_0123abcd',
      jobId: 'job_errand-x',
      questionText: 'read-back text',
      questionOptions: ['Go', 'Cancel'],
      sentAt: at(1).toISOString(),
    }, home);
    writeGoUsed(id, { questionId: 'q_0123abcd', jobId: 'job_errand-x', answeredAt: at(60).toISOString(), answeredVia: 'tab', briefHash: briefHash(brief), usedAt: at(61).toISOString() }, home);
    appendEvent(id, { kind: 'dialled', callSid: 'CA12...cdef' }, at(62), home);
    for (const status of ['initiated', 'ringing', 'answered']) appendEvent(id, { kind: 'status', status }, at(63), home);
    appendEvent(id, { kind: 'answered', answeredBy: 'human' }, at(70), home);
    appendTranscript(id, 'them', "Hello, Luigi's.", at(71), home);
    appendTranscript(id, 'amy', 'Hi, this is Amy...', at(72), home);
    appendEvent(id, { kind: 'digits', digits: '1' }, at(73), home);
    appendEvent(id, { kind: 'status', status: 'completed' }, at(120), home);
    writeOutcome(id, { kind: 'booked', agreedTime: '19:30', date: '2026-10-28', nameBookedUnder: 'Colin Wood', source: 'session', at: at(119).toISOString() }, home);

    const dir = join(home, id);
    for (const name of ['brief.json', 'readback.json', 'go-used.json', 'events.jsonl', 'transcript.jsonl', 'outcome.json']) {
      assert.ok(existsSync(join(dir, name)), name);
      assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, name);
    }
    assert.ok(readReadback(id, home));
    const kinds = readEvents(id, home).map((event) => event.kind);
    assert.deepEqual(kinds, ['created', 'dialled', 'status', 'status', 'status', 'answered', 'digits', 'status']);
    assert.equal(readEvents(id, home).find((event) => event.kind === 'answered')?.answeredBy, 'human');
    const transcript = readTranscript(id, home);
    assert.deepEqual(transcript.map((line) => line.speaker), ['them', 'amy']);
    assert.ok(transcript.every((line) => line.time && line.words));
    assert.equal(readOutcome(id, home)?.kind, 'booked');
  });
});
