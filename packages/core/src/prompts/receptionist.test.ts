import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderVoiceGreeting } from './receptionist.ts';
import type { BusinessContext } from '../types/domain.ts';

/**
 * The greeting is unusual among the prompt renderers: it is not a prompt at all. It is
 * spoken by Twilio straight from the TwiML, before the socket exists, so whatever this
 * returns *is* the first thing a caller hears. It is also the one line a caller cannot
 * ask to have repeated, because asking is what the rest of the call is for.
 *
 * The tests below are mostly about which field wins, because that is where it has already
 * gone wrong once — see the third case.
 */

/** The seeded missed-call apology, byte-identical in `greeting_template` and `missed_call_template`. */
const APOLOGY =
  "Hi, thanks for contacting {{business_name}}. We're sorry we missed your call. How can we help today?";

function makeContext(profile: Partial<BusinessContext['profile']> = {}): BusinessContext {
  return {
    business_id: 'b1',
    slug: 'test',
    name: 'Test Co',
    status: 'active',
    timezone: 'Europe/London',
    locale: 'en-GB',
    default_region: 'GB',
    currency: 'GBP',
    profile: {
      trading_name: 'Test Co',
      ai_assistant_name: 'Amy',
      voice_greeting_template: null,
      greeting_template: null,
      ...profile,
    } as BusinessContext['profile'],
    settings: {} as BusinessContext['settings'],
    services: [],
    service_areas: [],
    opening_hours: [],
    knowledge: [],
    phone_numbers: [],
  };
}

describe('renderVoiceGreeting', () => {
  it('speaks the tenant’s own line, with both placeholders filled', () => {
    const greeting = renderVoiceGreeting(
      makeContext({
        trading_name: 'Stallard Electrical',
        ai_assistant_name: 'Amy',
        voice_greeting_template: '{{business_name}}, good morning. This is {{assistant_name}}.',
      }),
    );

    assert.equal(greeting, 'Stallard Electrical, good morning. This is Amy.');
  });

  it('falls back to the built-in greeting when the tenant has set nothing', () => {
    const greeting = renderVoiceGreeting(makeContext());

    assert.match(greeting, /you've reached Test Co/);
    assert.match(greeting, /I'm Amy/);
  });

  it('never reads greeting_template, even when it is the only field set', () => {
    // The regression this column exists to prevent. `greeting_template` is the SMS
    // missed-call fallback, and the seeded value is the apology below — so while this
    // function read it, every caller was apologised to on the call being answered. First
    // heard on a live call on 2026-09-16, not in a test.
    const greeting = renderVoiceGreeting(makeContext({ greeting_template: APOLOGY }));

    assert.doesNotMatch(greeting, /missed your call/i);
    assert.match(greeting, /you've reached Test Co/);
  });

  it('treats a whitespace-only greeting as unset rather than playing silence', () => {
    const greeting = renderVoiceGreeting(makeContext({ voice_greeting_template: '   ' }));

    assert.match(greeting, /you've reached Test Co/);
  });

  it('falls back to the registered name when there is no trading name', () => {
    const greeting = renderVoiceGreeting(
      makeContext({ trading_name: null, voice_greeting_template: 'Welcome to {{business_name}}.' }),
    );

    assert.equal(greeting, 'Welcome to Test Co.');
  });

  it('shapes the line for speech, so markdown and markup cannot reach the synthesiser', () => {
    const greeting = renderVoiceGreeting(
      makeContext({ voice_greeting_template: 'Welcome to **{{business_name}}** <break time="1s"/>.' }),
    );

    assert.doesNotMatch(greeting, /[*<>]/);
    assert.match(greeting, /Welcome to Test Co/);
  });
});
