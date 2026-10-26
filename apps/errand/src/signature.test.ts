import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { publicUrlFor, socketCandidates, verifySocket, verifyWebhook } from './signature.ts';
import { twilioSign } from './testing/fixtures.ts';

const TOKEN = 'test-token-0123456789abcdef012345';
const URL_TWIML = 'https://receptionist.atwoodsystems.co.uk/errand/twiml?errand=2026-10-27-1412-luigi-s-table';

describe('verifyWebhook', () => {
  const params = { CallSid: 'CA0123', AnsweredBy: 'human' };

  it('rebuilds the public URL from the fixed origin with the query string', () => {
    assert.equal(publicUrlFor('/errand/twiml?errand=2026-10-27-1412-luigi-s-table'), URL_TWIML);
  });

  it('accepts a correct signature over the public URL and body', () => {
    const signature = twilioSign(TOKEN, URL_TWIML, params);
    assert.equal(verifyWebhook({ signature, requestUrl: '/errand/twiml?errand=2026-10-27-1412-luigi-s-table', params, tokens: [TOKEN] }), true);
  });

  it('accepts the secondary token during a rotation', () => {
    const signature = twilioSign('second-token', URL_TWIML, params);
    assert.equal(verifyWebhook({ signature, requestUrl: '/errand/twiml?errand=2026-10-27-1412-luigi-s-table', params, tokens: [TOKEN, 'second-token'] }), true);
  });

  it('fails closed: no signature, no token, wrong token, tampered body, other query', () => {
    const signature = twilioSign(TOKEN, URL_TWIML, params);
    const requestUrl = '/errand/twiml?errand=2026-10-27-1412-luigi-s-table';
    assert.equal(verifyWebhook({ signature: undefined, requestUrl, params, tokens: [TOKEN] }), false);
    assert.equal(verifyWebhook({ signature, requestUrl, params, tokens: [] }), false);
    assert.equal(verifyWebhook({ signature: twilioSign('wrong', URL_TWIML, params), requestUrl, params, tokens: [TOKEN] }), false);
    assert.equal(verifyWebhook({ signature, requestUrl, params: { ...params, AnsweredBy: 'machine_end_beep' }, tokens: [TOKEN] }), false);
    assert.equal(verifyWebhook({ signature, requestUrl: '/errand/twiml?errand=2026-10-27-1412-other', params, tokens: [TOKEN] }), false);
  });
});

describe('verifySocket', () => {
  const request = { url: '/errand/ws' };

  it('offers the wss form first and the https form second', () => {
    assert.deepEqual(socketCandidates(request), ['wss://receptionist.atwoodsystems.co.uk/errand/ws', 'https://receptionist.atwoodsystems.co.uk/errand/ws']);
  });

  it('accepts either form and says which matched', () => {
    const wss = verifySocket({ signature: twilioSign(TOKEN, 'wss://receptionist.atwoodsystems.co.uk/errand/ws'), request, tokens: [TOKEN] });
    assert.deepEqual([wss.valid, wss.matchedForm], [true, 'wss']);
    const https = verifySocket({ signature: twilioSign(TOKEN, 'https://receptionist.atwoodsystems.co.uk/errand/ws'), request, tokens: [TOKEN] });
    assert.deepEqual([https.valid, https.matchedForm], [true, 'https']);
  });

  it('fails closed on no signature, no token or a wrong one', () => {
    const signature = twilioSign(TOKEN, 'wss://receptionist.atwoodsystems.co.uk/errand/ws');
    assert.equal(verifySocket({ signature: null, request, tokens: [TOKEN] }).valid, false);
    assert.equal(verifySocket({ signature, request, tokens: [] }).valid, false);
    assert.equal(verifySocket({ signature: twilioSign('wrong', 'wss://receptionist.atwoodsystems.co.uk/errand/ws'), request, tokens: [TOKEN] }).valid, false);
    assert.equal(verifySocket({ signature, request: { url: '/relay' }, tokens: [TOKEN] }).valid, false);
  });
});
