import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { createErrandCall } from './twilio-call.ts';

const DUBLIN = 'https://api.dublin.ie1.twilio.com/2010-04-01';
const ENV = { TWILIO_API_BASE_URL: DUBLIN, TWILIO_ACCOUNT_SID: 'ACtest0000000000000000000000000001', TWILIO_AUTH_TOKEN: 'test-token' };
const ID = '2026-10-27-1412-luigi-s-table';

/** A fake fetch that counts requests and keeps what was sent. Never reaches a network. */
function fakeFetch(respond: (signal: AbortSignal) => Promise<Response>) {
  const requests: Array<{ url: string; body: URLSearchParams; headers: Record<string, string> }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: init?.body as URLSearchParams, headers: init?.headers as Record<string, string> });
    return respond(init!.signal!);
  }) as typeof fetch;
  return { fn, requests };
}

const created = () => Promise.resolve(new Response(JSON.stringify({ sid: 'CA0123456789abcdef0123456789abcdef', status: 'queued' }), { status: 201 }));

describe('createErrandCall', () => {
  it('posts every parameter with the locked values to the configured base', async () => {
    const fake = fakeFetch(created);
    const result = await createErrandCall({ errandId: ID, to: '+442079460123' }, { fetch: fake.fn, env: ENV });
    assert.deepEqual(result, { ok: true, callSid: 'CA0123456789abcdef0123456789abcdef' });
    assert.equal(fake.requests.length, 1);
    const { url, body, headers } = fake.requests[0]!;
    assert.equal(url, `${DUBLIN}/Accounts/ACtest0000000000000000000000000001/Calls.json`);
    assert.equal(new URL(url).host, 'api.dublin.ie1.twilio.com');
    assert.deepEqual(Object.fromEntries(body), {
      From: '+447861926390',
      To: '+442079460123',
      Url: `https://receptionist.atwoodsystems.co.uk/errand/twiml?errand=${ID}`,
      Method: 'POST',
      StatusCallback: `https://receptionist.atwoodsystems.co.uk/errand/status?errand=${ID}`,
      StatusCallbackEvent: 'initiated ringing answered completed',
      StatusCallbackMethod: 'POST',
      MachineDetection: 'DetectMessageEnd',
      Timeout: '30',
      TimeLimit: '480',
    });
    assert.equal(body.has('Record'), false);
    assert.equal(body.has('AsyncAmd'), false);
    assert.equal(body.has('Twiml'), false);
    assert.match(headers.authorization!, /^Basic /);
  });

  it('throws before any request when the base is absent or the global host', async () => {
    const fake = fakeFetch(created);
    await assert.rejects(createErrandCall({ errandId: ID, to: '+442079460123' }, { fetch: fake.fn, env: { ...ENV, TWILIO_API_BASE_URL: '' } }), /not set/);
    await assert.rejects(
      createErrandCall({ errandId: ID, to: '+442079460123' }, { fetch: fake.fn, env: { ...ENV, TWILIO_API_BASE_URL: 'https://api.twilio.com/2010-04-01' } }),
      /regional edge/,
    );
    await assert.rejects(createErrandCall({ errandId: ID, to: '+442079460123' }, { fetch: fake.fn, env: { TWILIO_API_BASE_URL: DUBLIN } }), /must be set/);
    await assert.rejects(createErrandCall({ errandId: '../x', to: '+442079460123' }, { fetch: fake.fn, env: ENV }), /not a valid errand id/);
    assert.equal(fake.requests.length, 0);
  });

  it('aborts a slow create at 15 seconds and does not retry', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const fake = fakeFetch(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      );
      const pending = createErrandCall({ errandId: ID, to: '+442079460123' }, { fetch: fake.fn, env: ENV });
      await Promise.resolve();
      mock.timers.tick(14_999);
      await Promise.resolve();
      assert.equal(fake.requests.length, 1);
      mock.timers.tick(1);
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.failure, 'timeout');
      assert.equal(fake.requests.length, 1);
    } finally {
      mock.timers.reset();
    }
  });

  it('returns a rejection with Twilio\'s code, and other failures as other', async () => {
    const rejected = fakeFetch(() => Promise.resolve(new Response(JSON.stringify({ code: 21215, message: 'Geo permission' }), { status: 400 })));
    assert.deepEqual(await createErrandCall({ errandId: ID, to: '+442079460123' }, { fetch: rejected.fn, env: ENV }), {
      ok: false,
      failure: 'rejected',
      status: 400,
      twilioCode: 21215,
      message: 'Geo permission',
    });
    const broken = fakeFetch(() => Promise.reject(new Error('ECONNRESET')));
    assert.deepEqual(await createErrandCall({ errandId: ID, to: '+442079460123' }, { fetch: broken.fn, env: ENV }), {
      ok: false,
      failure: 'other',
      message: 'ECONNRESET',
    });
    assert.equal(rejected.requests.length + broken.requests.length, 2);
  });
});
