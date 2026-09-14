import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifySelfMessage, isSamePhoneNumber, WATCHDOG_PROBE_MARKER } from './self-message.ts';

const OWN = '+447462187713';

describe('isSamePhoneNumber', () => {
  it('matches on digits alone', () => {
    assert.equal(isSamePhoneNumber('+447462187713', '+447462187713'), true);
    assert.equal(isSamePhoneNumber('+44 7462 187713', '+447462187713'), true);
  });

  it('ignores the channel prefix Twilio adds for WhatsApp', () => {
    // WhatsApp delivers both sides prefixed; comparing the raw strings would
    // miss the self-addressed case entirely, which is the one that loops.
    assert.equal(isSamePhoneNumber('whatsapp:+447462187713', '+447462187713'), true);
    assert.equal(isSamePhoneNumber('whatsapp:+447462187713', 'whatsapp:+447462187713'), true);
  });

  it('does not match different numbers', () => {
    assert.equal(isSamePhoneNumber('+447462187713', '+447700900123'), false);
  });

  it('never matches when either side is missing or empty', () => {
    // A false positive here drops a real customer's message, so an absent number
    // must never be treated as "the same line".
    assert.equal(isSamePhoneNumber(null, null), false);
    assert.equal(isSamePhoneNumber(undefined, undefined), false);
    assert.equal(isSamePhoneNumber('', ''), false);
    assert.equal(isSamePhoneNumber('+447462187713', null), false);
    assert.equal(isSamePhoneNumber('whatsapp:', 'whatsapp:'), false);
  });
});

describe('classifySelfMessage', () => {
  it('leaves an ordinary customer message alone', () => {
    assert.equal(classifySelfMessage(OWN, '+447700900123', 'What do you do?'), 'normal');
  });

  it('drops a self-addressed message that is not a probe', () => {
    // This is the loop: the AI's reply arriving back as an inbound message.
    assert.equal(classifySelfMessage(OWN, OWN, "I'm here to help with property."), 'loop');
  });

  it('lets a marked probe through', () => {
    assert.equal(
      classifySelfMessage(OWN, OWN, `${WATCHDOG_PROBE_MARKER} reachability check`),
      'probe',
    );
  });

  it('breaks the loop at the first hop', () => {
    // The whole safety argument, as a test: the probe is processed, and the reply
    // the model generates does not carry the marker, so it is dropped on return.
    const probe = classifySelfMessage(OWN, OWN, `${WATCHDOG_PROBE_MARKER} ping`);
    assert.equal(probe, 'probe');

    const replyComesBack = classifySelfMessage(OWN, OWN, "We manage residential blocks.");
    assert.equal(replyComesBack, 'loop');
  });

  it('treats an unmarked self-message as the loop even when it mentions the word probe', () => {
    assert.equal(classifySelfMessage(OWN, OWN, 'this is a probe, ignore'), 'loop');
  });
});
