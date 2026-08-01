import { logger, reconstructTwilioUrl, serverEnv, toAppError } from '@atwood/core';

/**
 * Error mapping for the Twilio webhook routes.
 *
 * Every webhook handler starts by verifying the request signature, and that check
 * throws. Without a wrapper the throw escapes into the framework and becomes a
 * **500**, which is the one status that must not be returned here: Twilio treats
 * 5xx as transient and retries. So a forged request earns free retries, and — worse
 * — a misconfigured `TWILIO_AUTH_TOKEN` turns every legitimate webhook into a
 * retried 500 whose logs say "server error" rather than "signature failed".
 *
 * The same applies to any other failure inside a handler: the voice route reads the
 * database to resolve the dialled number, and a database blip there should not be
 * answered with a status that makes Twilio replay the call event.
 *
 * Responses are TwiML rather than JSON. These endpoints are consumed by Twilio, and
 * on a voice call an unparseable body is read out to the caller as an error.
 */
export function withTwilioWebhook(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    try {
      return await handler(request);
    } catch (error) {
      const appError = toAppError(error);
      const path = new URL(request.url).pathname;

      // A rejected signature is routine (scanners, a stale URL, a rotated token) and
      // belongs at warn. A 5xx is ours to investigate.
      if (appError.status >= 500) {
        logger.error('Twilio webhook failed', {
          path,
          code: appError.code,
          message: appError.message,
        });
      } else {
        logger.warn('Twilio webhook rejected', {
          path,
          code: appError.code,
          message: appError.message,
        });
      }

      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><Response><!-- ${escapeXmlComment(
          appError.publicMessage,
        )} --></Response>`,
        {
          status: appError.status,
          headers: { 'content-type': 'text/xml; charset=utf-8' },
        },
      );
    }
  };
}

/**
 * `--` terminates an XML comment early, so a message containing one would produce
 * a malformed document. The public messages are ours, but this is a comment built
 * from a string at runtime and that is exactly the shape that eventually receives
 * something unexpected.
 */
function escapeXmlComment(message: string): string {
  return message.replace(/-{2,}/g, '-').replace(/>/g, '');
}

/**
 * Adapt a Next `Request` to the core reconstruction, which holds the actual rules and
 * is unit-tested. Only the header extraction lives here, because only that part
 * depends on the framework.
 */
export function reconstructUrl(request: Request): string {
  return reconstructTwilioUrl({
    requestUrl: request.url,
    forwardedProto: request.headers.get('x-forwarded-proto'),
    forwardedHost: request.headers.get('x-forwarded-host'),
    host: request.headers.get('host'),
    baseUrlOverride: serverEnv.twilioWebhookBaseUrl ?? null,
  });
}
