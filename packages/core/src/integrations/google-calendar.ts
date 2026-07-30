import { decryptSecret } from '../crypto/secrets.ts';
import { getAdminClient } from '../supabase/admin.ts';
import { AppError, notConfigured } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';

/**
 * Google Calendar integration for the booking engine.
 *
 * OAuth refresh tokens are stored per-tenant in `integration_credentials`, encrypted
 * with AES-256-GCM. This module is the only place they are decrypted, and the
 * plaintext never leaves the function scope.
 *
 * Access tokens are cached in memory for their lifetime. Google's refresh endpoint
 * is rate-limited per client, and exchanging a refresh token on every availability
 * check would both waste ~200ms and eventually get us throttled across all tenants.
 */

interface GoogleCredential {
  refresh_token: string;
  client_id: string;
  client_secret: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/** Exchange the tenant's refresh token for an access token, cached. */
async function getAccessToken(businessId: string): Promise<string> {
  const cached = tokenCache.get(businessId);
  // 60s of slack so a token cannot expire mid-request.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

  const { data, error } = await getAdminClient()
    .from('integration_credentials')
    .select('ciphertext')
    .eq('business_id', businessId)
    .eq('provider', 'google_calendar')
    .maybeSingle();

  if (error) throw new AppError('internal_error', 500, `Credential lookup failed: ${error.message}`);
  if (!data) throw notConfigured('Google Calendar');

  const credential = decryptSecret<GoogleCredential>((data as { ciphertext: string }).ciphertext);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credential.refresh_token,
      client_id: credential.client_id,
      client_secret: credential.client_secret,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    // `invalid_grant` means the tenant revoked access. Retrying will never fix it,
    // so it must surface as a configuration problem the owner can act on.
    const errorCode = typeof payload['error'] === 'string' ? payload['error'] : 'unknown';
    if (errorCode === 'invalid_grant') {
      logger.warn('Google Calendar access was revoked by the tenant', { businessId });
      throw new AppError('not_configured', 422, 'Google Calendar access has been revoked', {
        publicMessage: 'Google Calendar needs reconnecting.',
      });
    }
    throw new AppError('provider_error', 502, `Google token refresh failed: ${errorCode}`);
  }

  const accessToken = String(payload['access_token']);
  const expiresIn = Number(payload['expires_in'] ?? 3600);

  tokenCache.set(businessId, { accessToken, expiresAt: Date.now() + expiresIn * 1000 });

  await getAdminClient()
    .from('integration_credentials')
    .update({ last_used_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('provider', 'google_calendar');

  return accessToken;
}

export interface BusyPeriod {
  start: string;
  end: string;
}

/**
 * Fetch busy periods via the freeBusy endpoint.
 *
 * freeBusy rather than events.list because it returns only opaque busy blocks —
 * no titles, no attendees, no descriptions. The AI needs to know *whether* a slot
 * is free, and giving it the contents of the owner's diary would be both
 * unnecessary and a privacy problem.
 */
export async function getBusyPeriods(input: {
  businessId: string;
  calendarId: string;
  from: Date;
  to: Date;
}): Promise<BusyPeriod[]> {
  const accessToken = await getAccessToken(input.businessId);

  const response = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      timeMin: input.from.toISOString(),
      timeMax: input.to.toISOString(),
      items: [{ id: input.calendarId }],
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new AppError('provider_error', 502, `Google freeBusy failed (${response.status})`);
  }

  const payload = (await response.json()) as {
    calendars?: Record<string, { busy?: BusyPeriod[]; errors?: Array<{ reason: string }> }>;
  };

  const calendar = payload.calendars?.[input.calendarId];

  if (calendar?.errors?.length) {
    throw new AppError(
      'unprocessable',
      422,
      `Calendar unavailable: ${calendar.errors.map((e) => e.reason).join(', ')}`,
      { publicMessage: 'That calendar could not be read.' },
    );
  }

  return calendar?.busy ?? [];
}

export interface CreateEventInput {
  businessId: string;
  calendarId: string;
  summary: string;
  description?: string;
  start: Date;
  end: Date;
  timezone: string;
  attendeeEmail?: string | null;
  location?: string | null;
  /**
   * Stable key so a retried booking updates the same event instead of creating a
   * duplicate. Google requires base32hex — lowercase a–v and 0–9.
   */
  requestId?: string;
}

export interface CreatedEvent {
  eventId: string;
  htmlLink: string | null;
  status: string;
}

export async function createEvent(input: CreateEventInput): Promise<CreatedEvent> {
  const accessToken = await getAccessToken(input.businessId);

  const body: Record<string, unknown> = {
    summary: input.summary,
    description: input.description,
    start: { dateTime: input.start.toISOString(), timeZone: input.timezone },
    end: { dateTime: input.end.toISOString(), timeZone: input.timezone },
    ...(input.location ? { location: input.location } : {}),
    ...(input.attendeeEmail ? { attendees: [{ email: input.attendeeEmail }] } : {}),
    reminders: { useDefault: true },
  };

  if (input.requestId) body['id'] = toGoogleEventId(input.requestId);

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events?sendUpdates=${
      input.attendeeEmail ? 'all' : 'none'
    }`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    },
  );

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  // 409 means our own idempotency key already created this event — the retry
  // succeeded the first time. Treat it as success, not failure.
  if (response.status === 409 && input.requestId) {
    logger.info('Calendar event already existed; treating as booked', {
      businessId: input.businessId,
    });
    return { eventId: toGoogleEventId(input.requestId), htmlLink: null, status: 'confirmed' };
  }

  if (!response.ok) {
    const errorPayload = (payload['error'] ?? {}) as Record<string, unknown>;
    const message =
      typeof errorPayload['message'] === 'string' ? errorPayload['message'] : response.statusText;
    throw new AppError(
      response.status >= 500 ? 'provider_error' : 'unprocessable',
      response.status >= 500 ? 502 : 422,
      `Calendar event creation failed: ${message}`,
      { publicMessage: 'The appointment could not be added to the calendar.' },
    );
  }

  return {
    eventId: String(payload['id']),
    htmlLink: typeof payload['htmlLink'] === 'string' ? payload['htmlLink'] : null,
    status: String(payload['status'] ?? 'confirmed'),
  };
}

export async function cancelEvent(input: {
  businessId: string;
  calendarId: string;
  eventId: string;
}): Promise<void> {
  const accessToken = await getAccessToken(input.businessId);

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      input.calendarId,
    )}/events/${encodeURIComponent(input.eventId)}?sendUpdates=all`,
    {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    },
  );

  // 404/410 mean it is already gone, which is the desired end state.
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    throw new AppError('provider_error', 502, `Calendar cancellation failed (${response.status})`);
  }
}

/**
 * Google event ids must be base32hex (a–v, 0–9) and at least 5 characters. Our
 * UUIDs contain w–z and hyphens, so map the out-of-range characters rather than
 * stripping them (stripping would risk collisions between distinct ids).
 */
function toGoogleEventId(requestId: string): string {
  const mapped = requestId
    .toLowerCase()
    .replace(/-/g, '')
    .replace(/[w-z]/g, (char) => ({ w: 'q', x: 'r', y: 's', z: 't' })[char] ?? 'a');
  return `atw${mapped}`.slice(0, 60);
}

/** Clear the cached token, e.g. after the tenant reconnects. */
export function invalidateTokenCache(businessId: string): void {
  tokenCache.delete(businessId);
}
