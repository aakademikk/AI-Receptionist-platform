import { serverEnv } from '../env.ts';
import { AppError } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';

/**
 * Transactional email via Resend.
 *
 * Plain `fetch` against one endpoint — the SDK adds nothing we need. Kept behind
 * this narrow interface so swapping to Postmark or SES later is a single file.
 *
 * Notification emails are plain text by default. They are operational alerts read
 * on a phone in a van, not marketing, and text renders identically everywhere and
 * never trips a spam filter for image ratio.
 */

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  from?: string;
}

export async function sendEmail(input: SendEmailInput): Promise<{ id: string }> {
  const apiKey = serverEnv.resendApiKey;

  if (!apiKey) {
    // A missing key is a configuration state, not a runtime fault. Surfacing it as
    // `not_configured` lets the notification worker suppress the row rather than
    // retry it five times.
    throw new AppError('not_configured', 422, 'RESEND_API_KEY is not configured', {
      publicMessage: 'Email delivery is not configured.',
    });
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: input.from ?? serverEnv.notificationFromEmail,
      to: [input.to],
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
      ...(input.replyTo ? { reply_to: input.replyTo } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const message =
      typeof payload['message'] === 'string' ? payload['message'] : response.statusText;

    throw new AppError(
      'provider_error',
      response.status >= 500 ? 502 : 422,
      `Email send failed (${response.status}): ${message}`,
      { publicMessage: 'The email could not be sent.' },
    );
  }

  const id = typeof payload['id'] === 'string' ? payload['id'] : 'unknown';
  logger.debug('Email sent', { emailId: id });
  return { id };
}

/**
 * Wrap a plain-text alert in minimal branded HTML.
 *
 * Inline styles only, and a table-free single-column layout: email clients discard
 * `<style>` blocks and Outlook ignores most of flexbox. The brand colour is the
 * tenant's, so an owner sees their own identity rather than ours — the white-label
 * promise has to hold in the inbox too, not just the dashboard.
 */
export function renderBrandedEmail(input: {
  businessName: string;
  brandColour: string;
  logoUrl?: string | null;
  heading: string;
  body: string;
  actionLabel?: string;
  actionUrl?: string;
  footer?: string;
}): string {
  const paragraphs = input.body
    .split('\n\n')
    .map(
      (block) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#1f2937;white-space:pre-wrap;">${escapeHtml(
          block,
        )}</p>`,
    )
    .join('');

  const button =
    input.actionUrl && input.actionLabel
      ? `<p style="margin:24px 0 0;">
           <a href="${escapeHtml(input.actionUrl)}"
              style="display:inline-block;padding:11px 20px;border-radius:6px;
                     background:${escapeHtml(input.brandColour)};color:#ffffff;
                     text-decoration:none;font-size:15px;font-weight:600;">
             ${escapeHtml(input.actionLabel)}
           </a>
         </p>`
      : '';

  const header = input.logoUrl
    ? `<img src="${escapeHtml(input.logoUrl)}" alt="${escapeHtml(input.businessName)}"
            style="max-height:36px;max-width:200px;display:block;" />`
    : `<span style="font-size:17px;font-weight:700;color:${escapeHtml(input.brandColour)};">
         ${escapeHtml(input.businessName)}
       </span>`;

  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:24px 12px;background:#f3f4f6;
             font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;
              overflow:hidden;border:1px solid #e5e7eb;">
    <div style="padding:20px 28px;border-bottom:1px solid #e5e7eb;">${header}</div>
    <div style="padding:28px;">
      <h1 style="margin:0 0 16px;font-size:19px;line-height:1.35;color:#111827;font-weight:600;">
        ${escapeHtml(input.heading)}
      </h1>
      ${paragraphs}
      ${button}
    </div>
    <div style="padding:16px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;">
      <p style="margin:0;font-size:12px;line-height:1.5;color:#6b7280;">
        ${escapeHtml(input.footer ?? `Sent by your AI receptionist for ${input.businessName}.`)}
      </p>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
