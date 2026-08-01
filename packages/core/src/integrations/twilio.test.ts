import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reconstructTwilioUrl } from './twilio.ts';

/**
 * Every case here is a real deployment shape. The signature covers this URL exactly,
 * so a single character wrong rejects every inbound webhook — and the symptom looks
 * like a bad auth token rather than a URL problem.
 */
describe('reconstructTwilioUrl', () => {
  const LOCAL = 'http://localhost:3000/api/webhooks/twilio/sms';

  it('drops the local port when the override has none', () => {
    // The regression this exists for. Assigning to `url.host` keeps the existing port
    // when the new value omits one, producing tunnel.example.com:3000 against a
    // signature computed over a URL with no port.
    const result = reconstructTwilioUrl({
      requestUrl: LOCAL,
      baseUrlOverride: 'https://delicious-honors.trycloudflare.com',
    });

    assert.equal(result, 'https://delicious-honors.trycloudflare.com/api/webhooks/twilio/sms');
    assert.doesNotMatch(result, /:3000/, 'the origin port must not survive');
  });

  it('keeps a port the override genuinely specifies', () => {
    const result = reconstructTwilioUrl({
      requestUrl: LOCAL,
      baseUrlOverride: 'https://internal.example.com:8443',
    });
    assert.equal(result, 'https://internal.example.com:8443/api/webhooks/twilio/sms');
  });

  it('drops the local port when a forwarded host has none', () => {
    // Same trap on the header path, which is what Vercel and most proxies use.
    const result = reconstructTwilioUrl({
      requestUrl: LOCAL,
      forwardedProto: 'https',
      forwardedHost: 'app.atwood.systems',
    });
    assert.equal(result, 'https://app.atwood.systems/api/webhooks/twilio/sms');
  });

  it('takes the first entry when a proxy chain appends several', () => {
    // `x-forwarded-*` accumulates left to right; the client-supplied value is first.
    const result = reconstructTwilioUrl({
      requestUrl: LOCAL,
      forwardedProto: 'https, http',
      forwardedHost: 'app.atwood.systems, internal-lb',
    });
    assert.equal(result, 'https://app.atwood.systems/api/webhooks/twilio/sms');
  });

  it('falls back to the Host header when there is no forwarded host', () => {
    const result = reconstructTwilioUrl({
      requestUrl: LOCAL,
      forwardedProto: 'https',
      host: 'app.atwood.systems',
    });
    assert.equal(result, 'https://app.atwood.systems/api/webhooks/twilio/sms');
  });

  it('preserves the query string', () => {
    // Twilio signs the URL as configured, query included.
    const result = reconstructTwilioUrl({
      requestUrl: 'http://localhost:3000/api/webhooks/twilio/sms?tenant=parkfords',
      baseUrlOverride: 'https://tunnel.example.com',
    });
    assert.equal(result, 'https://tunnel.example.com/api/webhooks/twilio/sms?tenant=parkfords');
  });

  it('leaves the URL alone when nothing overrides it', () => {
    assert.equal(reconstructTwilioUrl({ requestUrl: LOCAL }), LOCAL);
  });

  it('ignores an unparseable override rather than throwing', () => {
    // A bad env value must not take every webhook down with it.
    const result = reconstructTwilioUrl({
      requestUrl: LOCAL,
      forwardedProto: 'https',
      forwardedHost: 'app.atwood.systems',
      baseUrlOverride: 'not a url',
    });
    assert.equal(result, 'https://app.atwood.systems/api/webhooks/twilio/sms');
  });

  it('ignores an empty forwarded header rather than producing a broken origin', () => {
    assert.equal(reconstructTwilioUrl({ requestUrl: LOCAL, forwardedHost: '  ' }), LOCAL);
  });
});
