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

/** Normalise anything thrown into an AppError so route handlers stay tidy. */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) return internalError(error.message, error);
  return internalError(String(error));
}
