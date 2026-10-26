import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { VOICE_ID } from './config.ts';
import { createErrandServer } from './server.ts';
import { newErrand, readEvents, readOutcome } from './store.ts';
import { TEST_TOKEN, listen, postForm, sampleBrief, tempDir } from './testing/fixtures.ts';
import { errandTwiml, modeFor } from './twiml.ts';

const NOW = new Date('2026-10-27T14:13:00Z');

let home: string;
let cleanup: () => void;
let id: string;

beforeEach(() => {
  ({ dir: home, cleanup } = tempDir());
  id = newErrand(sampleBrief(), new Date('2026-10-27T14:12:00Z'), home).id;
});
afterEach(() => cleanup());

const twimlFor = (answeredBy?: string) =>
  errandTwiml(id, { CallSid: 'CA0123456789abcdef0123456789abcdef', ...(answeredBy === undefined ? {} : { AnsweredBy: answeredBy }) }, { home, now: () => NOW });

describe('modeFor', () => {
  it('maps every AnsweredBy value to its mode', () => {
    const table: Array<[string | undefined, string]> = [
      ['human', 'person'],
      ['unknown', 'person'],
      [undefined, 'person'],
      ['machine_end_beep', 'voicemail'],
      ['machine_end_silence', 'voicemail'],
      ['machine_end_other', 'voicemail'],
      ['fax', 'hangup'],
      ['machine_start', 'hangup'],
    ];
    for (const [value, mode] of table) assert.equal(modeFor(value), mode, String(value));
  });
});

describe('errandTwiml', () => {
  it('person: a ConversationRelay with no welcomeGreeting, Amy\'s voice, DTMF on, the parameters, and a closing Hangup', () => {
    const xml = twimlFor('human');
    assert.ok(xml.includes('url="wss://receptionist.atwoodsystems.co.uk/errand/ws"'));
    assert.equal(xml.includes('welcomeGreeting'), false);
    assert.ok(xml.includes(`voice="${VOICE_ID}"`));
    assert.ok(xml.includes('ttsProvider="ElevenLabs"'));
    assert.ok(xml.includes('language="en-GB"'));
    assert.ok(xml.includes('ttsLanguage="en-GB"'));
    assert.ok(xml.includes('transcriptionProvider="Deepgram"'));
    assert.ok(xml.includes('speechTimeout="1200"'));
    assert.ok(xml.includes('dtmfDetection="true"'));
    assert.ok(xml.includes(`<Parameter name="errandId" value="${id}" />`));
    assert.ok(xml.includes('<Parameter name="answeredBy" value="human" />'));
    assert.ok(xml.includes('<Parameter name="mode" value="person" />'));
    assert.match(xml, /<\/Connect>\n {2}<Hangup\/>\n<\/Response>$/);
  });

  it('unknown and absent are a person', () => {
    assert.ok(twimlFor('unknown').includes('<Parameter name="mode" value="person" />'));
    assert.ok(twimlFor().includes('<Parameter name="answeredBy" value="absent" />'));
  });

  it('machine_end_*: the same TwiML in voicemail mode, never a welcomeGreeting', () => {
    for (const value of ['machine_end_beep', 'machine_end_silence', 'machine_end_other']) {
      const xml = twimlFor(value);
      assert.ok(xml.includes('<Parameter name="mode" value="voicemail" />'), value);
      assert.ok(xml.includes(`voice="${VOICE_ID}"`));
      assert.equal(xml.includes('welcomeGreeting'), false);
    }
  });

  it('fax and machine_start: hang up, and the outcome reads machine without a message point', () => {
    const xml = twimlFor('fax');
    assert.match(xml, /<Hangup\/>/);
    assert.equal(xml.includes('ConversationRelay'), false);
    assert.deepEqual(
      { kind: readOutcome(id, home)?.kind, reason: readOutcome(id, home)?.reason },
      { kind: 'not_reached', reason: 'machine without a message point' },
    );
  });

  it('records an answered event with the AnsweredBy value and the masked CallSid', () => {
    twimlFor('machine_end_beep');
    const answered = readEvents(id, home).find((event) => event.kind === 'answered');
    assert.equal(answered?.answeredBy, 'machine_end_beep');
    assert.equal(answered?.mode, 'voicemail');
    assert.equal(answered?.callSid, 'CA01...cdef');
  });
});

describe('the TwiML endpoint through the server', () => {
  let server: Server;
  let port: number;
  beforeEach(async () => {
    ({ server } = createErrandServer({ tokens: () => [TEST_TOKEN], home, log: () => undefined }));
    port = await listen(server);
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('refuses an unsigned request and records nothing', async () => {
    const result = await postForm(port, `/errand/twiml?errand=${id}`, { AnsweredBy: 'human' }, { signature: null });
    assert.equal(result.status, 403);
    assert.equal(readEvents(id, home).some((event) => event.kind === 'answered'), false);
  });

  it('serves the person TwiML to a signed request', async () => {
    const result = await postForm(port, `/errand/twiml?errand=${id}`, { CallSid: 'CA0123456789abcdef0123456789abcdef', AnsweredBy: 'human' });
    assert.equal(result.status, 200);
    assert.ok(result.body.includes('<Parameter name="mode" value="person" />'));
    assert.equal(readEvents(id, home).filter((event) => event.kind === 'answered').length, 1);
  });
});
