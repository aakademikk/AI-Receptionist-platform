import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cleanModelReply, measureSms, trimToSegments } from './sms.ts';

describe('measureSms', () => {
  it('counts a short GSM-7 message as one segment', () => {
    const metrics = measureSms('Hi, thanks for contacting us. How can we help?');
    assert.equal(metrics.encoding, 'GSM-7');
    assert.equal(metrics.segments, 1);
  });

  it('uses 153 characters per segment once concatenated', () => {
    // 161 characters cannot fit a single 160-septet segment, so it becomes two.
    assert.equal(measureSms('a'.repeat(161)).segments, 2);
    assert.equal(measureSms('a'.repeat(160)).segments, 1);
    assert.equal(measureSms('a'.repeat(306)).segments, 2);
    assert.equal(measureSms('a'.repeat(307)).segments, 3);
  });

  it('charges two septets for GSM extended characters', () => {
    // A '{' costs two septets, so 80 of them exceed a 160-septet segment.
    assert.equal(measureSms('{'.repeat(80)).characters, 160);
    assert.equal(measureSms('{'.repeat(81)).segments, 2);
  });

  it('switches to UCS-2 when a character is outside GSM-7', () => {
    const metrics = measureSms('Thanks! 👍');
    assert.equal(metrics.encoding, 'UCS-2');
    assert.equal(metrics.segments, 1);
  });

  it('counts astral-plane characters as two UCS-2 units', () => {
    // An emoji is a surrogate pair, so 36 of them exceed the 70-unit single segment.
    assert.equal(measureSms('👍'.repeat(35)).segments, 1);
    assert.equal(measureSms('👍'.repeat(36)).segments, 2);
  });
});

describe('trimToSegments', () => {
  it('leaves a short message untouched', () => {
    const body = 'Happy to help. What postcode is the property in?';
    const result = trimToSegments(body, 3);
    assert.equal(result.wasTrimmed, false);
    assert.equal(result.body, body);
  });

  it('trims an over-long message and reports it', () => {
    const body = `${'This is a long sentence about property management. '.repeat(20)}`;
    const result = trimToSegments(body, 2);
    assert.equal(result.wasTrimmed, true);
    assert.ok(result.metrics.segments <= 2, `expected <=2 segments, got ${result.metrics.segments}`);
  });

  it('prefers to cut at a sentence boundary', () => {
    const body = `${'Short sentence here. '.repeat(30)}`;
    const result = trimToSegments(body, 1);
    assert.ok(result.body.endsWith('.'), `expected a sentence end, got "${result.body.slice(-20)}"`);
  });
});

describe('cleanModelReply', () => {
  it('strips wrapping quotes', () => {
    assert.equal(cleanModelReply('"Happy to help."'), 'Happy to help.');
    assert.equal(cleanModelReply('“Happy to help.”'), 'Happy to help.');
  });

  it('strips a leading label the model added', () => {
    assert.equal(cleanModelReply('Reply: Happy to help.'), 'Happy to help.');
    assert.equal(cleanModelReply("Here's the message: Happy to help."), 'Happy to help.');
  });

  it('strips leaked scaffolding tags', () => {
    // This is the failure mode that sends internal reasoning to a customer.
    assert.equal(
      cleanModelReply('<thinking>they want a valuation</thinking>Happy to help.'),
      'they want a valuationHappy to help.',
    );
  });

  it('leaves a normal reply alone', () => {
    const body = 'Happy to help with a valuation. Could I take your postcode?';
    assert.equal(cleanModelReply(body), body);
  });

  it('does not strip a quote that is only at one end', () => {
    assert.equal(cleanModelReply('He said "no" to that'), 'He said "no" to that');
  });
});
