# Receptionist: https redirect and security headers (tickets)

Source: Cerberus T24 (GATE 3), first own-site smoke run 2026-10-27 00:37 (`~/security/logs/patrol-2026-10-27.log`). Colin chose "fix ticket" for all three non-PASS lines on 2026-10-27.
Host: `receptionist.atwoodsystems.co.uk` (Cloudflare proxied CNAME to the receptionist tunnel, Next.js app `apps/web`, prod unit `receptionist-app-prod`).

Findings (SAM checked with curl, 2026-10-27 01:10):
- `http://receptionist.atwoodsystems.co.uk/` answers `307` with `location: /login` and `x-powered-by: Next.js`. Cloudflare passes plain http to the app, so a visitor who types http:// stays on http, including the login page. This is the FAIL.
- `https://.../login` sends nosniff, X-Frame-Options DENY, Referrer-Policy and Permissions-Policy from `apps/web/next.config.ts` `headers()`, but no Strict-Transport-Security and no Content-Security-Policy. These are the two WARNs.
- In the atwoodsystems.co.uk zone, receptionist is the only proxied host. The apex and www are DNS-only to Vercel, which already answers http with a 308. So a zone-wide Cloudflare switch reaches receptionist only.
- SAM's Cloudflare connector has no zone-settings permission (403 on `settings/always_use_https`), so H1 is Colin's dashboard step.

Patrol rules the fix must meet (`~/security/live-smoke.sh`, HEADER RULES): http must answer 301 or 308 to `https://receptionist.atwoodsystems.co.uk/`; HSTS max-age at least 15768000; `Content-Security-Policy` must be present (the Report-Only header alone counts as MISSING).

## H1: Cloudflare upgrades http to https
Status: DONE 2026-10-27 01:35. Colin turned on Always Use HTTPS. SAM checked: http answers 301 to https, no loop (2 redirects, then 200 on /login), the apex and www are unchanged, live-smoke step 1 PASS. Colin rang VOLTA and the receptionist answered.
Blocked by: GATE (Colin): his own dashboard step, or a token with zone-settings write that he grants.
Steps:
1. SAM, read only first: confirm every Twilio voice and SMS webhook URL, and every other caller of this host (n8n, relay, errand caller), uses https. A 301 on a webhook POST can drop the call. Record the list.
   Done by SAM 2026-10-27 01:20:
   - Checked: no `http://receptionist.atwoodsystems...` literal in the platform code, `~/.sam/bin`, `~/.local/bin`, voice-line or `~/.cloudflared`.
   - Checked on 25 Oct, from a Twilio readback in the 2026-10-25 daily note: the VOLTA voice_url is `https://receptionist.atwoodsystems.co.uk/api/webhooks/twilio/voice`.
   - Inferred, not re-read today: sms_url and the env base URL (`NEXT_PUBLIC_APP_URL`, `TWILIO_WEBHOOK_BASE...`) use https, per the 2026-09-17 host move in [[AI Receptionist Platform]]. A live Twilio read is blocked because the amy-speed-test Twilio grant is not applied (waiting item w_745bb13b). The test call in the Proof covers this.
2. Colin: Cloudflare dashboard, zone atwoodsystems.co.uk, SSL/TLS, Edge Certificates, turn on "Always Use HTTPS".
Proof: `curl -sI http://receptionist.atwoodsystems.co.uk/` shows `301` with `Location: https://receptionist.atwoodsystems.co.uk/`; one test call to the VOLTA number still reaches the receptionist.

## H2: HSTS header from the app
Status: DONE 2026-10-27 (code, branch `fix/https-headers`; not deployed). `Strict-Transport-Security: max-age=31536000` is in `apps/web/src/lib/security-headers.ts` and sent by `next.config.ts` `headers()` on `/:path*`. Test `apps/web/src/lib/security-headers.test.ts` (`pnpm --filter ./apps/web test`) failed against the old header set and passes now. The live curl and `live-smoke.sh` proof waits on the Deploy gate.
Depends on: H1 live (HSTS before the redirect is pointless, and pinning https before it is proven is the wrong order).
Files: `apps/web/next.config.ts` (the `headers()` block only)
Steps:
1. Add `{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }`. No `includeSubDomains` (the zone holds the mail subdomains `send.` and anything else Colin adds later) and no `preload`.
2. A test that fails before and passes after: a vitest case (or a script under `scripts/`) that imports the config, calls `headers()` and asserts the HSTS entry and its max-age is at least 15768000.
Proof: the test passes; after deploy, `curl -sI https://receptionist.atwoodsystems.co.uk/login` shows the header; `live-smoke.sh --host receptionist.atwoodsystems.co.uk` shows `PASS header Strict-Transport-Security`.

## H3: Content-Security-Policy
Status: BUILT, Report-Only; enforcing switch waits on Colin. 2026-10-27, branch `fix/https-headers`, not deployed. `middleware.ts` sends `Content-Security-Policy-Report-Only` with a per-request nonce, and the policy is built in `apps/web/src/lib/security-headers.ts`. Step 3 is changing `CSP_REPORT_ONLY_HEADER` there to `Content-Security-Policy` (and the test's expectation). The patrol keeps WARNing until then.
Files: `apps/web/next.config.ts` and/or `apps/web/src/middleware.ts` (a nonce needs middleware)
Steps:
1. Inventory, read only: every origin the browser loads from or connects to on each page (scripts, styles, fonts, images, `connect-src` for Supabase realtime and auth through the tunnel, any Twilio or ElevenLabs client calls). List it in this ticket before writing a policy.
   Done by Hephaestus 2026-10-27, from the code on `fix/https-headers` (no live requests). Pages in scope: `/`, `/login`, `/app`, `/app/[slug]` and its sections (conversations, conversation view, leads, appointments, analytics, knowledge, settings), `/auth/callback`, `/auth/confirm`.
   - Scripts: same origin only. Next's own `/_next/static/*` chunks plus the inline RSC/bootstrap scripts Next writes into every page (these need the nonce). No `next/script`, no third-party tag, no analytics, no `dangerouslySetInnerHTML`. Dev only: React needs `'unsafe-eval'`.
   - Styles: same origin `/_next/static/css/*` (Tailwind v4 via PostCSS, compiled at build). Inline `style="..."` attributes are everywhere (React `style={{...}}` in `ui.tsx`, `tenant-nav.tsx`, every page, and the tenant brand variables on the shell in `app/[slug]/layout.tsx`). A nonce cannot cover style attributes, so style-src needs `'unsafe-inline'` (styles only, not scripts).
   - Fonts: none loaded. System stack in `globals.css` (`-apple-system ... Arial`), no `next/font`, no font CDN.
   - Images: same origin `app/icon.svg` (favicon). The tenant logo in `app/[slug]/layout.tsx` is a plain `<img src={business_profiles.logo_url}>`, a tenant-supplied URL on any host, so img-src needs `https:`. `data:`/`blob:` kept per Next's documented default. No `next/image`.
   - connect-src: same origin only. The one browser `fetch` is `conversation-actions.tsx` to `/api/dashboard/conversations/...`. Next's RSC navigation and server-action POSTs are same origin. The browser Supabase client (`lib/supabase/browser.ts`) is defined but imported nowhere, so there is no browser Supabase auth or realtime today. Login is a server action and Supabase calls are server side to 127.0.0.1:54321. If realtime is wired up later, add the origin of `NEXT_PUBLIC_SUPABASE_URL` (https and wss) to connect-src. Dev HMR (`/_next/webpack-hmr` websocket) is same host and covered by `'self'`.
   - Twilio and ElevenLabs: no browser calls. ConversationRelay `wss://<host>/...` (`lib/conversation-relay.ts`) is Twilio to server, and the webhooks are under `/api/`, which middleware skips anyway.
   - Forms: all post to self (login, settings server actions, the conversations and leads GET filters). The magic link lands on `/auth/v1/verify` on this host (rewritten to the local stack), then `/auth/callback`. That is navigation, not a fetch.
   - Frames, objects, workers, manifests: none.
2. Ship as `Content-Security-Policy-Report-Only` first, with `default-src 'self'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `object-src 'none'`, plus the inventory. Use a per-request nonce for Next's inline scripts, not `'unsafe-inline'` for scripts.
3. Colin uses the dashboard on his phone and desktop for a day. No violations means switch to the enforcing header. The patrol WARNs until the enforcing header ships.
4. A test that fails before and passes after: assert the header exists and carries `default-src 'self'` and `frame-ancestors 'none'`.
Proof: the test passes; no CSP console errors on login, dashboard, calls and settings pages (A16 and desktop); `live-smoke.sh` shows `PASS header Content-Security-Policy`.

## Deploy (H2 and H3)
Status: TODO (GATE: Colin)
GATE (Colin): build and restart `receptionist-app-prod` (5 to 10 s outage, only with no live call). Then run `live-smoke.sh --host receptionist.atwoodsystems.co.uk` and read its report; the next monthly own-site patrol run confirms it on its own.
