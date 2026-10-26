import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EXTRAS_LINE,
  PERSONAL_DETAILS_LINE,
  callbackNumber,
  checkAgreedTime,
  checkAmyLine,
  checkTheirWords,
} from './guardrails.ts';
import { COLIN_MOBILE, sampleBrief } from './testing/fixtures.ts';

const brief = sampleBrief();

describe('checkTheirWords (Done-means 8)', () => {
  it('spots each payment ask', () => {
    const table: Array<[string, string]> = [
      ['Can I take a card number to hold the table?', 'card'],
      ['We need a deposit for parties on a Saturday.', 'deposit'],
      ["What's the long number on the card?", 'card'],
      ['Bank details please.', 'bank details'],
      ["And the expiry date?", 'expiry'],
      ['The three digits on the back, please', 'security code'],
      ['What is the CVV?', 'security code'],
      ['We ask for pre-payment on bookings over six', 'pre-payment'],
      ['Can you pay now over the phone?', 'pay now'],
      ['Your sort code and account number?', 'bank details'],
      ['Can I take the credit or debit card?', 'card'],
      ['Go on then, 4929 1234 5678 9012', 'long number'],
      ['four nine two nine one two three four five six seven eight', 'long number'],
    ];
    for (const [text, kind] of table) assert.deepEqual(checkTheirWords(text), { kind: 'payment', matched: kind }, text);
  });

  it('lets ordinary booking talk through', () => {
    for (const text of [
      "Hello, Luigi's, how can I help?",
      'What time were you thinking? We have half seven or eight.',
      'A table for two on Wednesday, lovely. What name is it under?',
      'And a contact number in case we need to reach you?',
      'Can you spell that for me?',
      "We're fully booked at seven, sorry.",
      'Is that 19:30 then? Yes, two people.',
    ]) {
      assert.deepEqual(checkTheirWords(text), { kind: 'ok' }, text);
    }
  });
});

describe('checkAmyLine', () => {
  it('lets a line with Colin\'s mobile through, in either form', () => {
    assert.deepEqual(checkAmyLine(`You can reach Colin on ${COLIN_MOBILE}.`, brief), { ok: true });
    assert.deepEqual(checkAmyLine('His mobile is 07700 900123.', brief), { ok: true });
  });

  it('blocks a line holding the robot number, in any form', () => {
    for (const line of ['Call back on +447861926390.', 'The number is 07861 926390.', 'It is 0786 192 6390']) {
      assert.deepEqual(checkAmyLine(line, brief), { ok: false, kind: 'personal', replacement: PERSONAL_DETAILS_LINE }, line);
    }
  });

  it('blocks any other phone number, an email, an address, a date of birth, a card or bank detail', () => {
    for (const line of [
      'Try 020 7946 0999 instead.',
      "It's colin@example.com.",
      'That is colin at gmail dot com',
      'He lives at 12 Acacia Avenue.',
      'The postcode is SW1A 1AA.',
      'His date of birth is the first of May.',
      'The sort code is on its way.',
    ]) {
      assert.deepEqual(checkAmyLine(line, brief), { ok: false, kind: 'personal', replacement: PERSONAL_DETAILS_LINE }, line);
    }
  });

  it('blocks agreeing to anything beyond the goal', () => {
    for (const line of [
      "Yes, that's fine, we'll take the deposit option.",
      'Sure, sign him up for the newsletter.',
      'Okay, add the wine pairing extra.',
      'Yes, please do change his other booking too.',
      'Happy to join the membership.',
    ]) {
      assert.deepEqual(checkAmyLine(line, brief), { ok: false, kind: 'extras', replacement: EXTRAS_LINE }, line);
    }
  });

  it('lets ordinary lines through', () => {
    for (const line of [
      'Hi, this is Amy, an automated assistant calling on behalf of Colin Wood.',
      "I'd like to book a table for two on Wednesday the 28th, between seven and half eight.",
      'Half seven would be perfect, thank you.',
      'The booking is under Colin Wood.',
      'No thank you, just the table.',
    ]) {
      assert.deepEqual(checkAmyLine(line, brief), { ok: true }, line);
    }
  });
});

describe('checkAgreedTime', () => {
  const window = brief.window; // 2026-10-28, 19:00 to 20:30

  it('accepts the edges and times inside', () => {
    for (const time of ['19:00', '19:30', '20:30', '2026-10-28 19:45', '2026-10-28T20:00']) {
      assert.equal(checkAgreedTime(time, window).ok, true, time);
    }
  });

  it('refuses a time one minute outside, and records it as offered', () => {
    const offered: string[] = [];
    assert.deepEqual(checkAgreedTime('18:59', window, offered), { ok: false, offered: '18:59' });
    assert.deepEqual(checkAgreedTime('20:31', window, offered), { ok: false, offered: '20:31' });
    assert.deepEqual(checkAgreedTime('20:31', window, offered), { ok: false, offered: '20:31' });
    assert.deepEqual(offered, ['18:59', '20:31']);
  });

  it('refuses another date and a malformed time', () => {
    assert.equal(checkAgreedTime('2026-10-29 19:30', window).ok, false);
    assert.equal(checkAgreedTime('half seven', window).ok, false);
  });
});

describe('callbackNumber', () => {
  it("is Colin's mobile from the brief", () => {
    assert.equal(callbackNumber(brief), COLIN_MOBILE);
  });
});
