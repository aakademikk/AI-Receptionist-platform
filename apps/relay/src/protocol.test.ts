import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RelaySession,
  SILENCE_HANGUP_MS,
  SILENCE_PROMPT_MS,
  estimatedSpeechMs,
  parseFrame,
  sanitiseForSpeech,
  type InboundFrame,
  type OutboundFrame,
  type RelayReply,
  type RelayReplyFn,
  type RelayReplyRequest,
} from './protocol.ts';

/**
 * Collect the events a session emitted, so tests can assert on the call log too.
 *
 * Every session in here is built with an injected reply function, because none of these
 * tests should touch a model or a database — the whole point of the seam is that the turn
 * logic can be exercised with a fake standing in for the domain layer.
 */
function sessionWithLog(options: { maxTurns?: number; reply?: RelayReplyFn } = {}) {
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const session = new RelaySession({
    ...options,
    onEvent: (event, fields) => events.push({ event, fields }),
  });
  return { session, events, names: () => events.map((entry) => entry.event) };
}

/** A reply function that always says the same thing. */
const says = (speak: string, endCall = false): RelayReplyFn => async () => ({ speak, endCall });

/** A reply function that records what it was asked and answers immediately. */
function recordingReply(result: RelayReply = { speak: 'Of course.', endCall: false }) {
  const requests: RelayReplyRequest[] = [];
  const fn: RelayReplyFn = async (request) => {
    requests.push(request);
    return result;
  };
  return { fn, requests };
}

/**
 * A reply function whose promises are resolved by hand, so a test can hold a turn in
 * flight and then do something to the session before it lands.
 */
function deferredReply() {
  const requests: RelayReplyRequest[] = [];
  const resolvers: Array<(reply: RelayReply) => void> = [];

  const fn: RelayReplyFn = (request) => {
    requests.push(request);
    return new Promise((resolve) => resolvers.push(resolve));
  };

  return {
    fn,
    requests,
    resolve: (index: number, reply: RelayReply): void => resolvers[index]!(reply),
  };
}

const SETUP: InboundFrame = {
  type: 'setup',
  sessionId: 'VX123',
  callSid: 'CA123',
  from: '+447000000000',
  to: '+447462187713',
  callType: 'PSTN',
  direction: 'inbound',
  customParameters: { businessId: 'biz-1' },
};

const finalPrompt = (text: string): InboundFrame => ({
  type: 'prompt',
  voicePrompt: text,
  last: true,
});

const textOf = (frames: OutboundFrame[]): string => {
  const text = frames.find((frame) => frame.type === 'text');
  return text?.type === 'text' ? text.token : '';
};

const STILL_THERE = 'Are you still there?';

/**
 * A session with the silence backstop switched on, and a record of the frames it sent
 * unprompted — the ones no `handle` call returned.
 */
function backstopSession(reply: RelayReplyFn) {
  const sent: OutboundFrame[] = [];
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const session = new RelaySession({
    reply,
    onEvent: (event, fields) => events.push({ event, fields }),
    send: (frames) => sent.push(...frames),
    stillThereLine: STILL_THERE,
  });
  return { session, events, names: () => events.map((entry) => entry.event), sent };
}

const SIGN_OFF = 'No problem at all. Have a good evening.';

describe('parseFrame', () => {
  it('parses a well-formed frame', () => {
    assert.deepEqual(parseFrame('{"type":"prompt","voicePrompt":"hi","last":true}'), {
      type: 'prompt',
      voicePrompt: 'hi',
      last: true,
    });
  });

  it('returns null for invalid JSON rather than throwing', () => {
    // A throw here would kill a live socket. See the module header.
    assert.equal(parseFrame('not json at all'), null);
  });

  it('returns null for JSON that is not an object', () => {
    assert.equal(parseFrame('"a string"'), null);
    assert.equal(parseFrame('42'), null);
    assert.equal(parseFrame('null'), null);
    assert.equal(parseFrame('[1,2,3]'), null);
  });

  it('returns null when type is missing or not a string', () => {
    assert.equal(parseFrame('{}'), null);
    assert.equal(parseFrame('{"type":123}'), null);
    assert.equal(parseFrame('{"type":""}'), null);
  });
});

describe('sanitiseForSpeech', () => {
  it('removes angle brackets so nothing can reach the synthesiser as SSML', () => {
    assert.equal(sanitiseForSpeech('say <break time="3s"/> now'), 'say break time="3s"/ now');
  });

  it('collapses the whitespace the removal leaves behind', () => {
    assert.equal(sanitiseForSpeech('a  <>   b'), 'a b');
  });

  it('leaves ordinary speech alone', () => {
    assert.equal(sanitiseForSpeech('hello there'), 'hello there');
  });
});

describe('RelaySession', () => {
  it('says nothing on setup, because the greeting comes from the TwiML', async () => {
    // If the greeting were sent from here, a socket that failed to connect would leave
    // the caller in silence with no way to tell a broken deployment from a quiet one.
    const { session, names } = sessionWithLog();
    assert.deepEqual(await session.handle(SETUP), []);
    assert.deepEqual(names(), ['setup']);
  });

  it('records the tenant from customParameters', async () => {
    const { session, events } = sessionWithLog();
    await session.handle(SETUP);
    assert.deepEqual(events[0]!.fields.customParameters, { businessId: 'biz-1' });
  });

  it('does not answer an interim prompt', async () => {
    // Answering partials talks over the caller every time they pause mid-sentence.
    const { fn, requests } = recordingReply();
    const { session, names } = sessionWithLog({ reply: fn });

    assert.deepEqual(await session.handle({ type: 'prompt', voicePrompt: 'I want to', last: false }), []);
    assert.deepEqual(names(), ['prompt_partial']);
    assert.equal(requests.length, 0, 'an interim result must not reach the reply function');
  });

  it('speaks what the reply function returned and keeps the call up', async () => {
    const { fn } = recordingReply({ speak: 'Yes, we cover that postcode.', endCall: false });
    const { session, names } = sessionWithLog({ reply: fn });

    await session.handle(SETUP);
    const out = await session.handle(finalPrompt('do you cover SW1'));

    assert.equal(out.length, 1);
    assert.equal(textOf(out), 'Yes, we cover that postcode.');
    assert.equal(session.isEnded, false);
    assert.ok(names().includes('turn_answered'));
  });

  it('hands the reply function the call identity and the turn number', async () => {
    const { fn, requests } = recordingReply();
    const { session } = sessionWithLog({ reply: fn });

    await session.handle(SETUP);
    await session.handle(finalPrompt('hello'));

    assert.deepEqual(requests, [
      {
        callSid: 'CA123',
        toNumber: '+447462187713',
        fromNumber: '+447000000000',
        heard: 'hello',
        turn: 1,
        anythingElseAsked: false,
        anythingElseJustAsked: false,
      },
    ]);
  });

  it('ends the call when the reply function says to', async () => {
    // This is how a handover closes a line: the domain decides, the socket obeys.
    const { session, names } = sessionWithLog({ reply: says('I am passing you to a colleague.', true) });

    await session.handle(SETUP);
    const out = await session.handle(finalPrompt('I want to speak to a human'));

    assert.equal(out.length, 2);
    assert.deepEqual(out[1], { type: 'end' });
    assert.equal(session.isEnded, true);
    assert.equal(names().at(-1), 'session_end');
  });

  it('never sends an empty token, which Twilio rejects', async () => {
    const { session, names } = sessionWithLog({ reply: says('<>') });
    await session.handle(SETUP);

    const out = await session.handle(finalPrompt('hello'));

    // Saying nothing is the safe failure. An empty `text` token is a protocol error that
    // ends the call, so the frame is dropped instead.
    assert.deepEqual(out, []);
    assert.ok(names().includes('empty_reply'));
  });

  it('sanitises the spoken token, so no reply can reach the synthesiser as markup', async () => {
    const { session } = sessionWithLog({ reply: says('say <break time="3s"/> now') });
    await session.handle(SETUP);

    const token = textOf(await session.handle(finalPrompt('hello')));
    assert.ok(!token.includes('<'));
    assert.ok(!token.includes('>'));
  });

  it('does not speak a reply the caller interrupted', async () => {
    // The caller hears their barge-in take effect; without this they would then hear the
    // answer they interrupted, which is worse than the interruption never landing.
    const { fn, requests, resolve } = deferredReply();
    const { session, names } = sessionWithLog({ reply: fn });
    await session.handle(SETUP);

    const pending = session.handle(finalPrompt('book me in for Friday'));
    // `handle` runs to its first await synchronously, so the request is already out.
    assert.equal(requests.length, 1);

    assert.deepEqual(
      await session.handle({
        type: 'interrupt',
        utteranceUntilInterrupt: 'no wait',
        durationUntilInterruptMs: 400,
      }),
      [],
    );

    resolve(0, { speak: 'Certainly, I can book you in for Friday.', endCall: false });

    assert.deepEqual(await pending, [], 'the superseded answer must not be spoken');
    assert.ok(names().includes('turn_superseded'));
    assert.equal(names().includes('turn_answered'), false);
  });

  it('does not speak a reply to a turn the caller has moved on from', async () => {
    const { fn, resolve } = deferredReply();
    const { session, names } = sessionWithLog({ reply: fn });
    await session.handle(SETUP);

    const first = session.handle(finalPrompt('I need a plumber'));
    const second = session.handle(finalPrompt('actually, a roofer'));

    resolve(0, { speak: 'I can arrange a plumber.', endCall: false });
    assert.deepEqual(await first, [], 'the stale turn must be dropped');

    resolve(1, { speak: 'I can arrange a roofer.', endCall: false });
    assert.equal(textOf(await second), 'I can arrange a roofer.');
    assert.ok(names().includes('turn_superseded'));
  });

  it('says nothing when the caller interrupts with no reply in flight', async () => {
    const { session, names } = sessionWithLog();
    assert.deepEqual(
      await session.handle({ type: 'interrupt', utteranceUntilInterrupt: 'wait', durationUntilInterruptMs: 800 }),
      [],
    );
    assert.deepEqual(names(), ['interrupt']);
  });

  it('stays silent on a prompt that arrived before the setup frame', async () => {
    // Twilio does not do this, and without a setup frame there is no call identity to
    // resolve a tenant from and no idempotency key to mint. Silence is the protocol's
    // safe failure — see the module header.
    const { fn, requests } = recordingReply();
    const { session, names } = sessionWithLog({ reply: fn });

    assert.deepEqual(await session.handle(finalPrompt('hello')), []);
    assert.ok(names().includes('prompt_before_setup'));
    assert.equal(requests.length, 0);
  });

  it('logs DTMF rather than dropping a keypress the caller believed they sent', async () => {
    const { session, names } = sessionWithLog();
    assert.deepEqual(await session.handle({ type: 'dtmf', digit: '1' }), []);
    assert.deepEqual(names(), ['dtmf']);
  });

  it('surfaces a Twilio error frame as an event', async () => {
    const { session, names } = sessionWithLog();
    assert.deepEqual(await session.handle({ type: 'error', description: 'unknown voice' }), []);
    assert.deepEqual(names(), ['twilio_error']);
  });

  it('ignores anything after the call has ended', async () => {
    // A late prompt would otherwise restart a call we have already finished.
    const { fn, requests } = recordingReply({ speak: 'Goodbye.', endCall: true });
    const { session, names } = sessionWithLog({ reply: fn });

    await session.handle(SETUP);
    await session.handle(finalPrompt('hello'));
    assert.deepEqual(await session.handle(finalPrompt('hello again')), []);

    assert.ok(names().includes('frame_after_end'));
    assert.equal(requests.length, 1, 'a frame after the end must not reach the reply function');
  });

  it('handles several turns when the domain keeps the call open', async () => {
    const { fn } = recordingReply({ speak: 'Go on.', endCall: false });
    const { session } = sessionWithLog({ reply: fn });

    await session.handle(SETUP);
    assert.equal((await session.handle(finalPrompt('one'))).length, 1);
    assert.equal(session.isEnded, false);
    assert.equal((await session.handle(finalPrompt('two'))).length, 1);
    assert.equal(session.isEnded, false);
  });

  it('hangs up at the hard turn limit even if the domain never asks it to', async () => {
    // A backstop against a bug in the domain layer billing somebody for an hour-long
    // call. The tenant's own limit is `ai_max_turns` and is enforced by the assistant
    // ending the conversation in words, which is not this.
    const { session, events, names } = sessionWithLog({ maxTurns: 2, reply: says('Go on.', false) });

    await session.handle(SETUP);
    assert.equal((await session.handle(finalPrompt('one'))).length, 1);
    assert.equal(session.isEnded, false);

    const out = await session.handle(finalPrompt('two'));
    assert.deepEqual(out.at(-1), { type: 'end' });
    assert.equal(session.isEnded, true);
    assert.deepEqual(names().at(-1), 'session_end');
    assert.equal(events.at(-1)!.fields.reason, 'hard_turn_limit');
  });

  describe('remembering "anything else?"', () => {
    const ASKED: RelayReply = {
      speak: 'Is there anything else I can help you with?',
      endCall: false,
      closing: 'asked_anything_else',
    };
    const ORDINARY: RelayReply = { speak: 'Go on.', endCall: false, closing: 'none' };

    it('is false on the first turn', async () => {
      const { fn, requests } = recordingReply();
      const { session } = sessionWithLog({ reply: fn });

      await session.handle(SETUP);
      await session.handle(finalPrompt('hello'));

      assert.equal(requests[0]!.anythingElseAsked, false);
    });

    it('is true on the turn after the question was asked, and stays true', async () => {
      const { fn, requests, resolve } = deferredReply();
      const { session } = sessionWithLog({ reply: fn });
      await session.handle(SETUP);

      const first = session.handle(finalPrompt("that's all, bye"));
      resolve(0, ASKED);
      await first;

      const second = session.handle(finalPrompt('actually, do you work weekends'));
      resolve(1, ORDINARY);
      await second;

      const third = session.handle(finalPrompt('thanks'));
      resolve(2, ORDINARY);
      await third;

      assert.deepEqual(
        requests.map((request) => request.anythingElseAsked),
        [false, true, true],
      );
    });

    it('marks "just asked" only on the turn straight after the ask, so a later "no" is just a no', async () => {
      const { fn, requests, resolve } = deferredReply();
      const { session } = sessionWithLog({ reply: fn });
      await session.handle(SETUP);

      const first = session.handle(finalPrompt("that's all, bye"));
      resolve(0, ASKED);
      await first;

      const second = session.handle(finalPrompt('actually, can I get a quote'));
      resolve(1, ORDINARY);
      await second;

      const third = session.handle(finalPrompt('no'));
      resolve(2, ORDINARY);
      await third;

      assert.deepEqual(
        requests.map((request) => request.anythingElseJustAsked),
        [false, true, false],
      );
    });

    it('stays false when the asking reply was interrupted, because the caller never heard it', async () => {
      const { fn, requests, resolve } = deferredReply();
      const { session } = sessionWithLog({ reply: fn });
      await session.handle(SETUP);

      const first = session.handle(finalPrompt("that's all, bye"));
      await session.handle({ type: 'interrupt', utteranceUntilInterrupt: 'oh wait', durationUntilInterruptMs: 300 });
      resolve(0, ASKED);
      assert.deepEqual(await first, []);

      const second = session.handle(finalPrompt('one more thing'));
      resolve(1, ORDINARY);
      await second;

      assert.equal(requests[1]!.anythingElseAsked, false);
    });

    it('stays false when the asking reply was superseded by a newer turn', async () => {
      const { fn, requests, resolve } = deferredReply();
      const { session } = sessionWithLog({ reply: fn });
      await session.handle(SETUP);

      const first = session.handle(finalPrompt("that's all, bye"));
      const second = session.handle(finalPrompt('oh, and the boiler'));
      resolve(0, ASKED);
      assert.deepEqual(await first, []);
      resolve(1, ORDINARY);
      await second;

      const third = session.handle(finalPrompt('ok'));
      resolve(2, ORDINARY);
      await third;

      assert.equal(requests[2]!.anythingElseAsked, false);
    });
  });

  describe('silence backstop', () => {
    const promptAt = estimatedSpeechMs(SIGN_OFF) + SILENCE_PROMPT_MS;
    const hangupAfter = estimatedSpeechMs(STILL_THERE) + SILENCE_HANGUP_MS;

    it('asks "are you still there?" after a sign-off and 3 s of silence (check 3)', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const { session, names, sent } = backstopSession(async () => ({
        speak: SIGN_OFF,
        endCall: false,
        closing: 'wrapped_up',
      }));

      await session.handle(SETUP);
      await session.handle(finalPrompt('sorry, wrong number'));

      // Nothing while she is still saying it, or in the 3 s after.
      t.mock.timers.tick(promptAt - 1);
      assert.deepEqual(sent, []);

      t.mock.timers.tick(1);
      assert.deepEqual(sent, [{ type: 'text', token: STILL_THERE, last: true }]);
      assert.ok(names().includes('silence_prompt'));
      assert.equal(session.isEnded, false);
    });

    it('is armed by "anything else?" too', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const line = 'Is there anything else I can help you with?';
      const { session, sent } = backstopSession(async () => ({
        speak: line,
        endCall: false,
        closing: 'asked_anything_else',
      }));

      await session.handle(SETUP);
      await session.handle(finalPrompt("that's all, bye"));

      t.mock.timers.tick(estimatedSpeechMs(line) + SILENCE_PROMPT_MS);
      assert.deepEqual(sent, [{ type: 'text', token: STILL_THERE, last: true }]);
    });

    it('ends the call after 3 s more of silence (check 4)', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const { session, events, names, sent } = backstopSession(async () => ({
        speak: SIGN_OFF,
        endCall: false,
        closing: 'wrapped_up',
      }));

      await session.handle(SETUP);
      await session.handle(finalPrompt('sorry, wrong number'));

      t.mock.timers.tick(promptAt);
      assert.equal(sent.length, 1);

      t.mock.timers.tick(hangupAfter - 1);
      assert.equal(sent.length, 1, 'nothing hangs up before the second window has run');

      t.mock.timers.tick(1);
      assert.deepEqual(sent.at(-1), { type: 'end' });
      assert.equal(session.isEnded, true);
      assert.equal(names().at(-1), 'session_end');
      assert.equal(events.at(-1)!.fields.reason, 'silence');

      // And a late frame cannot restart it.
      assert.deepEqual(await session.handle(finalPrompt('hello?')), []);
    });

    it('never runs after an ordinary turn, however long the caller pauses (check 5)', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      for (const closing of ['none', undefined] as const) {
        const { session, sent, names } = backstopSession(async () => ({
          speak: 'Let me just check that for you. What is the postcode',
          endCall: false,
          closing,
        }));

        await session.handle(SETUP);
        await session.handle(finalPrompt('I need a boiler service'));

        t.mock.timers.tick(10_000);
        assert.deepEqual(sent, [], `closing: ${String(closing)}`);
        assert.equal(session.isEnded, false);
        assert.equal(names().includes('silence_armed'), false);
      }
    });

    it('is cancelled by partial speech inside the first window (check 6)', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const { session, sent, names } = backstopSession(async () => ({
        speak: SIGN_OFF,
        endCall: false,
        closing: 'wrapped_up',
      }));

      await session.handle(SETUP);
      await session.handle(finalPrompt('sorry, wrong number'));

      t.mock.timers.tick(promptAt - 500);
      await session.handle({ type: 'prompt', voicePrompt: 'oh actually', last: false });

      t.mock.timers.tick(20_000);
      assert.deepEqual(sent, []);
      assert.equal(session.isEnded, false);
      assert.ok(names().includes('silence_cancelled'));
    });

    it('is cancelled by partial speech inside the second window (check 6)', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const { session, sent } = backstopSession(async () => ({
        speak: SIGN_OFF,
        endCall: false,
        closing: 'wrapped_up',
      }));

      await session.handle(SETUP);
      await session.handle(finalPrompt('sorry, wrong number'));

      t.mock.timers.tick(promptAt);
      assert.equal(sent.length, 1, 'the still-there line went out');

      t.mock.timers.tick(hangupAfter - 500);
      await session.handle({ type: 'prompt', voicePrompt: 'yes sorry I', last: false });

      t.mock.timers.tick(20_000);
      assert.equal(sent.length, 1, 'no end frame after the caller spoke');
      assert.equal(sent.some((frame) => frame.type === 'end'), false);
      assert.equal(session.isEnded, false);
    });

    it('is cancelled by a barge-in and by a keypress', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      for (const frame of [
        { type: 'interrupt', utteranceUntilInterrupt: 'Have a', durationUntilInterruptMs: 500 },
        { type: 'dtmf', digit: '1' },
      ]) {
        const { session, sent } = backstopSession(async () => ({
          speak: SIGN_OFF,
          endCall: false,
          closing: 'wrapped_up',
        }));

        await session.handle(SETUP);
        await session.handle(finalPrompt('sorry, wrong number'));
        await session.handle(frame);

        t.mock.timers.tick(20_000);
        assert.deepEqual(sent, [], frame.type);
      }
    });

    it('schedules nothing when the reply already ends the call', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const { session, sent, names } = backstopSession(async () => ({
        speak: 'No problem. Thanks for calling, bye for now.',
        endCall: true,
        closing: 'wrapped_up',
      }));

      await session.handle(SETUP);
      const out = await session.handle(finalPrompt('no thanks'));
      assert.deepEqual(out.at(-1), { type: 'end' });

      t.mock.timers.tick(20_000);
      assert.deepEqual(sent, [], 'the end went out with the reply; nothing follows it');
      assert.equal(names().includes('silence_armed'), false);
    });

    it('fires nothing after dispose()', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const { session, sent } = backstopSession(async () => ({
        speak: SIGN_OFF,
        endCall: false,
        closing: 'wrapped_up',
      }));

      await session.handle(SETUP);
      await session.handle(finalPrompt('sorry, wrong number'));
      session.dispose();

      t.mock.timers.tick(20_000);
      assert.deepEqual(sent, []);
    });

    it('stays off when no send function or still-there line was given', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const { session, names } = sessionWithLog({
        reply: async () => ({ speak: SIGN_OFF, endCall: false, closing: 'wrapped_up' }),
      });

      await session.handle(SETUP);
      await session.handle(finalPrompt('sorry, wrong number'));

      t.mock.timers.tick(20_000);
      assert.equal(names().includes('silence_armed'), false);
      assert.equal(session.isEnded, false);
    });
  });

  it('does not throw on an unknown frame type', async () => {
    const { session, names } = sessionWithLog();
    assert.deepEqual(await session.handle({ type: 'something-new' }), []);
    assert.deepEqual(names(), ['unhandled_frame']);
  });
});
