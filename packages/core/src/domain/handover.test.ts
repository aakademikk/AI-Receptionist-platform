import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  detectHandover,
  isMuteFromEarlierCall,
  needsDetailCapture,
  renderCaptureMessage,
  shouldIncrementConfusion,
} from './handover.ts';
import type { BusinessContext, ConversationMemory } from '../types/domain.ts';
import { buildReceptionistSystemPrompt } from '../prompts/receptionist.ts';

/**
 * Handover is the highest-consequence logic in the platform: a missed emergency is
 * the worst thing this system can do. These tests are the specification.
 */

function makeContext(overrides: Partial<BusinessContext['settings']> = {}): BusinessContext {
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
      tone_of_voice: 'warm',
      brand_primary: '#000000',
      brand_accent: '#111111',
      brand_background: '#ffffff',
      brand_foreground: '#000000',
      social_links: {},
    } as BusinessContext['profile'],
    settings: {
      handover_enabled: true,
      handover_keywords: ['section 20', 'ombudsman'],
      handover_on_emergency: true,
      handover_on_complaint: true,
      handover_confusion_threshold: 3,
      ai_max_turns: 20,
      ...overrides,
    } as BusinessContext['settings'],
    services: [],
    service_areas: [],
    opening_hours: [],
    knowledge: [],
    phone_numbers: [],
  };
}

function makeMemory(overrides: Partial<ConversationMemory> = {}): ConversationMemory {
  return {
    conversation_id: 'c1',
    business_id: 'b1',
    channel: 'sms',
    status: 'active',
    customer_phone: '+447700900123',
    customer_name: null,
    summary: null,
    current_topic: null,
    lead_status: 'qualifying',
    ai_enabled: true,
    ai_turn_count: 2,
    confusion_count: 0,
    message_count: 4,
    transcript: [],
    known: {
      name: null,
      phone: null,
      email: null,
      postcode: null,
      service: null,
      enquiry: null,
      urgency: null,
      callback: null,
    },
    is_returning_contact: false,
    ...overrides,
  };
}

describe('detectHandover — emergencies', () => {
  const cases: Array<[string, string]> = [
    ['water ingress', 'There is water pouring through the ceiling'],
    ['leak', 'We have a leak in the communal hallway'],
    ['gas', 'I can smell gas in the stairwell'],
    ['fire', 'There is smoke coming from the basement'],
    ['injury', 'Someone has been injured on the stairs'],
    ['utility loss', 'There is no hot water in the whole block'],
    ['security', 'The front door has been broken into'],
    ['explicit', 'This is an emergency'],
    ['structural', 'The ceiling has collapsed'],
  ];

  for (const [label, message] of cases) {
    it(`escalates on ${label}`, () => {
      const decision = detectHandover({
        context: makeContext(),
        memory: makeMemory(),
        inboundText: message,
      });
      assert.equal(decision.shouldHandover, true, `"${message}" should escalate`);
      assert.equal(decision.reason, 'emergency');
      assert.equal(decision.notifyCustomer, true);
      assert.ok(decision.note, 'an escalation must carry an auditable note');
    });
  }

  it('does not escalate on an ordinary enquiry that merely mentions a fireplace', () => {
    const decision = detectHandover({
      context: makeContext(),
      memory: makeMemory(),
      inboundText: 'Do your properties usually have a fireplace?',
    });
    assert.equal(decision.shouldHandover, false);
  });
});

describe('detectHandover — requests for a person', () => {
  const messages = [
    'Can I speak to a human please',
    'I want to speak to a person',
    'Is this a bot?',
    'Put me through to a manager',
    'Transfer me to someone in charge',
    'Call me back now',
  ];

  for (const message of messages) {
    it(`escalates on "${message}"`, () => {
      const decision = detectHandover({
        context: makeContext(),
        memory: makeMemory(),
        inboundText: message,
      });
      assert.equal(decision.shouldHandover, true);
      assert.equal(decision.reason, 'customer_request');
    });
  }

  /*
   * The regression this file did not have, and the reason `someone` was dropped from the
   * target list.
   *
   * On 2026-09-17 a caller rang to ask about rewiring a house and said they would like to
   * talk to someone, or get a price. The word "someone" matched, the call was escalated
   * before a single detail was taken, and the line was closed with a promise that nobody
   * could keep. The sentence is a buying signal, not a request to be let off the bot.
   *
   * "Talk to someone" is now escalated only when an escalation verb carries it ("put me
   * through to someone", covered above). That is the deliberate trade: a caller who says
   * *only* "I want to talk to someone" is not escalated on this line, and is instead
   * caught by the turn budget or the confusion ladder. Recall was spent on purpose here,
   * because the cost of the false positive was a lost customer with nobody told.
   */
  const notEscalated = [
    "I've got a house that needs rewiring, could I talk to someone or get a price?",
    'I want to talk to someone about a quote',
    'Could I speak to somebody about pricing',
  ];

  for (const message of notEscalated) {
    it(`does not escalate on "${message}"`, () => {
      const decision = detectHandover({
        context: makeContext(),
        memory: makeMemory(),
        inboundText: message,
      });
      assert.equal(decision.shouldHandover, false, `"${message}" is an enquiry, not an escalation`);
    });
  }

  /*
   * The same sentence, against the keyword list the live tenant actually carries.
   *
   * Tightening the patterns above was not enough on its own. `handover_keywords` shipped a
   * schema default containing the literal "talk to someone", the VOLTA row had inherited
   * it, and rule 4 matches a multi-word keyword as a plain substring — so the identical
   * sentence escalated down a second path that no amount of pattern work would close. Both
   * the default in `0003_profile_and_knowledge.sql` and the live row were changed with it.
   *
   * Pinned here as a list rather than read from the database so the test says what the
   * tenant's keywords should be, not merely what they are: if someone re-adds the phrase
   * to the default, this fails on the next run rather than on the next phone call.
   */
  it('does not escalate Colin\'s sentence even via the tenant keyword path', () => {
    const decision = detectHandover({
      context: makeContext({
        handover_keywords: [
          'speak to a human',
          'real person',
          'manager',
          'complaint',
          'urgent',
          'emergency',
          'solicitor',
          'lawyer',
        ],
      }),
      memory: makeMemory(),
      inboundText:
        "I've got a house that needs rewiring, could I talk to someone or get a price for that?",
    });
    assert.equal(decision.shouldHandover, false);
  });
});

describe('detail capture before a handover promise', () => {
  it('asks for details when nothing is known about the caller', () => {
    assert.equal(needsDetailCapture(makeMemory({ customer_name: null })), true);
    assert.equal(needsDetailCapture(makeMemory({ customer_name: '   ' })), true);
  });

  it('does not ask when the name is already known', () => {
    assert.equal(needsDetailCapture(makeMemory({ customer_name: 'Priya Shah' })), false);
  });

  it('promises a callback and asks, rather than saying goodbye', () => {
    const line = renderCaptureMessage(makeContext());
    assert.match(line, /ring you back on this number/i);
    assert.match(line, /your name/i);
  });

  it('names the business rather than the assistant as the caller of the callback', () => {
    const context = makeContext();
    context.profile.trading_name = 'Volta Electrical';
    assert.match(renderCaptureMessage(context), /Volta Electrical/);
  });
});

describe('detectHandover — complaints', () => {
  it('escalates on a legal threat', () => {
    const decision = detectHandover({
      context: makeContext(),
      memory: makeMemory(),
      inboundText: 'I am speaking to my solicitor about this',
    });
    assert.equal(decision.shouldHandover, true);
    assert.equal(decision.reason, 'complaint');
  });

  it('escalates on repeated chasing', () => {
    const decision = detectHandover({
      context: makeContext(),
      memory: makeMemory(),
      inboundText: 'This is the third time I have asked about this',
    });
    assert.equal(decision.shouldHandover, true);
    assert.equal(decision.reason, 'complaint');
  });

  it('does not escalate on complaints when the tenant disabled it', () => {
    const decision = detectHandover({
      context: makeContext({ handover_on_complaint: false }),
      memory: makeMemory(),
      inboundText: 'I want to make a complaint',
    });
    assert.equal(decision.shouldHandover, false);
  });
});

describe('detectHandover — tenant keywords', () => {
  it('matches a configured multi-word keyword', () => {
    const decision = detectHandover({
      context: makeContext(),
      memory: makeMemory(),
      inboundText: 'I have a question about the Section 20 consultation',
    });
    assert.equal(decision.shouldHandover, true);
    assert.equal(decision.reason, 'keyword');
  });

  it('matches whole words only', () => {
    // "ombudsman" is configured; "ombudsmanship" should not fire.
    const decision = detectHandover({
      context: makeContext({ handover_keywords: ['ombudsman'] }),
      memory: makeMemory(),
      inboundText: 'What is your ombudsmanship policy',
    });
    assert.equal(decision.shouldHandover, false);
  });

  it('treats a regex metacharacter in a tenant keyword as a literal', () => {
    // A tenant typing "cost?" must not create a broken regex or match everything.
    assert.doesNotThrow(() =>
      detectHandover({
        context: makeContext({ handover_keywords: ['cost?', '(urgent)', '.*'] }),
        memory: makeMemory(),
        inboundText: 'What does it cost',
      }),
    );
    const decision = detectHandover({
      context: makeContext({ handover_keywords: ['.*'] }),
      memory: makeMemory(),
      inboundText: 'Just a normal question',
    });
    assert.equal(decision.shouldHandover, false, 'a ".*" keyword must not match everything');
  });
});

describe('detectHandover — confusion', () => {
  it('does not escalate on the first sign of confusion', () => {
    const decision = detectHandover({
      context: makeContext(),
      memory: makeMemory({ confusion_count: 0 }),
      inboundText: "That's not what I asked",
    });
    assert.equal(decision.shouldHandover, false);
    assert.equal(shouldIncrementConfusion("That's not what I asked"), true);
  });

  it('escalates once the threshold is reached', () => {
    const decision = detectHandover({
      context: makeContext({ handover_confusion_threshold: 3 }),
      memory: makeMemory({ confusion_count: 2 }),
      inboundText: 'You are not listening to me',
    });
    assert.equal(decision.shouldHandover, true);
    assert.equal(decision.reason, 'repeated_confusion');
  });
});

describe('detectHandover — guards', () => {
  it('does nothing when the thread is already with a human', () => {
    for (const status of ['waiting_for_human', 'human_handling'] as const) {
      const decision = detectHandover({
        context: makeContext(),
        memory: makeMemory({ status }),
        inboundText: 'There is water everywhere, this is an emergency',
      });
      assert.equal(decision.shouldHandover, false, `status ${status} should not re-escalate`);
    }
  });

  it('does nothing when handover is disabled entirely', () => {
    const decision = detectHandover({
      context: makeContext({ handover_enabled: false }),
      memory: makeMemory(),
      inboundText: 'I want to speak to a human',
    });
    assert.equal(decision.shouldHandover, false);
  });

  it('escalates once the AI turn budget is exhausted', () => {
    const decision = detectHandover({
      context: makeContext({ ai_max_turns: 5 }),
      memory: makeMemory({ ai_turn_count: 5 }),
      inboundText: 'And what about the parking?',
    });
    assert.equal(decision.shouldHandover, true);
    assert.equal(decision.reason, 'out_of_scope');
  });

  it('ignores an empty message', () => {
    const decision = detectHandover({
      context: makeContext(),
      memory: makeMemory(),
      inboundText: '   ',
    });
    assert.equal(decision.shouldHandover, false);
  });
});

describe('isMuteFromEarlierCall', () => {
  const handedOver = '2026-09-25T14:12:30.000Z';

  it('a caller ringing back after the handover is answered', () => {
    assert.equal(isMuteFromEarlierCall({ mutedAt: handedOver, thisCallStartedAt: '2026-09-25T14:15:08.000Z' }), true);
  });

  it('the call that raised the handover stays muted for its capture answer', () => {
    assert.equal(isMuteFromEarlierCall({ mutedAt: handedOver, thisCallStartedAt: '2026-09-25T14:12:21.000Z' }), false);
  });

  it('stays muted when either time is unknown (switched off by hand, or no call id)', () => {
    assert.equal(isMuteFromEarlierCall({ mutedAt: null, thisCallStartedAt: '2026-09-25T14:15:08.000Z' }), false);
    assert.equal(isMuteFromEarlierCall({ mutedAt: handedOver, thisCallStartedAt: null }), false);
    assert.equal(isMuteFromEarlierCall({ mutedAt: undefined, thisCallStartedAt: undefined }), false);
  });

  it('compares instants, not strings, so offsets do not fool it', () => {
    // 15:15 BST is 14:15 UTC, after the 14:12 UTC handover.
    assert.equal(isMuteFromEarlierCall({ mutedAt: '2026-09-25 14:12:30+00', thisCallStartedAt: '2026-09-25T15:15:08+01:00' }), true);
  });
});

describe('prompt for a caller ringing back after a handover', () => {
  const prompt = (memory: Partial<ConversationMemory>) =>
    buildReceptionistSystemPrompt({
      context: makeContext(),
      memory: makeMemory({ channel: 'voice', status: 'waiting_for_human', ai_enabled: false, ...memory }),
      now: new Date('2026-09-25T14:15:00Z'),
    });

  it('tells the assistant a colleague already owes a callback, and why', () => {
    const text = prompt({ callback_pending: true, handover_reason: 'emergency' });
    assert.match(text, /A colleague already owes this person a callback/);
    assert.match(text, /a possible emergency/);
    assert.match(text, /999/);
  });

  it('says nothing about it on an ordinary conversation', () => {
    assert.doesNotMatch(prompt({ status: 'active', ai_enabled: true }), /owes this person a callback/);
  });
});
