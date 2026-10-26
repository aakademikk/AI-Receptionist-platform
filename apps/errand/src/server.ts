import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { buildHangupTwiml, parseTwilioForm } from '@atwood/core/integrations/twilio';
import { WebSocketServer, type WebSocket } from 'ws';

import { ERRAND_PORT, HEALTH_PATH, SOCKET_PATH, STATUS_PATH, TWIML_PATH, errandHome, maskSid } from './config.ts';
import { verifySocket, verifyWebhook } from './signature.ts';
import { errandTwiml } from './twiml.ts';
import { errandExists, isErrandId } from './store.ts';

/**
 * The errand server: its own process, its own endpoints (must-dos 20, 21).
 *
 * One Node process on 127.0.0.1:3003, reachable from outside only through the one tunnel rule
 * staged in `deploy/tunnel-rule.yml`. It serves:
 *
 *   POST /errand/twiml    call instructions, asked by Twilio when the call is answered (T13)
 *   POST /errand/status   every call status change (T17)
 *   WS   /errand/ws       the ConversationRelay socket for one call (T16)
 *   GET  /errand/health   local-only liveness for the dial step (not public, not tunnelled)
 *
 * **Every Twilio route fails closed.** A request is served only when `X-Twilio-Signature`
 * validates against the public URL (with its query string) and the form body under the
 * account's auth token. A missing token, a missing header or a mismatch answers 403 with no
 * detail in the body and one log line. The socket upgrade is refused the same way, as an HTTP
 * 403 with no upgrade. This mirrors the relay, which shares the reasoning: an unauthenticated
 * endpoint on a public hostname is an open door to someone's phone bill.
 *
 * **The health check is not public.** It answers only a request from the loopback address
 * that carries no `CF-Connecting-IP` header (cloudflared adds one to everything it forwards),
 * so even if a tunnel rule ever matched it, the outside would get a 404.
 *
 * **It is separate from the receptionist on purpose** (spec fact F4): the relay picks its reply
 * function when the socket opens and resolves a tenant from the dialled number, which on an
 * errand is the business. Nothing here imports the relay or the tenant domain; the boundary
 * test enforces it.
 *
 * The route handlers are injected, so tests can run the real HTTP and signature path against
 * a temp folder with fakes behind it.
 */

export type LogFn = (message: string, fields?: Record<string, unknown>) => void;

export interface ServerDeps {
  /** The account's auth tokens (primary, and secondary during a rotation). Empty means fail closed. */
  tokens: () => string[];
  home?: string;
  log?: LogFn;
  /** TwiML for an answered call with a known errand id (T13). */
  twiml?: (errandId: string, params: Record<string, string>) => string;
  /** A status change for a known errand id (T17). */
  status?: (errandId: string, params: Record<string, string>) => Promise<void> | void;
  /** A signed socket, one call (T16). */
  connection?: (ws: WebSocket, request: IncomingMessage) => void;
}

/** Twilio's form bodies are small; anything bigger is not Twilio. */
const MAX_BODY_BYTES = 64 * 1024;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const jsonLog: LogFn = (message, fields = {}) => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), message, ...fields })}\n`);
};

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, body = '', type = 'text/plain; charset=utf-8'): void {
  response.writeHead(status, { 'content-type': type });
  response.end(body);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function createErrandServer(deps: ServerDeps): { server: Server; sockets: WebSocketServer } {
  const home = deps.home ?? errandHome();
  const log = deps.log ?? jsonLog;
  const twiml = deps.twiml ?? ((errandId: string, params: Record<string, string>) => errandTwiml(errandId, params, { home }));
  const status = deps.status ?? (() => undefined);
  const connection = deps.connection ?? ((ws: WebSocket) => ws.close(1000, 'no session handler'));

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      log('Errand request failed', { path: request.url?.split('?')[0], message: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) send(response, 500);
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === HEALTH_PATH && request.method === 'GET') {
      const local = LOOPBACK.has(request.socket.remoteAddress ?? '') && header(request, 'cf-connecting-ip') === undefined;
      if (local) send(response, 200, JSON.stringify({ ok: true }), 'application/json');
      else send(response, 404);
      return;
    }

    if ((url.pathname !== TWIML_PATH && url.pathname !== STATUS_PATH) || request.method !== 'POST') {
      send(response, 404);
      return;
    }

    const raw = await readBody(request);
    if (raw === null) {
      send(response, 413);
      return;
    }
    const params = parseTwilioForm(raw);
    const signature = header(request, 'x-twilio-signature');
    const tokens = deps.tokens();
    if (!verifyWebhook({ signature, requestUrl: request.url ?? '/', params, tokens })) {
      log('Errand webhook rejected', { path: url.pathname, hadSignature: Boolean(signature), tokenConfigured: tokens.length > 0 });
      send(response, 403);
      return;
    }

    const errandId = url.searchParams.get('errand');
    const known = isErrandId(errandId) && errandExists(errandId, home);

    if (url.pathname === TWIML_PATH) {
      if (!known) {
        log('Errand twiml for an unknown errand; hanging up', { callSid: maskSid(params.CallSid) });
        send(response, 200, buildHangupTwiml(), 'text/xml');
        return;
      }
      send(response, 200, twiml(errandId, params), 'text/xml');
      return;
    }

    // Status: always 200 once signed, so Twilio does not retry a post we have already logged.
    if (!known) {
      log('Errand status for an unknown errand', { callSid: maskSid(params.CallSid), callStatus: params.CallStatus ?? null });
    } else {
      await status(errandId, params);
    }
    send(response, 200, '<?xml version="1.0" encoding="UTF-8"?>\n<Response/>', 'text/xml');
  }

  const sockets = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const path = (request.url ?? '/').split('?')[0];
    if (path !== SOCKET_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const tokens = deps.tokens();
    const result = verifySocket({ signature: header(request, 'x-twilio-signature'), request, tokens });
    if (!result.valid) {
      log('Errand socket rejected', { hadSignature: Boolean(header(request, 'x-twilio-signature')), tokenConfigured: tokens.length > 0, candidates: result.candidates });
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    log('Errand socket accepted', { signedUrlForm: result.matchedForm });
    sockets.handleUpgrade(request, socket, head, (ws) => connection(ws, request));
  });

  return { server, sockets };
}

/** The account's auth tokens from the environment: primary, then secondary when set. Never logged. */
export function tokensFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.TWILIO_AUTH_TOKEN, env.TWILIO_AUTH_TOKEN_SECONDARY].map((token) => token?.trim()).filter((token): token is string => Boolean(token));
}

/**
 * Start the service. Refuses to start without an auth token: a process that listens but
 * rejects every request reads as "Amy never answered", and the cause is a missing variable.
 */
export function main(env: NodeJS.ProcessEnv = process.env): Server {
  if (tokensFromEnv(env).length === 0) {
    jsonLog('Errand service cannot start', { reason: 'TWILIO_AUTH_TOKEN is not set' });
    process.exit(1);
  }
  const port = Number.parseInt(env.ERRAND_PORT ?? String(ERRAND_PORT), 10);
  const { server, sockets } = createErrandServer({ tokens: () => tokensFromEnv(env) });
  server.listen(port, '127.0.0.1', () => jsonLog('Errand service listening', { port }));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      jsonLog('Errand service shutting down', { signal });
      for (const client of sockets.clients) client.close(1001, 'server shutting down');
      sockets.close(() => server.close(() => process.exit(0)));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
