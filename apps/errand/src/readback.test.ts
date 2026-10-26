import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { briefHash } from './brief.ts';
import {
  type GoQuestion,
  type NumberCheck,
  READBACK_CLOSING,
  createQuestionInStore,
  renderReadback,
  renderWindow,
  sendReadback,
  spacedUkNumber,
} from './readback.ts';
import { newErrand, readEvents, readReadback } from './store.ts';
import { sampleBrief, tempDir } from './testing/fixtures.ts';

const NOW = new Date('2026-10-27T14:12:05.250Z');

/** A stand-in for T8's normaliser: accepts the drama-range London number, refuses a premium one. */
const fakeCheck: NumberCheck = (input) => {
  const digits = input.replace(/\D/g, '');
  if (digits.startsWith('09')) return { ok: false, reason: 'premium or chargeable' };
  return { ok: true, e164: `+44${digits.slice(1)}` };
};

let home: string;
let cleanHome: () => void;

beforeEach(() => {
  ({ dir: home, cleanup: cleanHome } = tempDir());
});
afterEach(() => cleanHome());

function harness() {
  const questions: Array<{ jobId: string; question: GoQuestion }> = [];
  const notified: string[][] = [];
  return {
    questions,
    notified,
    deps: {
      checkNumber: fakeCheck,
      createQuestion: (jobId: string, question: GoQuestion) => void questions.push({ jobId, question }),
      notify: async (args: string[]) => {
        notified.push(args);
        return 0;
      },
      now: () => NOW,
      home,
    },
  };
}

describe('renderReadback', () => {
  it('has a line for every brief field, the number as dialled, the hash tag and the closing line', () => {
    const brief = sampleBrief({ details: { partySize: 2, seating: 'window' }, limits: { fixed: sampleBrief().limits.fixed, added: ['no outdoor tables'] } });
    const text = renderReadback(brief, '+442079460123');
    const lines = text.split('\n');
    assert.ok(lines.includes("Business: Luigi's"));
    assert.ok(lines.includes('Number as dialled: +442079460123 (+44 20 7946 0123)'));
    assert.ok(lines.includes('Goal: book a table for two'));
    assert.ok(lines.includes('Kind: table'));
    assert.ok(lines.includes('Window: Wed 28 Oct, between 19:00 and 20:30'));
    assert.ok(lines.includes('Party size: 2'));
    assert.ok(lines.includes('Seating: window'));
    assert.ok(lines.includes('Name Amy may give: Colin Wood'));
    assert.ok(lines.includes('Mobile Amy may give: +447700900123'));
    const limits = lines.find((line) => line.startsWith('Limits: '))!;
    for (const limit of [...brief.limits.fixed, 'no outdoor tables']) assert.ok(limit && limits.includes(limit), limit);
    assert.ok(lines.includes(`Brief #${briefHash(brief).slice(0, 8)}`));
    assert.equal(lines.at(-1), READBACK_CLOSING);
  });

  it('spaces UK numbers the way they are said', () => {
    assert.equal(spacedUkNumber('+447700900123'), '+44 7700 900123');
    assert.equal(spacedUkNumber('+442079460123'), '+44 20 7946 0123');
    assert.equal(spacedUkNumber('+441632960123'), '+44 1632 960123');
    assert.equal(spacedUkNumber('+443069990123'), '+44 306 999 0123');
    assert.equal(spacedUkNumber('+448081570123'), '+44 808 157 0123');
  });

  it('renders the window as weekday, day, month and the two times', () => {
    assert.equal(renderWindow({ date: '2026-10-27', earliest: '19:00', latest: '20:30' }), 'Tue 27 Oct, between 19:00 and 20:30');
  });
});

describe('sendReadback', () => {
  it('creates one gated Go question, records the hash and notifies once with the question id', async () => {
    const { id, brief } = newErrand(sampleBrief(), NOW, home);
    const h = harness();
    const result = await sendReadback(id, h.deps);
    assert.ok(result.ok);

    assert.equal(h.questions.length, 1);
    const { jobId, question } = h.questions[0]!;
    assert.match(question.id, /^q_[0-9a-f]{8}$/);
    assert.match(jobId, /^job_errand-2026-10-27-1412-luigi-s-table_20261027-141205$/);
    assert.deepEqual(question.options, ['Go', 'Cancel']);
    assert.equal(question.kind, 'choice2');
    assert.equal(question.gated, true);
    assert.equal(question.acceptAction, 'none');
    assert.equal(question.state, 'open');
    assert.equal(question.createdAt, '2026-10-27T14:12:05Z');
    assert.ok(!question.text.includes('\n'));
    assert.ok(question.text.includes('Number as dialled: +442079460123'));

    const saved = readReadback(id, home)!;
    assert.equal(saved.briefHash, briefHash(brief));
    assert.equal(saved.dialNumber, '+442079460123');
    assert.equal(saved.questionId, question.id);
    assert.equal(saved.jobId, jobId);
    assert.equal(saved.questionText, question.text);
    assert.deepEqual(saved.questionOptions, ['Go', 'Cancel']);
    assert.equal(saved.sentAt, '2026-10-27T14:12:05Z');
    assert.ok(saved.text.split('\n').includes('Number as dialled: +442079460123 (+44 20 7946 0123)'));

    assert.equal(h.notified.length, 1);
    const args = h.notified[0]!;
    assert.equal(args[args.indexOf('--question') + 1], question.id);
    assert.equal(args[args.indexOf('--options') + 1], 'Go|Cancel');
    assert.equal(args[args.indexOf('--job') + 1], jobId);
    assert.equal(args[args.indexOf('--full') + 1], saved.text);
    assert.equal(readEvents(id, home).at(-1)?.kind, 'readback_sent');
  });

  it('sends nothing and writes no read-back for a refused number', async () => {
    const { id } = newErrand(sampleBrief({ number: '0909 879 0000' }), NOW, home);
    const h = harness();
    const result = await sendReadback(id, h.deps);
    assert.deepEqual(result, { ok: false, reason: 'number refused: premium or chargeable' });
    assert.equal(h.questions.length, 0);
    assert.equal(h.notified.length, 0);
    assert.equal(readReadback(id, home), null);
  });

  it('records a notifier failure and keeps the read-back', async () => {
    const { id } = newErrand(sampleBrief(), NOW, home);
    const h = harness();
    const result = await sendReadback(id, { ...h.deps, notify: async () => 7 });
    assert.ok(result.ok);
    assert.ok(readReadback(id, home));
    assert.equal(readEvents(id, home).at(-1)?.notifyExit, 7);
  });
});

describe('createQuestionInStore', () => {
  it('writes a closer.json with the one question in its own job dir', () => {
    const { dir: store, cleanup } = tempDir('errand-store-');
    try {
      const question = { id: 'q_0123abcd' } as GoQuestion;
      createQuestionInStore(store)('job_errand-x_20261027-141205', question);
      const path = join(store, 'job_errand-x_20261027-141205', 'closer.json');
      assert.ok(existsSync(path));
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { jobId: 'job_errand-x_20261027-141205', source: 'errand', questions: [question] });
      assert.deepEqual(readdirSync(join(store, 'job_errand-x_20261027-141205')), ['closer.json']);
      assert.throws(() => createQuestionInStore(store)('../x', question), /bad job id/);
    } finally {
      cleanup();
    }
  });
});
