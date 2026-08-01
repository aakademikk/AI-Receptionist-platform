/**
 * Error taxonomy for the internal API.
 *
 * n8n branches on HTTP status, so every failure needs a status and a stable
 * machine-readable code. The distinction that matters most is retryable vs not:
 * n8n will retry a 5xx and must not retry a 4xx, and a workflow that retries a
 * validation error forever is how you end up sending a customer eleven texts.
 */

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'unprocessable'
  | 'rate_limited'
  | 'provider_error'
  | 'provider_refused'
  | 'internal_error'
  | 'not_configured';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  /** Safe to show a tenant user. Internal messages may contain diagnostics. */
  readonly publicMessage: string;

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    options: { details?: unknown; publicMessage?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = options.details;
    this.publicMessage = options.publicMessage ?? message;
  }

  toResponseBody(): { error: { code: ErrorCode; message: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.publicMessage,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError('bad_request', 400, message, { details });

export const unauthorized = (message = 'Authentication required'): AppError =>
  new AppError('unauthorized', 401, message);

export const forbidden = (message = 'Not permitted'): AppError =>
  new AppError('forbidden', 403, message);

export const notFound = (what: string): AppError =>
  new AppError('not_found', 404, `${what} not found`);

export const conflict = (message: string, details?: unknown): AppError =>
  new AppError('conflict', 409, message, { details });

export const unprocessable = (message: string, details?: unknown): AppError =>
  new AppError('unprocessable', 422, message, { details });

export const rateLimited = (message = 'Rate limit exceeded'): AppError =>
  new AppError('rate_limited', 429, message);

export const notConfigured = (what: string): AppError =>
  new AppError(
    'not_configured',
    422,
    `${what} is not configured for this business`,
    { publicMessage: `${what} has not been set up yet.` },
  );

export const internalError = (message: string, cause?: unknown): AppError =>
  new AppError('internal_error', 500, message, {
    cause,
    // Never leak an internal message to a client.
    publicMessage: 'Something went wrong on our side.',
  });

/**
 * A model declined the request. Distinct from `provider_error` because the
 * response is a 200 from the provider and retrying will not help — the workflow
 * must escalate to a human instead.
 */
export const providerRefused = (details?: unknown): AppError =>
  new AppError('provider_refused', 422, 'The AI provider declined this request', {
    details,
    publicMessage: 'The assistant could not handle this message and it needs a person.',
  });

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Say what `fetch failed` actually was.
 *
 * Node's fetch collapses every transport failure into the two words "fetch failed"
 * and hides the real reason — DNS, refused connection, expired certificate — one or
 * two levels down in `cause`. Logging the outer message alone turns a five-second
 * diagnosis into an afternoon, so this walks the chain and reports the innermost
 * thing that has something to say.
 */
export function describeFetchError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    const detail = code ? `${current.message} (${code})` : current.message;
    if (!parts.includes(detail)) parts.push(detail);
    current = (current as { cause?: unknown }).cause;
  }

  if (parts.length === 0) return String(error);
  return parts.join(' — caused by: ');
}

/**
 * Translate a Supabase auth error into something the person reading it can act on.
 *
 * Two of these are transport failures wearing an application error's clothes. The
 * Supabase client parses every response as JSON, so if the configured URL reaches
 * something that answers with a web page, the user is shown
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON` — a message about a
 * parser, at sign-in, that names neither the URL nor the mistake. `fetch failed` is
 * the same problem when the host does not resolve at all.
 *
 * Anything genuinely from the auth API ("Email rate limit exceeded", an invalid
 * link) is already meaningful and passes through untouched.
 */
export function explainAuthError(message: string, supabaseUrl: string): string {
  /*
   * An empty or content-free message renders as a stray "{}" in the form, which tells
   * the reader less than nothing. It happens when the auth service fails in a way that
   * produces no message body — locally, the usual cause is a hand-inserted auth.users
   * row with NULL token columns, which GoTrue cannot scan.
   */
  const trimmed = message.trim();
  if (trimmed === '' || trimmed === '{}' || trimmed === '[object Object]') {
    return (
      'The auth service returned an error with no message. Locally this usually means ' +
      'a manually inserted user row — run `pnpm db:reset` to reseed. Check the ' +
      '`supabase_auth` container logs for the underlying cause.'
    );
  }

  if (message.includes('is not valid JSON') || message.includes('<!DOCTYPE')) {
    return (
      `${supabaseUrl} answered with a web page instead of the Supabase API. ` +
      `Check NEXT_PUBLIC_SUPABASE_URL — locally the API is on port 54321 ` +
      `(54323 is Studio, and 3000 is this app).`
    );
  }

  if (/^fetch failed$/i.test(message.trim()) || message.includes('ENOTFOUND')) {
    return (
      `Could not reach the Supabase API at ${supabaseUrl}. ` +
      `Start it with \`pnpm db:start\`, or correct NEXT_PUBLIC_SUPABASE_URL.`
    );
  }

  return message;
}

/** Normalise anything thrown into an AppError so route handlers stay tidy. */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) return internalError(error.message, error);
  return internalError(String(error));
}
