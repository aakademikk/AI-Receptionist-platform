import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import WebSocket from 'ws';

import { MAX_CALL_S, OPENING_LINE } from './config.ts';
import { createErrandServer } from './server.ts';
import { ErrandSession, MAX_LENGTH_LINE, type OutboundFrame, playAllowanceMs, voicemailMessage } from './session.ts';
import { newErrand, readEvents, readOutcome, readTranscript } from './store.ts';
import { COLIN_MOBILE, TEST_TOKEN, listen, sampleBrief, tempDir, twilioSign } from './testing/fixtures.ts';
import type { ModelFn } from './turn.ts';

let home: string;
let cleanup: () => void;
let id: string;

beforeEach(() => {
  ({ dir: home, cleanup } = tempDir());
  id = newErrand(sampleBrief(), new Date('2026-10-27T14:12:00Z'), home).id;
  mock.timers.enable({ apis: ['setTimeout'] });
});
afterEach(() => {
  mock.timers.reset();
  cleanup();
});

function scripted(...decisions: unknown[]): ModelFn {
  let calls = 0;
  return async () => decisions[Math.min(calls++, decisions.length - 1)];
}

function makeSession(model: ModelFn = scripted({ say: 'Hello.' })) {
  const frames: OutboundFrame[] = [];
  const session = new ErrandSession({ send: (frame) => void frames.push(frame), model, home });
  return { session, frames };
}

const setup = (mode: string, answeredBy = 'human') => ({ type: 'setup', callSid: 'CA0123456789abcdef0123456789abcdef', customParameters: { errandId: id, answeredBy, mode } });
const prompt = (words: string, last = true) => ({ type: 'prompt', voicePrompt: words, last });

describe('ErrandSession: person mode (must-do 8)', () => {
  it('sends nothing before the first final prompt, and ignores partial prompts', async () => {
    const { session, frames } = makeSession();
    await session.handle(setup('person'));
    await session.handle(prompt('Hello, Lu', false));
    assert.equal(frames.length, 0);
    await session.handle(prompt("Hello, Luigi's."));
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.type, 'text');
    assert.ok((frames[0] as { token: string }).token.startsWith(OPENING_LINE));
    session.dispose();
  });

  it('writes every turn to the transcript with speaker, words and time', async () => {
    const { session } = makeSession(scripted({ say: "I'd like a table for two on Wednesday." }, { say: 'Half seven, please.' }));
    await session.handle(setup('person'));
    await session.handle(prompt("Hello, Luigi's."));
    await session.handle(prompt('What time?'));
    const transcript = readTranscript(id, home);
    assert.deepEqual(transcript.map((line) => line.speaker), ['them', 'amy', 'them', 'amy']);
    assert.equal(transcript[2]!.words, 'What time?');
    assert.equal(transcript[3]!.words, 'Half seven, please.');
    assert.ok(transcript.every((line) => !Number.isNaN(Date.parse(line.time))));
    session.dispose();
  });

  it('an ending decision writes the outcome, lets the line play, then sends end', async () => {
    const { session, frames } = makeSession(scripted({ say: 'Lovely, thank you, goodbye.', agreedTime: '19:30', done: 'booked', nameBookedUnder: 'Colin Wood' }));
    await session.handle(setup('person'));
    await session.handle(prompt('Half seven is booked under Colin Wood.'));
    assert.equal(readOutcome(id, home)?.kind, 'booked');
    assert.equal(readOutcome(id, home)?.agreedTime, '19:30');
    assert.equal(frames.at(-1)!.type, 'text');
    mock.timers.tick(playAllowanceMs((frames.at(-1) as { token: string }).token));
    assert.deepEqual(frames.at(-1), { type: 'end' });
    // A prompt after the end is ignored.
    const count = frames.length;
    await session.handle(prompt('Hello?'));
    assert.equal(frames.length, count);
  });

  it('a payment ask ends with "ended early: payment asked"', async () => {
    const { session } = makeSession();
    await session.handle(setup('person'));
    await session.handle(prompt('Can I take a card number?'));
    assert.deepEqual([readOutcome(id, home)?.kind, readOutcome(id, home)?.limit], ['ended_early', 'payment asked']);
    session.dispose();
  });
});

describe('ErrandSession: menus (must-do 13)', () => {
  it('a menu prompt producing digits sends sendDigits and logs a digits event', async () => {
    const { session, frames } = makeSession(scripted({ say: '', digits: '2' }));
    await session.handle(setup('person'));
    await session.handle(prompt('For reservations press 2.'));
    assert.deepEqual(frames, [{ type: 'sendDigits', digits: '2' }]);
    assert.equal(readEvents(id, home).find((event) => event.kind === 'digits')?.digits, '2');
    session.dispose();
  });

  it('logs keypresses arriving on the line', async () => {
    const { session } = makeSession();
    await session.handle(setup('person'));
    await session.handle({ type: 'dtmf', digit: '5' });
    assert.equal(readEvents(id, home).find((event) => event.kind === 'dtmf_in')?.digit, '5');
    session.dispose();
  });
});

describe('ErrandSession: voicemail mode (must-do 14)', () => {
  it('sends exactly one text then end, and ignores a later prompt', async () => {
    let calls = 0;
    const { session, frames } = makeSession(async () => {
      calls += 1;
      return { say: 'should never be asked' };
    });
    await session.handle(setup('voicemail', 'machine_end_beep'));
    assert.equal(frames.length, 1);
    const message = (frames[0] as { token: string }).token;
    assert.ok(message.startsWith(OPENING_LINE));
    assert.ok(message.includes('book a table for two'));
    assert.ok(message.includes(`Please call Colin back on ${COLIN_MOBILE}.`));
    assert.equal(message, voicemailMessage(sampleBrief()));
    await session.handle(prompt('Hi, you have reached Luigi\'s, leave a message.'));
    mock.timers.tick(playAllowanceMs(message));
    assert.deepEqual(frames.map((frame) => frame.type), ['text', 'end']);
    assert.equal(calls, 0);
    assert.equal(readOutcome(id, home)?.kind, 'voicemail_left');
    assert.deepEqual(readTranscript(id, home).map((line) => line.speaker), ['amy']);
  });
});

describe('ErrandSession: maximum length (must-do 12)', () => {
  it('ten seconds before the limit, says the ring-off line and ends "maximum length"', async () => {
    const { session, frames } = makeSession();
    await session.handle(setup('person'));
    mock.timers.tick(MAX_CALL_S * 1000 - 10_001);
    assert.equal(frames.length, 0);
    mock.timers.tick(1);
    assert.deepEqual(frames, [{ type: 'text', token: MAX_LENGTH_LINE, last: true }]);
    assert.deepEqual([readOutcome(id, home)?.kind, readOutcome(id, home)?.limit], ['ended_early', 'maximum length']);
    mock.timers.tick(playAllowanceMs(MAX_LENGTH_LINE));
    assert.deepEqual(frames.at(-1), { type: 'end' });
  });
});

describe('ErrandSession: setup', () => {
  it('ends at once for an unknown errand', async () => {
    const { session, frames } = makeSession();
    await session.handle({ type: 'setup', customParameters: { errandId: '2026-10-27-1412-nobody', mode: 'person' } });
    assert.deepEqual(frames, [{ type: 'end' }]);
    assert.equal(session.isEnded, true);
  });

  it('a socket that closes with no outcome leaves it to the status callback', async () => {
    const { session } = makeSession();
    await session.handle(setup('person'));
    session.dispose();
    assert.equal(readOutcome(id, home), null);
    assert.equal(readEvents(id, home).at(-1)?.kind, 'socket_closed');
  });
});

describe('the session through the server socket', () => {
  let server: Server;
  let port: number;
  beforeEach(async () => {
    mock.timers.reset();
    ({ server } = createErrandServer({ tokens: () => [TEST_TOKEN], home, log: () => undefined, model: scripted({ say: "I'd like a table for two." }) }));
    port = await listen(server);
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('runs setup and a prompt over a signed socket', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/errand/ws`, {
      headers: { 'x-twilio-signature': twilioSign(TEST_TOKEN, 'wss://receptionist.atwoodsystems.co.uk/errand/ws') },
    });
    await new Promise((resolve) => ws.on('open', resolve));
    const received = new Promise<string>((resolve) => ws.on('message', (data) => resolve(data.toString())));
    ws.send(JSON.stringify(setup('person')));
    ws.send('not json');
    ws.send(JSON.stringify(prompt("Hello, Luigi's.")));
    const frame = JSON.parse(await received) as { type: string; token: string };
    assert.equal(frame.type, 'text');
    assert.ok(frame.token.startsWith(OPENING_LINE));
    ws.close();
    await new Promise((resolve) => ws.on('close', resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
