import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readFileSync } from 'node:fs';

import { buildConversationRelayTwiml } from './twilio.ts';
import { parseVoiceTestVariant } from './voice-test-variant.ts';

/**
 * The parser decides which ConversationRelay attributes a test call gets, so the rule
 * that matters most is the fail-safe: anything it cannot read means today's behaviour,
 * never Flux. The invalid cases below pin that down.
 */
describe('parseVoiceTestVariant', () => {
  it('maps unset, empty and "today" to today with no new attributes', () => {
    for (const raw of [undefined, '', '   ', 'today']) {
      const parsed = parseVoiceTestVariant(raw);
      assert.equal(parsed.name, 'today');
      assert.equal(parsed.valid, true, `raw ${JSON.stringify(raw)}`);
      assert.deepEqual(parsed.turn, {});
      assert.equal(parsed.voiceModel, undefined);
    }
  });

  it('maps flux-0.7 to Flux with threshold 0.7 and partial prompts on', () => {
    const parsed = parseVoiceTestVariant('flux-0.7');
    assert.equal(parsed.name, 'flux-0.7');
    assert.equal(parsed.valid, true);
    assert.deepEqual(parsed.turn, { speechModel: 'flux', threshold: 0.7, partialPrompts: true });
    assert.equal(parsed.voiceModel, undefined);
  });

  it('maps flux-0.8 to Flux with threshold 0.8 and partial prompts on', () => {
    const parsed = parseVoiceTestVariant('flux-0.8');
    assert.equal(parsed.name, 'flux-0.8');
    assert.equal(parsed.valid, true);
    assert.deepEqual(parsed.turn, { speechModel: 'flux', threshold: 0.8, partialPrompts: true });
  });

  it('accepts a Gemini model after a plus sign', () => {
    const parsed = parseVoiceTestVariant('flux-0.8+gemini-3.5-flash');
    assert.equal(parsed.name, 'flux-0.8+gemini-3.5-flash');
    assert.equal(parsed.valid, true);
    assert.deepEqual(parsed.turn, { speechModel: 'flux', threshold: 0.8, partialPrompts: true });
    assert.equal(parsed.voiceModel, 'gemini-3.5-flash');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(parseVoiceTestVariant('  flux-0.7\n').name, 'flux-0.7');
  });

  it('treats anything unparseable as invalid today', () => {
    for (const raw of ['flux-0.9', 'flux', 'today+claude-x', 'flux-0.7+gemini-x;rm', 'FLUX-0.7', 'flux-0.7+', 'flux-0.7+gemini-x+y', 'nonsense']) {
      const parsed = parseVoiceTestVariant(raw);
      assert.equal(parsed.name, 'today', raw);
      assert.equal(parsed.valid, false, raw);
      assert.deepEqual(parsed.turn, {}, raw);
      assert.equal(parsed.voiceModel, undefined, raw);
    }
  });
});

/**
 * T12: the web app's TwiML. `conversationRelayTwiml` lives in apps/web behind the `@/`
 * path alias, which the core test runner cannot resolve, so this test rebuilds the call
 * from the same inputs, through the same builder, with the same variant handling. The
 * source check below pins that the web files really contain that handling, so the mirror
 * cannot silently drift from them.
 *
 * TODAY_TWIML is a saved copy of what the web app produced before the variant existed
 * (captured from the builder and call inputs at git HEAD, 2026-10-18). Fixed greeting,
 * business id, call SID and number stand in for the per-call values.
 */
const TODAY_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Response>\n' +
  '  <Connect>\n' +
  '    <ConversationRelay url="wss://example.test/relay" welcomeGreeting="Hello, this is Amy." language="en-GB" ttsLanguage="en-GB" ttsProvider="ElevenLabs" voice="6fZce9LFNG3iEITDfqZZ" transcriptionProvider="Deepgram" speechTimeout="1200">\n' +
  '      <Parameter name="businessId" value="biz-1" />\n' +
  '      <Parameter name="callSid" value="CA0000000000000000000000000000test" />\n' +
  '      <Parameter name="to" value="+441234567890" />\n' +
  '    </ConversationRelay>\n' +
  '  </Connect>\n' +
  '</Response>';

/** Mirrors `conversationRelayTwiml` in apps/web/src/lib/conversation-relay.ts. */
function twimlFor(raw: string | undefined): string {
  const variant = parseVoiceTestVariant(raw);
  const { threshold, ...turn } = variant.turn;
  return buildConversationRelayTwiml({
    url: 'wss://example.test/relay',
    welcomeGreeting: 'Hello, this is Amy.',
    language: 'en-GB',
    ttsLanguage: 'en-GB',
    transcriptionProvider: 'Deepgram',
    speechTimeout: 1200,
    ttsProvider: 'ElevenLabs',
    voice: '6fZce9LFNG3iEITDfqZZ',
    ...turn,
    ...(threshold === undefined ? {} : { eotThreshold: threshold }),
    parameters: {
      businessId: 'biz-1',
      callSid: 'CA0000000000000000000000000000test',
      to: '+441234567890',
      ...(variant.name === 'today' ? {} : { turnVariant: variant.name }),
      ...(variant.voiceModel === undefined ? {} : { voiceModel: variant.voiceModel }),
    },
  });
}

describe('conversationRelayTwiml variant handling', () => {
  it('is byte-identical to today for unset, today and invalid values, with no turnVariant', () => {
    for (const raw of [undefined, '', 'today', 'flux-0.9', 'nonsense', 'today+gemini-x']) {
      const twiml = twimlFor(raw);
      assert.equal(twiml, TODAY_TWIML, `raw ${JSON.stringify(raw)}`);
      assert.ok(!twiml.includes('turnVariant'), `raw ${JSON.stringify(raw)}`);
    }
  });

  it('adds exactly the Flux attributes and the turnVariant parameter for flux-0.7', () => {
    const expected = TODAY_TWIML
      .replace(
        'transcriptionProvider="Deepgram" speechTimeout="1200">',
        'transcriptionProvider="Deepgram" speechModel="flux" speechTimeout="1200" eotThreshold="0.7" partialPrompts="true">',
      )
      .replace('    </ConversationRelay>', '      <Parameter name="turnVariant" value="flux-0.7" />\n    </ConversationRelay>');
    const actual = twimlFor('flux-0.7');
    assert.equal(actual, expected);
    assert.ok(!actual.includes('voiceModel'));
  });

  it('adds a voiceModel parameter only when the variant names a model', () => {
    const twiml = twimlFor('flux-0.8+gemini-3.5-flash');
    assert.ok(twiml.includes('<Parameter name="turnVariant" value="flux-0.8+gemini-3.5-flash" />'));
    assert.ok(twiml.includes('<Parameter name="voiceModel" value="gemini-3.5-flash" />'));
    assert.ok(!twimlFor('flux-0.8').includes('voiceModel'));
  });

  it('is wired into the web files', () => {
    const webRoot = new URL('../../../../apps/web/src/', import.meta.url);
    const relay = readFileSync(new URL('lib/conversation-relay.ts', webRoot), 'utf8');
    assert.ok(relay.includes('parseVoiceTestVariant('));
    assert.ok(relay.includes('turnVariant'));
    const health = readFileSync(new URL('app/api/health/route.ts', webRoot), 'utf8');
    assert.ok(health.includes('voiceTestVariant'));
  });
});
