import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { callSidTail, registerElevenLabsCall } from './elevenlabs-register.ts';

const TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://x"/></Connect></Response>';

function stub(body: string, init: ResponseInit = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, i: RequestInit) => {
    calls.push({ url, init: i });
    return new Response(body, { status: 200, ...init });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('registerElevenLabsCall', () => {
  it('reports an absent key without calling out', async () => {
    const s = stub(TWIML);
    for (const apiKey of [undefined, '', '  ']) {
      const r = await registerElevenLabsCall({ apiKey, from: '+441', to: '+442', fetchImpl: s.fetchImpl });
      assert.deepEqual(r, { ok: false, reason: 'key_absent' });
    }
    assert.equal(s.calls.length, 0);
  });

  it('posts the agent, numbers and inbound direction, and returns raw TwiML unchanged', async () => {
    const s = stub(TWIML, { headers: { 'content-type': 'application/xml' } });
    const r = await registerElevenLabsCall({ apiKey: 'k', from: '+441', to: '+442', fetchImpl: s.fetchImpl });
    assert.deepEqual(r, { ok: true, twiml: TWIML });
    assert.equal(s.calls[0]!.url, 'https://api.elevenlabs.io/v1/convai/twilio/register-call');
    assert.deepEqual(JSON.parse(s.calls[0]!.init.body as string), {
      agent_id: 'agent_7701m512068ke0tvnm2xg17kbarw',
      from_number: '+441',
      to_number: '+442',
      direction: 'inbound',
    });
  });

  it('unwraps TwiML delivered as a JSON string', async () => {
    const s = stub(JSON.stringify(TWIML), { headers: { 'content-type': 'application/json' } });
    const r = await registerElevenLabsCall({ apiKey: 'k', from: 'a', to: 'b', fetchImpl: s.fetchImpl });
    assert.deepEqual(r, { ok: true, twiml: TWIML });
  });

  it('maps an upstream error, a network failure and an empty body to failures', async () => {
    const bad = stub('no', { status: 401 });
    assert.deepEqual(
      await registerElevenLabsCall({ apiKey: 'k', from: 'a', to: 'b', fetchImpl: bad.fetchImpl }),
      { ok: false, reason: 'upstream_error', status: 401 },
    );
    const boom = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    assert.deepEqual(
      await registerElevenLabsCall({ apiKey: 'k', from: 'a', to: 'b', fetchImpl: boom }),
      { ok: false, reason: 'upstream_error' },
    );
    const empty = stub('  ');
    assert.deepEqual(
      await registerElevenLabsCall({ apiKey: 'k', from: 'a', to: 'b', fetchImpl: empty.fetchImpl }),
      { ok: false, reason: 'empty_response' },
    );
  });
});

describe('callSidTail', () => {
  it('keeps only the last four characters', () => {
    assert.equal(callSidTail('CA1234567890abcdef'), 'cdef');
  });
});
