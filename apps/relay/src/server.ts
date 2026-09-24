import { createServer } from 'node:http';

import { STILL_THERE_LINE, replyToCaller } from '@atwood/core/domain';
import { serverEnv } from '@atwood/core/env';
import { validateTwilioSignature } from '@atwood/core/integrations/twilio';
import { logger } from '@atwood/core/utils';
import { WebSocketServer, type WebSocket } from 'ws';

import { RelaySession, parseFrame, type OutboundFrame } from './protocol.ts';
import { checkSignature } from './signature.ts';

/**
 * Atwood relay — the WebSocket half of the conversational voice path.
 *
 * Twilio's `<Connect><ConversationRelay>` opens this socket when a call is answered and
 * exchanges text turns with it. Everything telephony-shaped is Twilio's: recognition,
 * synthesis, the audio format, and barge-in. What lands here is JSON, which is why this
 * is a small process rather than a media pipeline.
 *
 * **It is a separate process on purpose.** It has to stay up for the whole of a call,
 * which is exactly what a Next.js route handler cannot promise — the platform's own voice
 * route says it best, that it "must respond fast and synchronously". A route that
 * returned TwiML and then tried to hold a socket open would be fighting its runtime.
 *
 * It follows the `sam-voice.service` precedent: a plain Node process on its own port,
 * under its own systemd user unit, reachable only through the cloudflared tunnel.
 *
 * **Where the intelligence lives.** Not here. This process is transport: it validates a
 * handshake, parses frames, and hands each caller turn to `replyToCaller` from
 * `@atwood/core/domain`, which is the same pipeline the SMS channel runs and the same
 * prompt, handover ladder and lead extraction. The relay owns the socket and knows
 * nothing about customers; that separation is what lets the turn logic be tested without
 * a phone call and the pipeline be tested without a socket.
 */

/*
 * Relay-local knobs, read directly and deliberately kept out of the shared registry in
 * `@atwood/core/env`: nothing else in the platform has an opinion about which port this
 * process listens on. The secrets are a different matter and come from the registry, so
 * there is still exactly one name for each.
 */
const PORT = Number.parseInt(process.env.RELAY_PORT ?? '3002', 10);

/**
 * Fail at boot if the auth token is missing.
 *
 * Without this the process starts cleanly, accepts the port, and then rejects every
 * handshake — so the symptom is "the assistant never answers" and the cause is a missing
 * variable, which is the exact failure the platform's env module exists to prevent
 * ("a missing one fails at boot with a useful message rather than at 2am with `undefined
 * is not a function`"). Reading it through the registry rather than off `process.env`
 * keeps the one-name rule intact.
 */
try {
  void serverEnv.twilioAuthToken;
} catch (error) {
  logger.error('Relay cannot start', {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}

/**
 * Reject a handshake whose signature does not validate.
 *
 * Fails closed. An unauthenticated WebSocket on a public hostname is an open door to
 * someone else's phone bill, and unlike an HTTP webhook there is no response body to make
 * that visible afterwards — a bad socket just connects and does nothing.
 */
const server = createServer((_request, response) => {
  // Non-upgrade traffic on this path is a person or a scanner, not Twilio. Answering 426
  // says what the endpoint is for without implying there is anything else here.
  response.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('This endpoint accepts WebSocket connections only.\n');
});

const sockets = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const result = checkSignature({
    signature: request.headers['x-twilio-signature'] as string | undefined,
    request,
    baseUrlOverride: process.env.RELAY_PUBLIC_URL ?? null,
    verify: (input) => validateTwilioSignature(input),
  });

  if (!result.valid) {
    /*
     * One warn line with the candidates that were offered. Which URL Twilio signs is not
     * in its documentation for WebSockets, so on a rejection the candidates are the only
     * thing that explains it — and a signature header that is entirely absent reads very
     * differently from one that was present and did not match.
     */
    logger.warn('Relay handshake rejected', {
      hadSignature: Boolean(request.headers['x-twilio-signature']),
      candidates: result.candidates,
      host: request.headers['x-forwarded-host'] ?? request.headers.host ?? null,
    });
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  /*
   * The matched scheme is logged deliberately. Twilio does not document whether it signs
   * the `wss://` form or the `https://` form of the same URL, so `signature.ts` accepts
   * either and this line is how the answer is learned from the first real call rather than
   * guessed at. Once it has been seen, the other candidate can be dropped.
   */
  logger.info('Relay handshake accepted', {
    signedUrlForm: result.matchedUrl?.startsWith('wss://') ? 'wss' : 'https',
  });

  sockets.handleUpgrade(request, socket, head, (ws) => {
    sockets.emit('connection', ws, request);
  });
});

sockets.on('connection', (ws: WebSocket) => {
  const send = (outbound: OutboundFrame[]): void => {
    for (const message of outbound) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    }
  };

  const session = new RelaySession({
    // A backstop, not the product's limit — the tenant's `ai_max_turns` is that, and the
    // domain enforces it by asking for the call to end. See `RelaySessionOptions`.
    maxTurns: Number.parseInt(process.env.RELAY_MAX_TURNS ?? '40', 10),
    // The whole of this process's knowledge of the domain layer, in one line.
    reply: (request) => replyToCaller(request),
    onEvent: (event, fields) => {
      // Everything the call does, at info, because that log is the evidence a test call
      // produced. A voice call leaves no transcript unless we write one down.
      logger.info('Relay call event', { event, ...fields });
    },
    // The silence backstop speaks unprompted, so it needs the socket's send directly, and
    // its one line comes from core with the rest of the call's copy.
    send,
    stillThereLine: STILL_THERE_LINE,
  });

  ws.on('message', (data) => {
    const raw = data.toString('utf8');
    const frame = parseFrame(raw);

    if (!frame) {
      /*
       * Dropped, never thrown. An exception on a socket kills a live call, and silence is
       * the safe failure: Twilio tolerates being sent nothing. Sending it something it
       * cannot identify is what it punishes — ten in a row closes the socket with 1007.
       */
      logger.warn('Relay frame could not be parsed', { bytes: raw.length });
      return;
    }

    /*
     * Deliberately not awaited. A reply takes a model round trip, and awaiting it here
     * would hold every later frame behind that while Twilio carries on sending — a
     * barge-in would arrive and sit in the queue behind the very answer it is meant to
     * interrupt. Each frame gets its own promise, and the session resolves which of them
     * is still worth speaking.
     */
    session
      .handle(frame)
      .then(send)
      .catch((error: unknown) => {
        // `handle` is written not to throw, and `replyToCaller` catches its own failures.
        // This is the backstop for a bug in either: log it and keep the call alive.
        logger.error('Relay turn logic threw', {
          type: frame.type,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  });

  ws.on('error', (error: Error) => {
    logger.error('Relay socket error', { message: error.message });
  });

  ws.on('close', (code: number, reason: Buffer) => {
    session.dispose();
    /*
     * 1007 is Twilio's "too many consecutive malformed messages" and 1000 is an ordinary
     * end. Logging the reason matters because an unexpected close is not retried by
     * Twilio — it ends the call with a `failed` status and nothing else records why.
     */
    logger.info('Relay socket closed', {
      code,
      reason: reason.toString('utf8'),
      endedByUs: session.isEnded,
    });
  });
});

server.listen(PORT, () => {
  logger.info('Relay listening', {
    port: PORT,
    // The public URL is derived per-connection from the upgrade request's host, so there
    // is nothing to print here but whether an override is in force.
    publicUrlOverride: process.env.RELAY_PUBLIC_URL ? 'set' : 'not set',
  });
});

/**
 * Shut down cleanly.
 *
 * systemd sends SIGTERM on restart. Closing the HTTP server lets an in-flight upgrade
 * finish and stops new calls arriving at a process that is about to die — a call that
 * connects during a restart would otherwise ring, connect and then drop.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info('Relay shutting down', { signal });
    for (const client of sockets.clients) client.close(1001, 'server shutting down');
    sockets.close(() => server.close(() => process.exit(0)));
    // Do not hang forever on a socket that will not close.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
