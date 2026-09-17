import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { describe, it } from 'node:test';

import { candidateUrls, checkSignature, requestHost } from './signature.ts';

/** The smallest thing that quacks like an upgrade request. */
function fakeRequest(headers: Record<string, string>, url = '/relay'): IncomingMessage {
  return { headers, url } as unknown as IncomingMessage;
}

describe('requestHost', () => {
  it('prefers the forwarded host over the origin host', () => {
    // Behind the tunnel the origin host is the tunnel's local target, so the forwarded
    // header is the only one that names the hostname Twilio actually dialled.
    const request = fakeRequest({ host: 'localhost:3002', 'x-forwarded-host': 'receptionist.aaa123.uk' });
    assert.equal(requestHost(request), 'receptionist.aaa123.uk');
  });

  it('takes the first entry of a forwarded list and drops the default TLS port', () => {
    const request = fakeRequest({ 'x-forwarded-host': 'receptionist.aaa123.uk:443, internal:3002' });
    assert.equal(requestHost(request), 'receptionist.aaa123.uk');
  });

  it('keeps a non-default port, because Twilio signs it as part of the URL', () => {
    // Dropping it here would build a URL that never matches, and the resulting 401 looks
    // exactly like a wrong auth token.
    assert.equal(requestHost(fakeRequest({ host: 'localhost:3999' })), 'localhost:3999');
    assert.equal(requestHost(fakeRequest({ host: 'example.test:8443' })), 'example.test:8443');
  });

  it('handles an IPv6 literal without mistaking its colons for a port', () => {
    assert.equal(requestHost(fakeRequest({ host: '[::1]:8443' })), '[::1]:8443');
    assert.equal(requestHost(fakeRequest({ host: '[::1]:443' })), '[::1]');
  });

  it('returns null when there is no host at all', () => {
    assert.equal(requestHost(fakeRequest({})), null);
  });
});

describe('candidateUrls', () => {
  it('offers the wss form first, then https, for the same authority', () => {
    const urls = candidateUrls(fakeRequest({ host: 'receptionist.aaa123.uk' }));
    assert.deepEqual(urls, ['wss://receptionist.aaa123.uk/relay', 'https://receptionist.aaa123.uk/relay']);
  });

  it('drops any query string, because our socket URL has none', () => {
    const urls = candidateUrls(fakeRequest({ host: 'example.test' }, '/relay?ignored=1'));
    assert.deepEqual(urls, ['wss://example.test/relay', 'https://example.test/relay']);
  });

  it('uses an explicit override when one is set', () => {
    const urls = candidateUrls(fakeRequest({ host: 'wrong.test' }), 'https://right.test');
    assert.deepEqual(urls, ['wss://right.test/relay', 'https://right.test/relay']);
  });

  it('offers nothing when the host is unknown', () => {
    assert.deepEqual(candidateUrls(fakeRequest({})), []);
  });
});

describe('checkSignature', () => {
  const request = fakeRequest({ host: 'receptionist.aaa123.uk' });

  it('rejects when no signature header was presented', () => {
    const result = checkSignature({ signature: undefined, request, verify: () => true });
    assert.equal(result.valid, false);
    assert.equal(result.matchedUrl, null);
  });

  it('accepts when the wss form validates, and reports which form matched', () => {
    const result = checkSignature({
      signature: 'abc',
      request,
      verify: ({ url }) => url.startsWith('wss://'),
    });
    assert.equal(result.valid, true);
    assert.equal(result.matchedUrl, 'wss://receptionist.aaa123.uk/relay');
  });

  it('accepts when the https form validates', () => {
    // Twilio does not document which scheme it signs for a WebSocket handshake. Both forms
    // are the same authority and path, so accepting either accepts nothing extra.
    const result = checkSignature({
      signature: 'abc',
      request,
      verify: ({ url }) => url.startsWith('https://'),
    });
    assert.equal(result.valid, true);
    assert.equal(result.matchedUrl, 'https://receptionist.aaa123.uk/relay');
  });

  it('rejects when neither form validates', () => {
    const result = checkSignature({ signature: 'abc', request, verify: () => false });
    assert.equal(result.valid, false);
    assert.equal(result.candidates.length, 2);
  });

  it('always passes empty params, because the socket URL carries none', () => {
    const seen: Record<string, string>[] = [];
    checkSignature({
      signature: 'abc',
      request,
      verify: (input) => {
        seen.push(input.params);
        return false;
      },
    });
    assert.deepEqual(seen, [{}, {}]);
  });

  it('offers no candidates when the request has no host', () => {
    const result = checkSignature({ signature: 'abc', request: fakeRequest({}), verify: () => true });
    assert.equal(result.valid, false);
    assert.deepEqual(result.candidates, []);
  });
});
