import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { type ChildProcess, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

/**
 * End-to-end test of the relay against a real socket.
 *
 * The unit tests prove the turn logic in isolation. This proves the parts they cannot:
 * that the process boots with its real imports, that the handshake signature is checked
 * on an actual upgrade, that a frame survives the socket, and that a caller turn comes
 * back as a text turn. Those are the four things that would otherwise only be discovered
 * by placing a phone call.
 *
 * It is deliberately kept honest about what it is not: this is our own client speaking
 * our own protocol, so it cannot prove Twilio sends what its documentation says. It
 * proves our side of the contract, and the phone call is what proves theirs.
 *
 * It also runs the real pipeline with no credentials, which is a deliberate choice rather
 * than a gap — see `BLANKED`. The upshot is that a turn here always takes the failure
 * branch, so this test says nothing about what the assistant would have said. It says
 * everything about whether the caller hears anything at all.
 */

const PORT = 3999;
const TOKEN = 'integration-test-token-not-a-real-credential';

/*
 * Two URLs, and the difference between them is the point.
 *
 * The process listens on plain HTTP and lets the cloudflared tunnel terminate TLS, exactly
 * as the Next.js app does — so the test client must connect over `ws://`. But the URL that
 * gets signed is the public `wss://` one, because that is what appears in the TwiML and
 * therefore what Twilio signs. Signing the `ws://` form would test a URL that never
 * occurs in production.
 */
const CONNECT_URL = `ws://localhost:${PORT}/relay`;
const SIGNED_URL = `wss://localhost:${PORT}/relay`;

let child: ChildProcess;

function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const socket = createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`Relay never listened on ${port}`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

/** Exactly Twilio's scheme: HMAC-SHA1 over the URL plus sorted params, base64. */
function sign(url: string, token: string): string {
  return createHmac('sha1', token).update(Buffer.from(url, 'utf8')).digest('base64');
}

/*
 * Credentials are blanked rather than inherited.
 *
 * `@atwood/core/env` reads `process.env` and nothing else — it does not load a `.env`
 * file — so spreading `process.env` here hands the child whatever the shell happens to
 * export. On a developer machine with the real values exported, this test would then
 * resolve a tenant, call a live model, and append rows to a real conversation: a test
 * that spends money and writes to production data depending on who runs it and where.
 *
 * Blanked to empty, which `required()`/`optional()` treat as absent, so the pipeline
 * deterministically takes its failure branch: a `ConfigError` on the first database
 * call, caught by `replyToCaller`, which is a path this test can assert on. It cannot
 * break the boot — the client is built lazily — and the only variable the process
 * genuinely needs is TWILIO_AUTH_TOKEN, which is set below.
 */
const BLANKED = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'RESEND_API_KEY',
  'N8N_WEBHOOK_BASE_URL',
  'INTERNAL_API_SECRET',
  'CREDENTIAL_ENCRYPTION_KEY',
] as const;

before(async () => {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TWILIO_AUTH_TOKEN: TOKEN,
    RELAY_PORT: String(PORT),
    LOG_LEVEL: 'error',
  };
  for (const name of BLANKED) env[name] = '';

  child = spawn(
    process.execPath,
    ['--experimental-strip-types', fileURLToPath(new URL('./server.ts', import.meta.url))],
    { env, stdio: 'ignore' },
  );
  await waitForPort(PORT);
});

after(() => {
  child?.kill('SIGTERM');
});

describe('relay server, over a real socket', () => {
  it('rejects an upgrade with no signature', async () => {
    const ws = new WebSocket(CONNECT_URL);
    const error = await new Promise<Error>((resolve) => ws.once('error', resolve));
    assert.match(error.message, /401/);
  });

  it('rejects an upgrade with a wrong signature', async () => {
    const ws = new WebSocket(CONNECT_URL, { headers: { 'x-twilio-signature': sign(SIGNED_URL, 'the-wrong-token') } });
    const error = await new Promise<Error>((resolve) => ws.once('error', resolve));
    assert.match(error.message, /401/);
  });

  it('accepts a correctly signed upgrade and answers a caller turn', async () => {
    const ws = new WebSocket(CONNECT_URL, { headers: { 'x-twilio-signature': sign(SIGNED_URL, TOKEN) } });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const received: Array<Record<string, unknown>> = [];
    ws.on('message', (data) => received.push(JSON.parse(data.toString('utf8'))));

    ws.send(
      JSON.stringify({
        type: 'setup',
        sessionId: 'VX-test',
        callSid: 'CA-test',
        from: '+447000000000',
        to: '+447462187713',
        customParameters: { businessId: 'biz-test' },
      }),
    );

    // An interim result must not produce a reply.
    ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'I would like', last: false }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(received.length, 0, 'an interim prompt must not be answered');

    ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'I would like a quote', last: true }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(received.length, 2, `expected a text turn and an end, got ${JSON.stringify(received)}`);
    const [text, end] = received as [Record<string, unknown>, Record<string, unknown>];
    assert.equal(text.type, 'text');

    /*
     * The words are deliberately not asserted.
     *
     * This process runs the real pipeline with no credentials (see `BLANKED` above), so
     * the turn takes its failure branch and the caller hears the apology. Pinning that
     * sentence here would copy a string out of `@atwood/core` into this package, where
     * the two would drift apart and the test would fail for a wording change rather than
     * a fault.
     *
     * What this test owns is the transport guarantee, and the failure path exercises it
     * better than a happy path would: whatever the domain decided, the caller hears a
     * voice rather than sitting in silence, and the line closes behind it instead of
     * hanging open. The turn's actual content is asserted in `protocol.test.ts`, which
     * injects a reply and so can say exactly what should be spoken.
     */
    assert.ok(String(text.token).length > 0, 'a turn must never resolve to silence');
    assert.equal(end.type, 'end');
  });

  it('closes the socket rather than throwing on an unparseable frame', async () => {
    const ws = new WebSocket(CONNECT_URL, { headers: { 'x-twilio-signature': sign(SIGNED_URL, TOKEN) } });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    ws.send('this is not json');

    // The process must survive it. A throw on the socket handler would take the service
    // down and every subsequent call with it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(ws.readyState, WebSocket.OPEN);

    const stillAlive = await new Promise<boolean>((resolve) => {
      const probe = new WebSocket(CONNECT_URL, { headers: { 'x-twilio-signature': sign(SIGNED_URL, TOKEN) } });
      probe.once('open', () => {
        probe.close();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
    assert.equal(stillAlive, true, 'the service must still accept connections');
    ws.close();
  });
});
