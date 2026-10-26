import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createErrandServer } from './server.ts';
import { handleStatus, outcomeFromStatus } from './status.ts';
import { newErrand, readEvents, readOutcome, writeOutcome } from './store.ts';
import { TEST_TOKEN, listen, postForm, sampleBrief, tempDir } from './testing/fixtures.ts';

const T = new Date('2026-10-27T14:20:00Z');
let home: string;
let cleanup: () => void;
let id: string;
let sent: string[][];
const notify = async (args: string[]) => (sent.push(args), 0);

beforeEach(() => {
  ({ dir: home, cleanup } = tempDir());
  id = newErrand(sampleBrief(), new Date('2026-10-27T14:12:00Z'), home).id;
  sent = [];
});
afterEach(() => cleanup());

const post = (params: Record<string, string>) => handleStatus(id, { CallSid: 'CA0123456789abcdef0123456789abcdef', ...params }, { home, notify, now: () => T });

describe('handleStatus', () => {
  it('logs every status post with status, AnsweredBy, duration and the masked CallSid', async () => {
    for (const status of ['initiated', 'ringing', 'in-progress']) assert.equal(post({ CallStatus: status }).reported, null);
    await post({ CallStatus: 'completed', CallDuration: '95', AnsweredBy: 'human' }).reported;
    const statuses = readEvents(id, home).filter((event) => event.kind === 'status');
    assert.deepEqual(statuses.map((event) => event.status), ['initiated', 'ringing', 'in-progress', 'completed']);
    assert.equal(statuses.at(-1)?.answeredBy, 'human');
    assert.equal(statuses.at(-1)?.duration, 95);
    assert.equal(statuses.at(-1)?.callSid, 'CA01...cdef');
  });

  it('no-answer writes "not reached" and reports once (Done-means 14)', async () => {
    assert.equal(await post({ CallStatus: 'no-answer' }).reported, true);
    assert.deepEqual([readOutcome(id, home)?.kind, readOutcome(id, home)?.reason], ['not_reached', 'no answer']);
    assert.equal(sent.length, 1);
  });

  it('busy and failed are "not reached" with their reason', () => {
    assert.equal(outcomeFromStatus('busy', null, 'x').reason, 'busy');
    assert.equal(outcomeFromStatus('failed', null, 'x').reason, 'call failed');
  });

  it('completed with a duration of 480 gives "maximum length"; shorter with no outcome gives "failed"', () => {
    assert.deepEqual(outcomeFromStatus('completed', 480, 'x'), { kind: 'ended_early', limit: 'maximum length', source: 'status', at: 'x' });
    assert.deepEqual(outcomeFromStatus('completed', 479, 'x'), { kind: 'failed', reason: 'call ended with no outcome', source: 'status', at: 'x' });
  });

  it('keeps an outcome the session already settled', async () => {
    writeOutcome(id, { kind: 'booked', agreedTime: '19:30', source: 'session', at: T.toISOString() }, home);
    await post({ CallStatus: 'completed', CallDuration: '120' }).reported;
    assert.equal(readOutcome(id, home)?.kind, 'booked');
    assert.equal(sent[0]![0], "Errand: Luigi's: booked");
  });

  it('two completed posts send one message', async () => {
    await post({ CallStatus: 'completed', CallDuration: '60' }).reported;
    await post({ CallStatus: 'completed', CallDuration: '60' }).reported;
    assert.equal(sent.length, 1);
  });

  it('a notifier failure is recorded and the outcome file stays', async () => {
    await handleStatus(id, { CallStatus: 'busy' }, { home, notify: async () => 1, now: () => T }).reported;
    assert.equal(readEvents(id, home).find((event) => event.kind === 'reported')?.notifyExit, 1);
    assert.equal(readOutcome(id, home)?.kind, 'not_reached');
  });
});

describe('no redial (must-do 18)', () => {
  it('the status and report modules never import the call create or the dial step', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ['status.ts', 'report.ts']) {
      const source = readFileSync(join(here, file), 'utf8');
      assert.equal(/from '\.\/(twilio-call|dial)\.ts'/.test(source), false, file);
      assert.equal(source.includes('createErrandCall'), false, file);
    }
  });
});

describe('the status endpoint through the server', () => {
  let server: Server;
  let port: number;
  beforeEach(async () => {
    ({ server } = createErrandServer({ tokens: () => [TEST_TOKEN], home, log: () => undefined, notify }));
    port = await listen(server);
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('a signed no-answer post settles the outcome and reports once; an unsigned one changes nothing', async () => {
    const unsigned = await postForm(port, `/errand/status?errand=${id}`, { CallStatus: 'no-answer' }, { signature: null });
    assert.equal(unsigned.status, 403);
    assert.equal(readOutcome(id, home), null);
    const signed = await postForm(port, `/errand/status?errand=${id}`, { CallSid: 'CA1', CallStatus: 'no-answer' });
    assert.equal(signed.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(readOutcome(id, home)?.kind, 'not_reached');
    assert.equal(sent.length, 1);
  });
});
