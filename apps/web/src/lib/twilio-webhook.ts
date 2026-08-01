import { logger, serverEnv, toAppError } from '@atwood/core';

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
 * Rebuild the URL Twilio signed.
 *
 * Vercel and most proxies terminate TLS and forward the original scheme and host in
 * `x-forwarded-*`. Without honouring those, `request.url` reports `http` and the
 * signature payload differs from what Twilio hashed, so every request is rejected —
 * a failure that looks like a bad auth token rather than a proxy detail.
 *
 * This lives here rather than in a `route.ts` because a route file is meant to export
 * HTTP method handlers; anything else it exports is an accident of convenience that
 * a future Next.js version is entitled to reject.
 */
export function reconstructUrl(request: Request): string {
  const original = new URL(request.url);

  /*
   * An explicit override wins over the headers. A tunnel that rewrites Host to the
   * origin — which is what a quick tunnel does — leaves the app rebuilding
   * `http://localhost:3000/...` and rejecting every request as a bad signature, and no
   * amount of header inspection recovers a value that was never forwarded.
   *
   * Only scheme and host are taken; path and query still come from the request, so one
   * setting covers every webhook route.
   */
  const override = serverEnv.twilioWebhookBaseUrl;
  if (override) {
    try {
      const base = new URL(override);
      original.protocol = base.protocol;
      original.host = base.host;
      return original.toString();
    } catch {
      logger.warn('TWILIO_WEBHOOK_BASE_URL is not a valid URL; falling back to headers', {
        value: override,
      });
    }
  }

  const forwardedProto = request.headers.get('x-forwarded-proto');
  const forwardedHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host');

  if (forwardedProto) original.protocol = `${forwardedProto.split(',')[0]!.trim()}:`;
  if (forwardedHost) original.host = forwardedHost.split(',')[0]!.trim();

  return original.toString();
}
