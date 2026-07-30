import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectHandover, shouldIncrementConfusion } from './handover.ts';
import type { BusinessContext, ConversationMemory } from '../types/domain.ts';

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
      ai_assistant_name: 'Robin',
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
    'I want to talk to someone',
    'Is this a bot?',
    'Put me through to a manager',
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
