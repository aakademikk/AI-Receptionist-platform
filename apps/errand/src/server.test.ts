import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';

import WebSocket from 'ws';

import { createErrandServer } from './server.ts';
import { newErrand } from './store.ts';
import { PUBLIC, TEST_TOKEN, listen, postForm, sampleBrief, tempDir, twilioSign } from './testing/fixtures.ts';

let home: string;
let cleanup: () => void;
let server: Server;
let port: number;
let id: string;
const logs: string[] = [];
const twimlCalls: string[] = [];
const statusCalls: string[] = [];
let sockets = 0;

beforeEach(async () => {
  ({ dir: home, cleanup } = tempDir());
  id = newErrand(sampleBrief(), new Date('2026-10-27T14:12:00Z'), home).id;
  logs.length = 0;
  twimlCalls.length = 0;
  statusCalls.length = 0;
  sockets = 0;
  ({ server } = createErrandServer({
    tokens: () => [TEST_TOKEN],
    home,
    log: (message) => void logs.push(message),
    twiml: (errandId) => {
      twimlCalls.push(errandId);
      return '<Response><Hangup/></Response>';
    },
    status: (errandId) => void statusCalls.push(errandId),
    connection: (ws) => {
      sockets += 1;
      ws.close(1000);
    },
  }));
  port = await listen(server);
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  cleanup();
});

/** Try a socket upgrade; resolves to the HTTP status of a refusal, or 101 on success. */
function upgrade(signature: string | null): Promise<number> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = signature === null ? {} : { 'x-twilio-signature': signature };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/errand/ws`, { headers });
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
    ws.on('error', () => undefined);
  });
}

describe('errand server: Twilio routes fail closed (Done-means 17)', () => {
  for (const path of ['/errand/twiml', '/errand/status']) {
    it(`${path}: unsigned and wrongly signed are 403 with no detail; signed passes`, async () => {
      const pq = `${path}?errand=${id}`;
      const params = { CallSid: 'CA0123456789abcdef0123456789abcdef', CallStatus: 'in-progress' };
      const unsigned = await postForm(port, pq, params, { signature: null });
      assert.deepEqual(unsigned, { status: 403, body: '' });
      const wrong = await postForm(port, pq, params, { signature: twilioSign('wrong-token', `${PUBLIC}${pq}`, params) });
      assert.deepEqual(wrong, { status: 403, body: '' });
      const tampered = await postForm(port, pq, params, { signature: twilioSign(TEST_TOKEN, `${PUBLIC}${pq}`, { ...params, CallStatus: 'x' }) });
      assert.equal(tampered.status, 403);
      assert.equal(twimlCalls.length + statusCalls.length, 0);
      const signed = await postForm(port, pq, params);
      assert.equal(signed.status, 200);
      assert.equal(twimlCalls.length + statusCalls.length, 1);
      assert.equal(logs.filter((line) => line === 'Errand webhook rejected').length, 3);
    });
  }

  it('refuses everything when no auth token is configured', async () => {
    const { server: bare } = createErrandServer({ tokens: () => [], home, log: () => undefined });
    const barePort = await listen(bare);
    try {
      const result = await postForm(barePort, `/errand/twiml?errand=${id}`, { CallSid: 'CA1' });
      assert.equal(result.status, 403);
    } finally {
      await new Promise((resolve) => bare.close(resolve));
    }
  });

  it('the socket upgrade: unsigned and wrongly signed are refused with 403; signed opens', async () => {
    assert.equal(await upgrade(null), 403);
    assert.equal(await upgrade(twilioSign('wrong-token', `wss://receptionist.atwoodsystems.co.uk/errand/ws`)), 403);
    assert.equal(sockets, 0);
    assert.equal(await upgrade(twilioSign(TEST_TOKEN, `wss://receptionist.atwoodsystems.co.uk/errand/ws`)), 101);
  });
});

describe('errand server: ids and other paths', () => {
  it('answers a hang-up TwiML for a bad or unknown errand id, without calling the handler', async () => {
    for (const query of ['?errand=../../jobs', '?errand=2026-10-27-1412-nobody', '']) {
      const result = await postForm(port, `/errand/twiml${query}`, { CallSid: 'CA1' });
      assert.equal(result.status, 200);
      assert.match(result.body, /<Hangup\/>/);
    }
    assert.equal(twimlCalls.length, 0);
  });

  it('acknowledges a signed status for an unknown errand without calling the handler', async () => {
    const result = await postForm(port, '/errand/status?errand=2026-10-27-1412-nobody', { CallSid: 'CA1', CallStatus: 'completed' });
    assert.equal(result.status, 200);
    assert.equal(statusCalls.length, 0);
  });

  it('404s other paths and methods', async () => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/relay`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/errand/twiml`)).status, 404);
  });
});

describe('errand server: health', () => {
  it('answers 200 to a local request with no CF-Connecting-IP header', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/errand/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });

  it('answers 404 to a request that came through the tunnel', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/errand/health`, { headers: { 'cf-connecting-ip': '203.0.113.7' } });
    assert.equal(response.status, 404);
  });
});
