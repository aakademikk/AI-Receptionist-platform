# Review 2026-10-27: AI receptionist (errand, relay, core, web)

Status: COMPLETE. All 195 files in scope were read in full; nothing was sampled or skipped.

- Branch: `cloud/review-20261027`, cut from `origin/restyle/glassmorphism` at `d718202`.
- Review only: no source file, test, ticket or spec was changed. Proof scripts and the one mutation
  run lived in the reviewer's scratchpad, outside the repo; their code and output are quoted below.
- No live request of any kind (no Twilio, Supabase, Gemini, Telegram, no URL scanned). Network was
  used only for `pnpm install`, `pnpm audit` and downloading the gitleaks binary.
- No `.env` file, key file or secret value was read or printed. Variable names only.

## Summary

| severity | count | ids |
|---|---|---|
| Blocking | 1 | R1 (dependency audit: 5 Critical, 9 High, all under `apps/web > next`) |
| High | 3 | R2 (errand Go can be re-targeted), R3 (second emergency alerts nobody), R4 (public auth signup, UNPROVEN) |
| Medium | 8 | R5 to R12 |
| Low | 13 | R13 to R25 |

No secret in the working tree or the git history. RLS is on for every table, anon has no grants,
every view is `security_invoker`. Every Twilio-facing route verifies the signature before it reads
or writes anything. The production web bundle carries no source maps and no server secret names.

On the errand caller's three guarantees (spec must-dos 3, 10 and OPEN 14):

1. "Nothing dials without Colin's Go for that exact read-back": holds against anything outside the
   box, and against a Go that is missing, Cancel, expired, used or answered by anything but the bridge.
   It does not hold against an edit of the errand folder after the Go (R2): the Go can be moved to
   another number or brief.
2. "Amy gives only Colin's name and mobile": holds in code (`checkAmyLine`), with the gaps that a
   number read out as words is not caught, and that payment terms like fees and holds are missed (R7).
3. "The after-hours override cannot be reached without the brief flag and a matching Go": the flag
   is required, but because of R2 it can be added after the Go. Fixing R2 closes this too.

## Baseline (before any reading)

Node: `~/.local/node/bin` does not exist in this container. The system Node is v22.22.0, which
strips types correctly (no `ERR_NO_TYPESCRIPT`); every command below ran on it.

| package | test | typecheck |
|---|---|---|
| `@atwood/core` | 284 pass, 0 fail (55 suites) | clean |
| `@atwood/relay` | 86 pass, 0 fail (14 suites) | clean |
| `@atwood/errand` | 249 pass, 0 fail (61 suites) | clean |
| `@atwood/web` | no test script | clean |

The counts match the last recorded ones (core 284, relay 86, errand 249).

Web build: `pnpm --filter @atwood/web build` with no secret in the environment and no `.env*` file
that Next loads (only `.env.example` exists, which Next does not read): exit 0. `.next/static` holds
0 `.map` files, no `sourceMappingURL`, and none of `SUPABASE_SERVICE_ROLE_KEY`, `TWILIO_AUTH_TOKEN`,
`INTERNAL_API_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `service_role`.
The build output is git-ignored; `git status` was clean afterwards.

## Static security results

- **Secrets, git history:** gitleaks 8.21.2, `gitleaks detect --log-opts=--all --redact`: 72 commits
  scanned, no leaks found. **Working tree:** `gitleaks detect --no-git --redact`: no leaks found.
  Pattern search over the full history (`git log --all -p`) for Twilio SIDs (`AC`/`SK` + 32 hex),
  Google keys (`AIza...`), Telegram bot tokens, JWTs, `sk-...` and `sb_secret_...`: no match.
  `apps/errand/deploy/keystore-rows.tsv` holds names only (each grant value equals its name).
  `supabase/config.toml` SMTP password is `env(RESEND_API_KEY)`, not a literal.
- **Dependency audit:** `pnpm audit --prod`: 20 vulnerabilities (1 low, 5 moderate, 9 high,
  5 critical). Every High and Critical is under `apps/web > next`; see R1.
- **Unauthenticated routes:** in app code, none mutates data or reads personal data (see "Checked and
  fine"). The exception is the GoTrue API proxied publicly by `next.config.ts` (R4).
- **Supabase RLS:** all 27 `public` tables have `enable row level security`
  (`0008_row_level_security.sql:57-83`; the four PII tables also `force`), `0008:31-36` revokes all
  tables, functions and sequences from `anon`, and all seven views are `with (security_invoker = true)`.
  The 13 RPCs are revoked from `public, anon, authenticated` (`0009:850-875`); `0014` replaces
  `resolve_inbound` with the same signature, so its ACL is kept. No table is anon-reachable with RLS off.
- **Twilio signatures:** every Twilio-facing route verifies before doing anything: web
  `api/webhooks/twilio/{sms,status,elevenlabs-trial,voice,voice/relay,voice/gather,voice/missed,voice/outbound,voice/status}`,
  errand `/errand/{twiml,status,ws}`, relay upgrade. Residual risk on the two sockets: R14, R15.
- **Production bundle:** see the build line above.

## Files read

### `apps/errand` (59 of 59, read in full)

README.md, SAM.md, package.json, tsconfig.json;
deploy/: RUNBOOK.md, atwood-errand.service, errand, errand-prune.service, errand-prune.timer,
keystore-rows.tsv, tunnel-rule.yml;
src/: boundary.test.ts, brief.ts, brief.test.ts, cli.ts, cli.test.ts, config.ts, deploy.test.ts,
dial.ts, dial.test.ts, go.ts, go.test.ts, guardrails.ts, guardrails.test.ts, prompt.ts,
prompt.test.ts, prune.ts, prune.test.ts, readback.ts, readback.test.ts, report.ts, report.test.ts,
server.ts, server.test.ts, session.ts, session.test.ts, signature.ts, signature.test.ts, status.ts,
status.test.ts, store.ts, store.test.ts, turn.ts, turn.test.ts, twilio-call.ts, twilio-call.test.ts,
twiml.ts, twiml.test.ts, watch.ts, watch.test.ts, testing/fixtures.ts,
guards/: batch.ts, batch.test.ts, hours.ts, hours.test.ts, live.ts, live.test.ts, number.ts, number.test.ts.

### `apps/relay` (10 of 10, read in full)

README.md, atwood-relay.service, package.json, tsconfig.json, src/protocol.ts, src/protocol.test.ts,
src/server.ts, src/server.integration.test.ts, src/signature.ts, src/signature.test.ts.

### `packages/core` (66 of 66, read in full)

package.json, tsconfig.json, src/index.ts, src/env.ts, src/env.test.ts;
ai/: anthropic.ts, google.ts, google.test.ts, index.ts, openai.ts, provider.ts;
crypto/: secrets.ts;
domain/: booking.ts, closing.ts, closing.test.ts, context.ts, context.test.ts, handover.ts,
handover.test.ts, index.ts, lead.ts, notify.ts, onboarding.ts, pipeline.ts, reply.ts, self-message.ts,
self-message.test.ts, source.ts, source.test.ts, turn-timings.ts, turn-timings.test.ts, voice.ts, voice.test.ts;
integrations/: elevenlabs-register.ts, elevenlabs-register.test.ts, email.ts, firecrawl.ts,
google-calendar.ts, index.ts, twilio.ts, twilio.test.ts, voice-test-variant.ts, voice-test-variant.test.ts;
prompts/: extraction.ts, index.ts, onboarding.ts, receptionist.ts, receptionist.test.ts, receptionist.behaviour.test.ts;
supabase/: admin.ts, admin.test.ts; testing/: fake-provider.ts, fake-supabase.ts; types/: domain.ts;
utils/: errors.ts, errors.test.ts, hours.ts, hours.test.ts, index.ts, logger.ts, phone.ts, redact.ts,
sms.ts, sms.test.ts, speech.ts, speech.test.ts.

### `apps/web` (60 of 60, read in full)

next.config.ts, package.json, postcss.config.mjs, tsconfig.json;
src/middleware.ts;
src/lib/: auth-redirect.ts, conversation-relay.ts, internal-auth.ts, tenant.ts, twilio-webhook.ts,
supabase/browser.ts, supabase/server.ts;
src/components/: conversation-actions.tsx, tenant-nav.tsx, ui.tsx;
src/app/: layout.tsx, page.tsx, globals.css, icon.svg, login/page.tsx, auth/callback/route.ts,
auth/confirm/route.ts, app/page.tsx, app/[slug]/{layout.tsx, page.tsx, analytics/page.tsx,
appointments/page.tsx, conversations/page.tsx, conversations/[conversationId]/page.tsx,
knowledge/page.tsx, leads/page.tsx, settings/page.tsx};
src/app/api/: health/route.ts, revalidate/route.ts,
dashboard/conversations/[conversationId]/[action]/route.ts,
internal/v1/{analytics/rollup, bookings/create, bookings/slots, businesses/[businessId]/context,
calls/missed, calls/originate, conversations/[conversationId]/handover,
conversations/[conversationId]/memory, conversations/[conversationId]/resume,
conversations/[conversationId]/takeover, leads/extract, maintenance/purge, messages/inbound,
messages/send, notifications/drain, onboarding/[jobId]/run}/route.ts,
webhooks/twilio/{elevenlabs-trial, sms, status, voice, voice/gather, voice/missed, voice/outbound,
voice/relay, voice/status}/route.ts.

**Total: 195 of 195 files read** (59 + 10 + 66 + 60).

Also read in full: `implementation/errand-caller-spec.md`. Read in part, outside the scope, only where
a finding or a check needed it: `supabase/config.toml` (auth section), `supabase/migrations/0002`
(api_keys, users trigger), `0006` (notifications dedupe index), `0008` (RLS, grants), `0009`
(`enqueue_notification`, `resume_ai`, grants loop), `0010` (views), `0014` (`resolve_inbound`),
`implementation/amy-speed-test-tickets.md` and `errand-caller-facts.md` (how production runs).

## Findings, by severity

### R1 (Blocking). Next.js 16.2.12 carries 5 Critical and 2 High advisories; its postcss, sharp, nanoid and source-map-js carry 7 more High

`apps/web/package.json:17` (`"next": "^16.2.12"`, installed 16.2.12). Delivery-gate bar: any High or Critical.

Evidence (`pnpm audit --prod --json`, High and Critical only, with the path):

| severity | package (installed) | advisory | fixed in | path |
|---|---|---|---|---|
| Critical | next 16.2.12 | GHSA-2xp9-vwfh-vxw4 Unauthenticated RCE in Image Optimization API | >=16.3.3 | apps/web > next |
| Critical | next 16.2.12 | GHSA-2464-fhr4-w9xw Unauthenticated RCE in Image Optimization API | >=16.4.1 | apps/web > next |
| Critical | next 16.2.12 | GHSA-673q-mjm6-r5xr Unauthenticated RCE in `use cache` function | >=16.4.1 | apps/web > next |
| Critical | next 16.2.12 | GHSA-vcvr-r3jv-pc5j RCE in next/og ImageResponse | >=16.3.6 | apps/web > next |
| Critical | next 16.2.12 | GHSA-p293-qw3h-jr36 Unauthenticated RCE on Windows-hosted servers | >=16.3.3 | apps/web > next |
| High | next 16.2.12 | GHSA-cjq9-62q9-8jv4 SSRF in Image Optimization | >=16.3.8 | apps/web > next |
| High | next 16.2.12 | GHSA-p3m5-59mp-jv5r DoS in App Router using Server Actions | >=16.4.1 | apps/web > next |
| High | postcss 8.4.31 | GHSA-6g55-p6wh-862q arbitrary file read | >=8.5.12 | apps/web > next > postcss |
| High | postcss 8.4.31 | GHSA-r28c-9q8g-f849 path traversal in source map auto-loading | >=8.5.18 | apps/web > next > postcss |
| High | sharp 0.34.5 | GHSA-f88m-g3jw-g9cj libvips CVEs | >=0.35.0 | apps/web > next > sharp |
| High | sharp 0.34.5 | GHSA-rgj7-g3m4-5g8c libheif | >=0.35.4 | apps/web > next > sharp |
| High | sharp 0.34.5 | GHSA-wq5f-xc86-pv6w librsvg | >=0.35.5 | apps/web > next > sharp |
| High | nanoid 3.3.16 | GHSA-2v37-7h3g-55p8 infinite loop on size 0 | >=3.3.18 | apps/web > next > postcss > nanoid |
| High | source-map-js 1.2.1 | GHSA-68fv-2mgg-jv7q event-loop DoS | >=1.2.2 | apps/web > next > postcss > source-map-js |

Relevance: the app does not use `next/image`, `next/og` or `use cache`, and runs on Linux, but the
Image Optimization endpoint (`/_next/image`) is served by default by `next start`/standalone whether or
not the app uses it, and the app is on a public hostname. The app does use Server Actions (login,
settings). Fix: upgrade `next` to >= 16.4.1, re-run `pnpm audit --prod`, and add `pnpm.overrides` for
any of postcss/sharp/nanoid/source-map-js still below the fixed version; until then set
`images: { unoptimized: true }` so `/_next/image` is not served.

### R2 (High). An errand Go can be moved to a different number, brief or after-hours flag by editing the errand folder

`apps/errand/src/go.ts:126-161`, with `apps/errand/src/dial.ts:100-114`.

What is wrong. The only link between what Colin saw (the bridge's question text in
`~/.sam/jobs/<job>/closer.json`) and the brief that is dialled is `readback.json`, which sits in the
errand folder next to `brief.json` and is written by the same CLI SAM runs. `checkGo` checks that the
bridge text equals `readback.questionText` and that the brief on disk hashes to `readback.briefHash`;
it never checks that the brief on disk renders to the text Colin tapped Go on. So an edit of
`brief.json` plus a matching edit of `readback.json` (`briefHash`, `dialNumber`) keeps the Go valid.
The number guard compares against `readback.dialNumber` from the same file. This breaks must-do 3a
("any edit after the read-back voids it") and the T34 guarantee: `afterHours: true` can be added after
the Go. The module comment (`go.ts:22`) says "Nothing SAM writes in the errand folder can turn a
non-Go into a Go"; true, but it can re-target an existing one.

Evidence (scratch test, fakes only):

```ts
const id = await readBackAndGo(paths);                       // read-back for 020 7946 0123, Colin taps Go
const edited = { ...readBrief(id, home), number: '020 7946 0999', afterHours: true };
writeBrief(id, edited, at(90), home);                         // edit after the Go
rb.briefHash = briefHash(validateBrief(edited).brief);        // readback.json, same folder
rb.dialNumber = '+442079460999';                              // questionText left as Colin saw it
const result = await dial(id, {}, h.deps);
assert.equal(result.code, 0);
assert.deepEqual(h.creates, [{ errandId: id, to: '+442079460999' }]);
```
```
ok 1 - R: a Go can be moved to a different brief by rewriting readback.json
```

Why High and not Blocking: it needs a deliberate write to two files under `~/.sam`, which only a
process running as `col` can make (the spec accepts a convention-and-permissions proof, facts A5). But
it is exactly the hole the Go design exists to close, and SAM writes files in that folder.
Fix: in `checkGo`, re-render from the brief on disk and require
`questionTextFor(renderReadback(brief, normaliseUkNumber(brief.number).e164)) === question.text`
(the bridge's copy), and dial the number derived there rather than `readback.dialNumber`.

### R3 (High). A second emergency on a resumed conversation alerts nobody, while the customer is told the team is on it

`packages/core/src/domain/pipeline.ts:730-731` (and the same key in
`apps/web/src/app/api/internal/v1/conversations/[conversationId]/handover/route.ts:106`), with
`supabase/migrations/0006_notifications_ai_analytics.sql:77-79` and `0009_rpc_functions.sql:504-508`.

What is wrong. The owner's handover alert uses `dedupeKey: handover:<conversationId>:<reason>`.
`enqueue_notification` appends the recipient id and inserts with `on conflict (business_id, dedupe_key)
do nothing` against a permanent unique index. The dashboard's "Hand back to the assistant"
(`components/conversation-actions.tsx:72` > `api/dashboard/.../resume` > `internal/v1/.../resume` >
`resume_ai`, `0009:435-452`) sets the conversation back to `active`, and `resolve_inbound` reuses any
`active` conversation for the same caller and channel (`0014:145-152`). So the next emergency from that
caller on that thread takes the handover path, the customer reads or hears "I'm passing this to the
team right now" (`handover.ts:280`), `enqueue_notification` inserts nothing, and no email, SMS or
webhook goes out. A manual re-escalation from the dashboard has the same problem.

Evidence (the three pieces that combine):

```ts
// pipeline.ts:730
    dedupeKey: `handover:${input.conversationId}:${input.reason}`,
```
```sql
-- 0006:77
create unique index notifications_dedupe_idx on public.notifications (business_id, dedupe_key) where dedupe_key is not null;
-- 0009:504-508
case when p_dedupe_key is null then null else p_dedupe_key || ':' || e.id::text end
... on conflict (business_id, dedupe_key) where dedupe_key is not null do nothing
-- 0009:445-449 resume_ai
set status = 'active', ai_enabled = true, confusion_count = 0, handover_reason_code = null, handover_at = null
```

Not run against a database (no live request allowed). What would prove it end to end: on a scratch
local stack, two emergency messages on one thread with a resume between them, then count
`notifications` rows with `event = 'handover_required'` (expect one per recipient, not two).
Fix: make the key per escalation, for example `handover:<conversationId>:<inbound message id>`, so
each escalation alerts once and a retried webhook still dedupes.

### R4 (High, UNPROVEN; Blocking if confirmed). The public hostname proxies Supabase Auth with sign-up enabled

`apps/web/next.config.ts:65-72` (rewrite `/auth/v1/:path*` to `http://127.0.0.1:54321/auth/v1/:path*`),
`supabase/config.toml:53` (`enable_signup = true`) and `:56` (`[auth.email] enable_signup = true`,
`enable_confirmations = true`, mail sent through Resend).

What is wrong. The login page deliberately calls `signInWithOtp` with `shouldCreateUser: false`, and
its comment names the reason: otherwise "an unknown address silently creates a new auth.users row — an
unauthenticated write and outbound-mail surface on a public URL" (`login/page.tsx:41-44`). The
rewrite exposes the whole GoTrue API on the same public hostname, so `POST /auth/v1/signup` is reachable
directly, where that guard does not apply: it creates an `auth.users` row (and a `public.users` row via
`handle_new_auth_user`) and sends a confirmation email from the platform's sending domain to any address.
A new user has no membership, so RLS shows them no tenant data.

Why UNPROVEN: proving it needs a live request, which this review may not make. GoTrue behind Kong also
needs an `apikey`; whether the live stack uses the default local anon key, and whether the running auth
container has sign-up on, are facts on the box. What would prove it: `GOTRUE_DISABLE_SIGNUP` in the
auth container's environment, or the `[auth]` section the live stack was started with.
Fix: set `enable_signup = false` in both `[auth]` and `[auth.email]` (invites are created with the
service role anyway), and narrow the rewrite to the paths the magic link needs (`/auth/v1/verify`).

### R5 (Medium). The window's date is not enforced in code; an errand booking on another day ends "booked"

`apps/errand/src/turn.ts:159-167`, `apps/errand/src/guardrails.ts:130-143`, `apps/errand/src/prompt.ts:77`.

What is wrong. `checkAgreedTime` rejects another date only when the model's `agreedTime` carries one
(`YYYY-MM-DD HH:MM`). The prompt asks for `"agreedTime": "HH:MM"`, so in practice no date is given and
the date half of must-do 9 rests on the prompt alone. The outcome then reports the brief's date
(`turn.ts:198`), so Colin is told "Booked for Wed 28 Oct" for a Thursday booking.

Evidence:

```ts
const model = async () => ({ say: 'Lovely, thank you, goodbye.', agreedTime: '19:30', done: 'booked', nameBookedUnder: 'Colin Wood' });
const result = await nextTurn(state, "We're full Wednesday, but Thursday at half seven is booked for you.", { model });
assert.equal(result.end?.kind, 'booked'); assert.equal(result.end?.date, '2026-10-28');
```
```
ok 3 - R: the window date is not enforced in code
```

Fix: require `agreedDate` (`YYYY-MM-DD`) in the schema next to `agreedTime` and refuse `booked` unless it
equals `window.date`.

### R6 (Medium). An errand call-create timeout settles "not reached", hiding the real outcome and blinding the live guard and the watchdog

`apps/errand/src/dial.ts:144-150`.

What is wrong. The create is abandoned at 15 s, and the code's own comment (`twilio-call.ts:31-33`)
says Twilio may still have placed the call and that "the status callback is what settles a call whose
create timed out". But on `failure: 'timeout'` the dial step writes `outcome.json` = not reached
"failed to place" (write-once) and reports it at once (claiming `reported.json`). If the call was in
fact placed, the session's real outcome (booked, payment asked) and the status callback are refused by
the write-once files, and Colin is told "not reached" for a call that happened. No `dialled` event is
written either, so `checkNoLiveErrand` does not see the call and no watchdog is scheduled.

Evidence:

```ts
h.deps.createCall = async () => ({ ok: false, failure: 'timeout', message: 'x' });
await dial(id, {}, h.deps);                                    // code 1, outcome not_reached, reported
writeOutcome(id, { kind: 'booked', ... }, home)                // -> false (the session's outcome is refused)
await handleStatus(id, { CallStatus: 'completed', CallDuration: '120' }, ...).reported;
assert.equal(readOutcome(id, home)?.kind, 'not_reached');
assert.equal(sent[0][0], "Errand: Luigi's: not reached");      // the one message Colin gets
```
```
ok 4 - R: a create timeout settles "not reached" and hides the real outcome
```

Fix: on `timeout` only, append a `dial_ambiguous` event that the live guard treats as `dialled`,
schedule the watchdog, and leave `outcome.json` to the status callback or the watchdog.

### R7 (Medium). The errand payment check misses fees, holds and minimum spends, and Amy may agree to them

`apps/errand/src/guardrails.ts:46-54` (their words) and `:101-103` (Amy's line).

Must-do 11 says the ring-off on a payment ask is enforced in code. A card hold or a no-show fee is a
payment ask, but no pattern matches "fee", "charge", "hold", "minimum spend" or a money amount, and
`BEYOND_GOAL` does not either.

Evidence:

```
"There is a twenty pound no-show fee per person, is that ok?"   { kind: 'ok' }
"We need to take a ten pound hold to secure it."                { kind: 'ok' }
"It is a fifty pound minimum spend, charged if you do not show." { kind: 'ok' }
"Yes, that is fine, Colin accepts the no-show fee."             { ok: true }
"Yes, the minimum spend is fine."                               { ok: true }
```

Fix: add `fee|charge[ds]?|hold|minimum spend|£\s?\d|\d+\s?(pounds?|quid)` to the payment patterns and
to `BEYOND_GOAL`, with tests.

### R8 (Medium). Open redirect after sign-in: `next=/\evil.example` passes `sanitiseNext`

`apps/web/src/lib/auth-redirect.ts:30-36`, used by `app/auth/callback/route.ts:22,36` and
`app/auth/confirm/route.ts:27,41`; also `app/login/page.tsx:25` passes `next` to `redirect()` unchecked.

What is wrong. `sanitiseNext` rejects `//host` but not `/\host` or `/<tab>/host`; the URL parser treats
`\` as `/` and drops tabs, so `new URL(next, base)` leaves the origin.

Evidence:

```
"/\\evil.example/x" -> "/\\evil.example/x" -> https://evil.example/x
"/\t/evil.example"  -> "/\t/evil.example"  -> https://evil.example/
"//evil.example"    -> "/app"              -> https://receptionist.atwoodsystems.co.uk/app
```

Path: a victim opens `https://receptionist.atwoodsystems.co.uk/login?next=/%5Cevil.example`, asks for a
link, and after the genuine sign-in lands on `evil.example` (a convincing phishing page, "your session
expired"). With `/auth/confirm` an attacker can also mail a victim a link built on the attacker's own
token, which signs the victim in as the attacker and then redirects. `login/page.tsx:25` is covered for
signed-in users by the middleware redirect (`middleware.ts:59-64`), which fails open when the Supabase
variables are missing (`:26`). Fix: accept only `^/(?![/\\])[^\s]*$` after decoding, or compare
`new URL(next, base).origin === base` and fall back to `/app`; use the same helper in `login/page.tsx`.

### R9 (Medium). `isOpenNow` is wrong after midnight on any shift that crosses it

`packages/core/src/utils/hours.ts:29-46`.

The check reads only today's row. After midnight, the shift still running belongs to yesterday's row,
which is never consulted, and today's overnight row is treated as open from 00:00. This drives the
prompt's open/closed line (`prompts/receptionist.ts:57,127`), the after-hours SMS template
(`receptionist.ts:486-490`) and booking slots (`domain/booking.ts:91-92`).

```
Sat 01:00 London (Fri shift 20:00-02:00, Sat closed): open = false     (should be true)
Sat 01:00 London (only Sat 20:00-02:00, Fri closed): open = true       (should be false)
```

The test (`hours.test.ts:49-55`) checks only 22:00 on the opening day. Fix: for an overnight row,
`nowMinutes < closes` should consult the previous day's row, and today's row should need `nowMinutes >= opens`.

### R10 (Medium). `normalizePhone` keeps the trunk zero of `+44 (0)20 ...`

`packages/core/src/utils/phone.ts:55-63`.

```
"+44 (0)20 7946 0123" -> +4402079460123
"+44 020 7946 0123"   -> +4402079460123
"020 7946 0123"       -> +442079460123
```

`+44 (0)...` is how UK numbers are commonly printed. Every model-transcribed lead phone goes through
this (`domain/lead.ts:180-183`), so a lead's number and the callback number in the owner's alert can be
stored undiallable; `calls/originate` also dials through it (`route.ts:144`). The SQL `normalize_phone()`
that must agree was not checked (outside scope). Fix: on the `+` branch, drop a `0` straight after `44`.

### R11 (Medium, latent). Tenant API keys are not held to their tenant on two routes, and scopes are never checked

`apps/web/src/app/api/internal/v1/calls/missed/route.ts:30-46` and
`internal/v1/messages/inbound/route.ts:31-81` (no `assertBusinessScope`); `lib/internal-auth.ts:91`
(returns `scopes`, which no route reads); `internal/v1/messages/send/route.ts:44,83-88`
(`sent_by_user_id` from the body, unchecked).

What is wrong. `internal-auth.ts:26-33` says a tenant API key "must never be able to act on another
tenant". These two routes take `to_number` from the body and run the tenant pipeline for whichever
tenant owns it: a key for tenant A can make tenant B text any `from_number` it chooses from B's number
(missed-call template, or an AI reply), create B's contacts and conversations, and alert B's owner.
A key with `scopes = ['read']` (the column default, `0002:178`) can call every POST route. On
`messages/send`, a key can attribute a message to, and assign the conversation to, any user id.

Latent: no code mints tenant keys (`api_keys` has no insert grant to tenants; only the service role
can create one), so today only the platform-wide shared secret is in use. Fix: resolve the tenant from
`to_number` and call `assertBusinessScope` before running the pipeline; check `scopes`; verify
`sent_by_user_id` is a member, as `takeover/route.ts:34-43` does.

### R12 (Medium, UNPROVEN). Dashboard actions call the internal API at `request.url`'s origin, which behind the tunnel is `https://localhost:3001`

`apps/web/src/app/api/dashboard/conversations/[conversationId]/[action]/route.ts:95-99` and `:146-151`.

What is wrong. The route builds its target from `new URL(request.url).origin` and sends
`x-atwood-secret` there. The codebase's own comments say that behind the tunnel `request.url` reports
`https://localhost:3001` (`lib/twilio-webhook.ts:101-105`, `lib/auth-redirect.ts:12-15`,
`calls/missed/route.ts:146-148`); every other route avoids it through `publicOrigin()`. An HTTPS fetch to
the plain-HTTP app port fails, so Take over, Reply, Hand back and Pause would all answer 500 when the
dashboard is used through the public hostname. Separately, the internal secret goes to whatever origin
`request.url` names, so a future proxy or runtime that derives it from the `Host` header would hand the
secret to a client-chosen host.
What would prove it: tap "Pause the assistant" on the public hostname and look for `fetch failed` or a
500. Fix: call the internal handlers in-process, or target a fixed loopback origin
(`http://127.0.0.1:${PORT}`), never one derived from the request.

### R13 (Low). The errand one-at-a-time guard is check-then-act across two errands

`apps/errand/src/dial.ts:118` and `:139-152`, `apps/errand/src/guards/live.ts:15-24`.
`checkNoLiveErrand` looks for a `dialled` event, written only after the create returns. Two dials for two
errands started together both pass and both create.

```ts
const [ra, rb] = await Promise.all([dial(a, {}, h.deps), dial(b, {}, h.deps)]);   // create takes 50 ms
assert.equal(h.creates.length, 2);
```
```
ok 2 - R: the live guard races across two errands
```

Low because SAM dials one errand at a time. Fix: an exclusive lock file (`ERRAND_HOME/.dialling`, `wx`)
from the first guard to the `dialled` event.

### R14 (Low, UNPROVEN as an attack). The errand socket trusts the setup frame's errand id and mode

`apps/errand/src/session.ts:154-182`, `apps/errand/src/signature.ts:64-75`.
The socket signature is `HMAC(token, url)` with no body, so it is the same value on every call. Whoever
holds one copy can open `/errand/ws` at any time, and `setup` with `mode: 'voicemail'` writes the
write-once `outcome.json` = voicemail left for any existing errand, masking the real outcome. It needs a
leaked signature (see R15 for how one could leak). Fix: accept a setup only for an errand with a
`dialled` event and no outcome, and match the frame's `callSid` against the full CallSid stored at dial
time (store it in full, mask it only in output).

### R15 (Low, partly UNPROVEN). The relay trusts the setup frame, its handshake signature is a fixed value, and debug logging writes that value to the journal

`apps/relay/src/protocol.ts:480-521` and `:587-596`, `apps/relay/src/signature.ts:126-140`,
`packages/core/src/integrations/twilio.ts:603-609`.

A replayed relay signature lets anyone run the tenant pipeline for any tenant number taken from the
setup frame (`to`, `from`, `callSid` go straight to `replyToCaller`), and `recordInterruptedTurn` rewrites
the metadata of any outbound message found by `callSid`. How a copy could leak (proven part): with
`LOG_LEVEL=debug`, core logs the `expected` signature on every check, accepted or rejected
(throwaway test token):

```
{"level":"debug","message":"Twilio signature payload",...,"payload":"wss://receptionist.example/relay",...,"expected":"<the valid signature>","presented":"wrong"}
```

`expected` and `presented` are not in `redact.ts`'s `SECRET_KEYS`. Debug is off by default
(`env.ts:323`). UNPROVEN: that the live relay or web app ever ran at debug. Fix: log the payload length
only, never `expected`; and bind the socket to the call with a per-call HMAC `<Parameter>` in the signed
TwiML, checked against the setup frame's `callSid`.

### R16 (Low). `requireTwilioBase` accepts plain `http://` and the global host with a trailing dot

`apps/errand/src/config.ts:168-183`.

```
https://api.twilio.com./2010-04-01 -> https://api.twilio.com./2010-04-01
http://api.dublin.ie1.twilio.com/2010-04-01 -> http://api.dublin.ie1.twilio.com/2010-04-01
```

The value is fixed in the unit and the wrapper. Fix: require `https:` and strip a trailing dot first.

### R17 (Low). The errand Go-expiry comment and code disagree; a Go can be used up to an hour after the read-back

`apps/errand/src/config.ts:27` says "Measured from the Go question's creation"; `go.ts:155-156` measures
`now - answeredAt < 30 min` and separately allows `answeredAt - createdAt <= 30 min`, so a read-back at
14:00, Go at 14:29 and dial at 14:58 passes. Fix: Colin to decide which clock; make comment, code and a
test agree.

### R18 (Low). `RELAY_MAX_TURNS` set to a non-number switches the hard turn limit off

`apps/relay/src/server.ts:133`, `protocol.ts:376`, `:633`. `Number.parseInt('forty', 10)` is `NaN`,
`?? 40` keeps it, and `turns >= NaN` is never true. Fix: `Number.isFinite(n) && n > 0 ? n : 40`.

### R19 (Low). The relay journal holds what callers say

`apps/relay/src/protocol.ts:534` (`prompt_partial` `text`) and `:554` (`prompt_final` `text`), logged at
info by `server.ts:139`. `redactText` strips emails, phone numbers, postcodes and card numbers, but
names, addresses and the rest go to journald, outside `erase_contact()` and retention.
Fix: log length and turn, not words, or log them at debug.

### R20 (Low). A caller ringing back on a handed-over thread is never re-escalated, even for an emergency

`packages/core/src/domain/handover.ts:123-125` with `domain/pipeline.ts:488-520`. On a callback call the
conversation is `waiting_for_human`, so nothing escalates; the owner gets a plain `new_message` alert,
not an urgent `handover_required`. The prompt tells the model to say 999 (`receptionist.ts:430`).
Fix: run the emergency patterns on callback turns and send an urgent alert on a hit.

### R21 (Low). Supabase writes on the reply path ignore their errors

`domain/pipeline.ts:379-383` (`request_handover`), `:362-367` (confusion count, also read-modify-write),
`reply.ts:333-336`, `lead.ts:130`, `onboarding.ts:88-96,119-125,149-157,204-212`. A failed
`request_handover` leaves the thread unmuted after the customer was told a person is taking over.
Fix: check `error` on `request_handover`; increment the counter in SQL.

### R22 (Low). Owner webhook and Slack destinations are fetched with no address check

`packages/core/src/domain/notify.ts:178-195`. `notification.destination` is POSTed to as stored. Tenant
owners and admins may write `notification_recipients` (`0008` write grants and
`notification_recipients_write` policy), though there is no web UI for it and PostgREST is not on the
tunnel. If a tenant can set one, it is a blind SSRF from the box (for example to `127.0.0.1:54321`).
Fix: allow only `https:` to public addresses for `webhook`/`slack`, at save time and before the fetch.

### R23 (Low). `calls/originate` does not check the contact belongs to the business

`apps/web/src/app/api/internal/v1/calls/originate/route.ts:91-119` and `:143`. The appointment's business
is checked; the contact's is not. For an appointment with no `contact_id` and no `customer_phone`, the
call dials another tenant's contact and returns its number in `to_number`. Needs the contact UUID.
Fix: `if (contact.business_id !== businessId) throw badRequest(...)`.

### R24 (Low). The core test "does not let one call override leak into the next call" cannot fail on a leak

`packages/core/src/domain/voice.test.ts:226-233`. It asserts `models.includes(TENANT_MODEL)`, which the
deferred lead extraction of the first call satisfies on its own (`extraction_model` is the same name).
Mutation run on a scratch copy, making the override sticky across calls in `reply.ts:105`:

```
    ok 1 - sends the override model to the provider in place of the tenant model
    not ok 2 - sends the tenant model when there is no override
    ok 3 - does not let one call override leak into the next call
```

The leak test still passes with the leak in place (test 2 fails only because of run order).
Fix: assert on the second call's reply request (`requests.find(r => r.stream === true && ...)`), not
on any request.

### R25 (Low). "Unknown" is never shown for a conversation with no name and no number

`packages/core/src/utils/phone.ts:115-116` returns `''` for a missing number, so
`formatPhoneForDisplay(...) ?? 'Unknown'` in `apps/web/src/app/app/[slug]/conversations/page.tsx:146-148`,
`app/[slug]/page.tsx:86` and `conversations/[conversationId]/page.tsx:83-85` renders an empty title or
link. Fix: `||` instead of `??`.

## Checked and fine

Errand caller:
- `checkGo` reads only the bridge's `closer.json` (regular file, owned by this uid, not a symlink),
  requires `choice2` with `['Go','Cancel']`, `Chose Go`, `answeredVia` push or tab, a push-log trace
  before the answer, not before the read-back, not in the future. Cancel, open, declined and failed all
  refuse; each test asserts the exact reason and zero creates.
- Single use: `go-used.json` by exclusive create before the create; a racing second dial on the same
  errand loses. No path redials: status and report cannot import the create.
- Number guard: 999/112 on bare digits first, 118xxx, 09, 070, 076, 084/087, non-+44, shape and length all
  refuse; 01, 02, 03, 071-075/077-079 and 080 allowed; `+44 (0)20` and `0044` handled.
- Calling hours read in `Europe/London`, 08:00 in and 21:00 out, BST and GMT tested; the override needs
  `afterHours === true` in a validated brief and changes the brief hash (see R2 for the way round it).
- Batch guard fails closed when either listing fails or times out; the watchdog unit is `errand-watch-<id>`.
- Every create sets From = robot number, `DetectMessageEnd`, `Timeout=30`, `TimeLimit=480`, a `Url`,
  no `Record`, no `AsyncAmd`; global host refused; 15 s abort, never retried.
- Amy's line: any other phone-number run, the robot number in any form, email, postcode, street, date of
  birth or card/bank term is replaced; disclosure is prefixed in code.
- `/errand/twiml` and `/errand/status` verify the signature over the fixed public origin, path, query and
  body before reading the id; no token means 403 and the service refuses to start; the upgrade is
  verified before `handleUpgrade`; `/errand/health` is loopback-only and outside the tunnel rule; body
  capped at 64 KiB; ids pattern-checked before any path; folders 700, files 600.

Relay and core:
- Relay refuses the upgrade (401) on a missing or wrong signature; exits at boot without the token;
  non-upgrade HTTP gets 426; listens on 127.0.0.1. Taking the host from `X-Forwarded-Host` cannot widen
  the check, because the HMAC still needs the token.
- `validateTwilioSignature` compares every token in constant time; `TWILIO_SKIP_SIGNATURE_CHECK` only as
  the exact string `true`, and it throws under `NODE_ENV=production`.
- TwiML builders escape every attribute and text value; `buildConversationRelayTwiml` refuses non-`wss://`.
- AES-256-GCM for tenant credentials with a random IV and a checked tag; `verifySharedSecret` hashes
  before `timingSafeEqual`; API keys looked up by hash.
- `ai_logs` request and response pass through `redactObject`; the voice timings line holds no words.
- `searchKnowledge` and the dashboard search strip the PostgREST `or()` metacharacters; tenant handover
  keywords are regex-escaped; `generateReply` refuses truncated or empty model output.
- The errand package's core imports (`integrations/twilio`, `ai`) bring in no Supabase client or domain code.

Web:
- Every internal route authenticates (shared secret in constant time, or a hashed API key); platform-only
  routes (`purge`, `drain`, rollup-all) refuse tenant keys.
- The dashboard bridge re-checks the conversation through the RLS client and requires owner/admin/agent
  before presenting the secret; attribution comes from the session.
- Pages read through the RLS-scoped client; settings writes rely on the RLS write policy;
  `requireTenant` 404s non-members (no tenant enumeration).
- `/api/revalidate` needs the secret and confines paths to the tenant prefix; `/api/health` returns no data.
- `getCurrentUser()` uses `getUser()` (server-verified), not `getSession()`.
- Login uses `shouldCreateUser: false` and answers unknown addresses like known ones.
- Security headers set (`nosniff`, `X-Frame-Options: DENY`, referrer and permissions policies).
- Twilio delivery receipts never walk a terminal status back; the gather route only changes an
  appointment from a pending or confirmed state.

## For SAM to check

Everything below could not be proved inside the container without a live request or the live box.

1. **R4:** whether the running auth container has sign-up enabled (`GOTRUE_DISABLE_SIGNUP` in its
   environment, or the `[auth]` config the stack was started with), and whether the stack uses the
   default local anon key. If sign-up is on, R4 is Blocking.
2. **R1:** whether `/_next/image` answers on the public hostname (it is on by default). Upgrading `next`
   removes the question.
3. **R12:** tap "Pause the assistant" on a test conversation through the public hostname; a 500 or
   `fetch failed` in the `receptionist-app-prod` journal confirms it.
4. **R15/R14:** `journalctl --user -u atwood-relay -u receptionist-app-prod | grep -c "Twilio signature payload"`
   (count only). Non-zero means a replayable socket signature has been written to the journal; then
   rotate the Twilio auth token.
5. **Production mode:** `systemctl --user show receptionist-app-prod -p Environment` (names only) shows
   `NODE_ENV=production`, and the app env file has no `TWILIO_SKIP_SIGNATURE_CHECK` key (check the key
   list, not values). The skip flag is refused only under production mode.
6. **R3:** on a scratch local stack, not the live demo data: two emergency messages on one thread with a
   resume between them, then count `handover_required` notifications.
7. **R11:** `select count(*) from api_keys where business_id is not null and revoked_at is null` (count
   only). Zero keeps R11 latent.
8. **R22 and R4 reach:** whether port 54321 (PostgREST, GoTrue) is reachable from the LAN or tailnet, or
   only from 127.0.0.1.
9. **R10:** whether `public.normalize_phone()` in SQL has the same `+44 (0)` fault (outside this scope).
10. **Errand empty model turn (not a finding, unverified):** when the model returns `say: ""` with no
    digits, the errand history gets an assistant message with empty content (`turn.ts:129`). If Gemini
    answers an empty text part with a 400, the next turn ends the call as "failed". Check with one
    offline-safe request or the API docs.
11. The baseline ran on the system Node 22.22.0 because `~/.local/node/bin` is absent here; on the box
    the tarball Node is the one that matters.
