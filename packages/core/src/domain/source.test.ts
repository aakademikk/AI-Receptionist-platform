import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sourceForChannel } from './source.ts';

describe('sourceForChannel', () => {
  it('tags a voice conversation as a voice call', () => {
    assert.equal(sourceForChannel('voice'), 'voice_call');
  });

  it('keeps SMS as inbound_sms', () => {
    assert.equal(sourceForChannel('sms'), 'inbound_sms');
  });

  it('keeps WhatsApp as whatsapp', () => {
    assert.equal(sourceForChannel('whatsapp'), 'whatsapp');
  });
});
