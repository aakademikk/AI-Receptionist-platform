import { NextResponse } from 'next/server';

import {
  badRequest,
  hashApiKey,
  getAdminClient,
  logger,
  newTraceId,
  serverEnv,
  toAppError,
  unauthorized,
  verifySharedSecret,
} from '@atwood/core';

/**
 * Authentication and error handling for the internal API.
 *
 * The internal API is the boundary between n8n (and any future worker) and the
 * database. It is not public, but it is internet-reachable — n8n may run anywhere —
 * so it authenticates every request.
 *
 * Two credential types:
 *
 *   * **Shared secret** (`x-atwood-secret`) — platform-wide, used by n8n. One value
 *     to rotate, no per-tenant bookkeeping. Compared in constant time.
 *   * **API key** (`authorization: Bearer atw_…`) — per-tenant, hashed in
 *     `api_keys`, for customer integrations. Carries a `business_id`, which the
 *     handler must then enforce.
 *
 * A request authenticated by API key must never be able to act on another tenant.
 * `requireInternalAuth` returns the scope so handlers can check it, and
 * `assertBusinessScope` is the check.
 */

export interface InternalAuthContext {
  traceId: string;
  /** null for the platform-wide shared secret; set for a tenant API key. */
  businessId: string | null;
  scopes: string[];
  actor: 'n8n' | 'api_key';
}

export async function requireInternalAuth(request: Request): Promise<InternalAuthContext> {
  // Reuse an upstream trace id when present so an n8n execution and the API calls
  // it makes appear as one trace.
  const traceId = request.headers.get('x-atwood-trace-id') ?? newTraceId();

  const sharedSecret = request.headers.get('x-atwood-secret');
  if (sharedSecret) {
    if (!verifySharedSecret(sharedSecret, serverEnv.internalApiSecret)) {
      throw unauthorized('Invalid internal API secret');
    }
    return { traceId, businessId: null, scopes: ['*'], actor: 'n8n' };
  }

  const authorization = request.headers.get('authorization');
  if (authorization?.startsWith('Bearer ')) {
    const presented = authorization.slice('Bearer '.length).trim();

    // Look up by hash, not by prefix-then-compare: the hash is unique-indexed, so
    // this is one indexed read and there is no partial-match timing signal.
    const { data, error } = await getAdminClient()
      .from('api_keys')
      .select('id, business_id, scopes, revoked_at, expires_at')
      .eq('key_hash', hashApiKey(presented))
      .maybeSingle();

    if (error) throw unauthorized('Could not verify the API key');
    if (!data) throw unauthorized('Unknown API key');

    const key = data as {
      id: string;
      business_id: string | null;
      scopes: string[];
      revoked_at: string | null;
      expires_at: string | null;
    };

    if (key.revoked_at) throw unauthorized('This API key has been revoked');
    if (key.expires_at && new Date(key.expires_at) < new Date()) {
      throw unauthorized('This API key has expired');
    }

    // Fire-and-forget: last_used_at is useful for spotting stale keys but must not
    // add a write to the latency of every request.
    void getAdminClient()
      .from('api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', key.id);

    return { traceId, businessId: key.business_id, scopes: key.scopes, actor: 'api_key' };
  }

  throw unauthorized('Internal API requests must present x-atwood-secret or a Bearer API key');
}

/**
 * Enforce that a tenant-scoped credential is acting on its own tenant.
 *
 * The shared secret is platform-wide and passes. An API key must match.
 */
export function assertBusinessScope(auth: InternalAuthContext, businessId: string): void {
  if (auth.businessId === null) return;
  if (auth.businessId !== businessId) {
    throw unauthorized('This API key cannot act on that business');
  }
}

/**
 * Wrap a route handler with auth, error mapping and logging.
 *
 * Mapping errors centrally is what lets n8n branch reliably: a 4xx is our bug and
 * must not be retried, a 5xx is transient and should be. Handlers throw domain
 * errors and this decides the status.
 */
export function withInternalAuth<Ctx = unknown>(
  handler: (request: Request, auth: InternalAuthContext, ctx: Ctx) => Promise<Response>,
): (request: Request, ctx: Ctx) => Promise<Response> {
  return async (request: Request, ctx: Ctx) => {
    let auth: InternalAuthContext | null = null;

    try {
      auth = await requireInternalAuth(request);
      const response = await handler(request, auth, ctx);
      response.headers.set('x-atwood-trace-id', auth.traceId);
      return response;
    } catch (error) {
      const appError = toAppError(error);

      // 5xx is ours to investigate; 4xx is the caller's to fix. Log accordingly so
      // the error channel stays signal.
      const log = logger.child({ traceId: auth?.traceId, path: new URL(request.url).pathname });
      if (appError.status >= 500) {
        log.error('Internal API request failed', {
          code: appError.code,
          message: appError.message,
        });
      } else {
        log.warn('Internal API request rejected', {
          code: appError.code,
          message: appError.message,
        });
      }

      return NextResponse.json(appError.toResponseBody(), {
        status: appError.status,
        headers: auth ? { 'x-atwood-trace-id': auth.traceId } : undefined,
      });
    }
  };
}

/** Parse a JSON body. A malformed body is a 400, not a 500. */
export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`"${field}" is required and must be a non-empty string`);
  }
  return value.trim();
}

export function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
