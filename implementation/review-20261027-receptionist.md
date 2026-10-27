# Review 2026-10-27: AI receptionist (errand, relay, core, web)

Status: IN PROGRESS. Sections are pushed as they finish. This one covers `apps/errand`.

- Branch: `cloud/review-20261027`, cut from `origin/restyle/glassmorphism` at `d718202`.
- Review only: no source file, test, ticket or spec was changed. Proof scripts live in the
  reviewer's scratchpad, outside the repo; their code and output are quoted below.
- No live request was made (no Twilio, Supabase, Gemini or Telegram). No `.env` file or key was read.

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

## Files read

### `apps/errand` (59 of 59, read in full)

README.md, SAM.md, package.json, tsconfig.json;
deploy/: RUNBOOK.md, atwood-errand.service, errand, errand-prune.service, errand-prune.timer,
keystore-rows.tsv (names only; every grant value equals its name), tunnel-rule.yml;
src/: boundary.test.ts, brief.ts, brief.test.ts, cli.ts, cli.test.ts, config.ts, deploy.test.ts,
dial.ts, dial.test.ts, go.ts, go.test.ts, guardrails.ts, guardrails.test.ts, prompt.ts,
prompt.test.ts, prune.ts, prune.test.ts, readback.ts, readback.test.ts, report.ts, report.test.ts,
server.ts, server.test.ts, session.ts, session.test.ts, signature.ts, signature.test.ts, status.ts,
status.test.ts, store.ts, store.test.ts, turn.ts, turn.test.ts, twilio-call.ts, twilio-call.test.ts,
twiml.ts, twiml.test.ts, watch.ts, watch.test.ts, testing/fixtures.ts,
guards/: batch.ts, batch.test.ts, hours.ts, hours.test.ts, live.ts, live.test.ts, number.ts, number.test.ts.

Also read in full: `implementation/errand-caller-spec.md`.

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

Outside the scope, read only where a finding needed it: `supabase/migrations/0006` (notifications
dedupe index), `0009` (`enqueue_notification`, `resume_ai`), `0014` (`resolve_inbound` reuse rule).

## Findings: `apps/errand`

### R1 (High). A Go can be moved to a different brief, number or after-hours flag by editing the errand folder

`apps/errand/src/go.ts:126-161`, with `apps/errand/src/dial.ts:100-114`.

What is wrong. The only link between what Colin saw (the bridge's question text in
`~/.sam/jobs/<job>/closer.json`) and the brief that is dialled is `readback.json`, which sits in the
errand folder next to `brief.json` and is written by the same CLI that SAM runs. `checkGo` checks
that the bridge text equals `readback.questionText`, and that the brief on disk hashes to
`readback.briefHash`; it never checks that the brief on disk renders to the text Colin tapped Go on.
So an edit of `brief.json` plus a matching edit of `readback.json` (`briefHash`, `dialNumber`) keeps
the Go valid. The number guard compares against `readback.dialNumber` from the same file. This breaks
must-do 3a ("any edit after the read-back voids it") and the T34 guarantee: `afterHours: true` can be
added after the Go, so the after-hours override is reachable without a Go on a read-back that showed
the "After hours" line. The module comment (`go.ts:22`) says "Nothing SAM writes in the errand folder
can turn a non-Go into a Go"; true, but it can re-target an existing Go.

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

Severity reasoning: it needs a deliberate write to two files under `~/.sam`, which only a process
running as `col` can do (the spec accepts a convention-and-permissions proof, facts A5). It is High,
not Blocking, because nothing outside the box can do it; but it is exactly the hole the Go design
exists to close, and SAM (an agent that writes files in that folder) is the actor it guards against.

Fix: in `checkGo`, re-render the read-back from the brief on disk and require
`questionTextFor(renderReadback(brief, normaliseUkNumber(brief.number).e164)) === question.text`
(the bridge's copy), and dial the number derived there, not `readback.dialNumber`.

### R2 (Medium). The window's date is not enforced in code; a booking on another day ends "booked"

`apps/errand/src/turn.ts:159-167`, `apps/errand/src/guardrails.ts:130-143`, `apps/errand/src/prompt.ts:77`.

What is wrong. `checkAgreedTime` rejects another date only when the model's `agreedTime` carries one
(`YYYY-MM-DD HH:MM`). The prompt asks for `"agreedTime": "HH:MM"`, so in practice no date is ever
given, and the date half of must-do 9 rests on the prompt alone. The outcome then reports the brief's
date (`turn.ts:198`), so Colin is told "Booked for Wed 28 Oct" for a Thursday booking.

Evidence:

```ts
const model = async () => ({ say: 'Lovely, thank you, goodbye.', agreedTime: '19:30', done: 'booked', nameBookedUnder: 'Colin Wood' });
const result = await nextTurn(state, "We're full Wednesday, but Thursday at half seven is booked for you.", { model });
assert.equal(result.end?.kind, 'booked'); assert.equal(result.end?.date, '2026-10-28');
```
```
ok 3 - R: the window date is not enforced in code
```

Fix: make the schema require `agreedDate` (`YYYY-MM-DD`) alongside `agreedTime` and refuse `booked`
unless it equals `window.date`; optionally refuse when their words name a weekday other than the window's.

### R3 (Medium). A call-create timeout settles "not reached", hiding the real outcome and blinding the live guard and watchdog

`apps/errand/src/dial.ts:144-150`.

What is wrong. The create is abandoned at 15 s, and the code's own comment (`twilio-call.ts:31-33`)
says Twilio may still have placed the call and that "the status callback is what settles a call whose
create timed out". But on `failure: 'timeout'` the dial step writes `outcome.json` = not reached
"failed to place" (write-once) and reports it at once (claiming `reported.json`). If the call was in
fact placed, the session's real outcome (booked, payment asked, ...) and the status callback are both
refused by the write-once files, and Colin is told "not reached" for a call that happened. No `dialled`
event is written either, so `checkNoLiveErrand` does not see the call (a second errand can dial during
it) and no watchdog is scheduled.

Evidence:

```ts
h.deps.createCall = async () => ({ ok: false, failure: 'timeout', message: 'x' });
await dial(id, {}, h.deps);                                    // code 1, outcome not_reached, reported
writeOutcome(id, { kind: 'booked', ... }, home)                // -> false (session's outcome refused)
await handleStatus(id, { CallStatus: 'completed', CallDuration: '120' }, ...).reported;
assert.equal(readOutcome(id, home)?.kind, 'not_reached');
assert.equal(sent[0][0], "Errand: Luigi's: not reached");      // the one message Colin gets
```
```
ok 4 - R: a create timeout settles "not reached" and hides the real outcome
```

Fix: on `timeout` (only), append a `dial_ambiguous` event that the live guard treats as `dialled`,
schedule the watchdog, and leave `outcome.json` to the status callback or the watchdog; keep the
immediate "failed to place" only for `rejected` and `other`.

### R4 (Medium). The payment check misses fees, holds and minimum spends, and Amy may agree to them

`apps/errand/src/guardrails.ts:46-54` (their words) and `:101-103` (Amy's line).

What is wrong. Must-do 11 says the ring-off on a payment ask is enforced in code. A card hold or a
no-show fee is a payment ask, but none of the patterns match "fee", "charge", "hold", "minimum spend"
or a money amount, and `BEYOND_GOAL` does not either, so Amy agreeing to one also passes.

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

### R5 (Low). The one-errand-at-a-time guard is check-then-act across two errands

`apps/errand/src/dial.ts:118` and `:139-152`, `apps/errand/src/guards/live.ts:15-24`.

What is wrong. `checkNoLiveErrand` looks for a `dialled` event, which is written only after the
create returns (up to 15 s later). Two `errand dial` runs for two different errands started together
both pass and both create a call. The Go's exclusive create protects one errand, not this.

Evidence:

```ts
const [ra, rb] = await Promise.all([dial(a, {}, h.deps), dial(b, {}, h.deps)]);   // create takes 50 ms
assert.equal(h.creates.length, 2);
```
```
ok 2 - R: the live guard races across two errands
```

Low because SAM dials one errand at a time in practice. Fix: take an exclusive lock file
(`ERRAND_HOME/.dialling`, `wx`) around guard-to-`dialled`, or write a `dialling` event before the create.

### R6 (Low). The socket trusts the setup frame's errand id, and its signature never changes

`apps/errand/src/session.ts:154-182`, `apps/errand/src/signature.ts:64-75`.

What is wrong. The socket's signature is an HMAC over a fixed URL with no body, so it is the same
value on every call. Whoever holds one copy can open `/errand/ws` at any time, and the session takes
`errandId` and `mode` from the client's `setup` frame. `mode: 'voicemail'` immediately writes the
write-once `outcome.json` = voicemail left for any existing errand, which then masks the real outcome.
The relay has the same constant-signature property (Twilio's design for socket upgrades).

UNPROVEN as an attack: it needs a leaked `X-Twilio-Signature` header (TLS from Twilio to Cloudflare).
What would prove it: any log, proxy or trace that records request headers on that path.
Fix: have the session accept an errand only if it has a `dialled` event and no outcome, and match the
setup frame's `callSid` against the CallSid recorded at dial time (store the full CallSid, mask only in output).

### R7 (Low). `requireTwilioBase` accepts plain `http://` and the global host with a trailing dot

`apps/errand/src/config.ts:168-183`.

Evidence:

```
https://api.twilio.com./2010-04-01 -> https://api.twilio.com./2010-04-01
http://api.dublin.ie1.twilio.com/2010-04-01 -> http://api.dublin.ie1.twilio.com/2010-04-01
```

Low: the value is fixed in `deploy/atwood-errand.service` and `deploy/errand`, not user input.
Fix: require `https:` and compare the hostname with any trailing dot removed.

### R8 (Low). The Go-expiry comment and the code disagree; a Go can be used up to an hour after the read-back

`apps/errand/src/config.ts:27` says "Measured from the Go question's creation"; `apps/errand/src/go.ts:155-156`
measures `now - answeredAt < 30 min` and separately allows `answeredAt - createdAt <= 30 min`.
So a read-back at 14:00, a Go at 14:29 and a dial at 14:58 passes. Spec must-do 3b ("younger than the
go expiry") reads either way. Fix: decide which clock (Colin's call) and make the comment, the code and
a test agree; if it is from creation, check `now - createdAt < GO_EXPIRY_MS`.

## Checked and fine: `apps/errand`

- No dial without a bridge Go: `checkGo` reads only the bridge's `closer.json` (regular file, owned by
  this uid, not a symlink), requires `choice2` with `['Go','Cancel']`, `Chose Go`, `answeredVia` push/tab,
  a push-log trace before the answer, not before the read-back, not in the future. Cancel, open,
  declined and failed all refuse. Tests assert each reason (`go.test.ts`, `dial.test.ts`).
- Single use: `go-used.json` by `wx` before the create; a racing second dial on the same errand loses.
- Number guard (`guards/number.ts`): 999/112 on bare digits first, 118xxx, 09, 070, 076, 084/087, non-+44,
  shape and length all refuse; 01, 02, 03, 071-075/077-079, 080 allowed. `+44 (0)20` and `0044` handled.
- Calling hours read in `Europe/London`, 08:00 in and 21:00 out, BST and GMT tested. The override needs
  `afterHours === true` in a validated brief (any other value refuses) and changes the hash (see R1 for
  the way round it).
- Batch guard fails closed when either listing fails or times out (`runCommand` rejects on a non-numeric
  exit code); the watchdog unit is `errand-watch-<id>`, never `robot-`.
- Every create sets From = robot number, `MachineDetection=DetectMessageEnd`, `Timeout=30`,
  `TimeLimit=480`, a `Url` (not inline TwiML), no `Record`, no `AsyncAmd`; global host refused;
  15 s abort, never retried; status and report modules cannot import the create.
- Amy gives only the brief's name and mobile: any other phone-number run, the robot number in any form,
  an email, postcode, street, date of birth or card/bank term in her line is replaced. The voicemail
  message uses the brief's mobile. Disclosure is prefixed in code on the first spoken line and when asked.
- Twilio-facing routes: `/errand/twiml` and `/errand/status` verify `X-Twilio-Signature` over the fixed
  public origin, path, query and body before reading the errand id or touching disk; no token means
  every request is 403 and the service refuses to start. The socket upgrade is verified before
  `handleUpgrade`. `/errand/health` is loopback-only without `CF-Connecting-IP` and not in the tunnel rule.
- Body capped at 64 KiB; ids validated by pattern before any path is built (`store.ts:98`); folders 700, files 600.
- Errand id `?errand=` is inside the signed URL, so it cannot be swapped without breaking the signature.
- Boundary test is an allow-list on import specifiers; no errand file imports `@supabase/*`, core domain, relay or web.
- `keystore-rows.tsv` and the unit/wrapper carry variable names only; no value.
- Tests that cannot fail: none found in this package; each guard test asserts the exact refusal and a zero create count.

## Findings: `apps/relay`

### R9 (Low, partly UNPROVEN). The relay trusts the setup frame, and its handshake signature is a fixed, replayable value

`apps/relay/src/protocol.ts:480-521` and `:587-596`, `apps/relay/src/signature.ts:126-140`,
`packages/core/src/integrations/twilio.ts:603-609`.

What is wrong. A WebSocket upgrade has no body, so `X-Twilio-Signature` for `wss://host/relay` is
`HMAC(token, url)`: the same string on every call, with no nonce or expiry. Anyone holding one copy can
open the socket at will, and the session then takes `to`, `from` and `callSid` from the client's
`setup` frame and hands them to `replyToCaller`. That is enough to run the tenant pipeline for any
tenant number (writes `messages`/`calls` rows, spends model tokens, raises owner alerts), and
`recordInterruptedTurn` rewrites the metadata of any outbound message found by `callSid`.

How a copy could leak (proven part): with `LOG_LEVEL=debug`, core's signature check logs the
`expected` signature for every check, accepted or rejected. With a throwaway test token:

```
{"level":"debug","message":"Twilio signature payload",...,"payload":"wss://receptionist.example/relay",...,"expected":"<the valid signature>","presented":"wrong"}
```

`expected` and `presented` are not in `redact.ts`'s `SECRET_KEYS`, so they are written as-is. Debug is
off by default (`env.ts:323`), so the leak needs a debug run on the live box. UNPROVEN: that the live
relay ever ran at debug; what would prove it is a `"Twilio signature payload"` line in
`journalctl --user -u atwood-relay`. The same applies to `/errand/ws` (R6).

Fix: stop logging `expected` (log its length only), and bind the socket to the call: put a per-call
HMAC of the CallSid in a `<Parameter>` of the signed TwiML and check it against the setup frame's
`callSid` before the session accepts any prompt.

### R10 (Low). `RELAY_MAX_TURNS` set to a non-number switches the hard turn limit off

`apps/relay/src/server.ts:133`, `apps/relay/src/protocol.ts:376` and `:633`.
`Number.parseInt('forty', 10)` is `NaN`; `options.maxTurns ?? 40` keeps `NaN` (it is not nullish) and
`this.turns >= NaN` is always false, so the backstop "so a bug cannot bill somebody for an hour-long
call" never fires. Fix: `Number.isFinite(n) && n > 0 ? n : 40`.

### R11 (Low). The relay journal holds what callers say

`apps/relay/src/protocol.ts:534` (`prompt_partial` with `text`) and `:554` (`prompt_final` with `text`),
logged at info by `server.ts:139`. The logger's `redactText` strips emails, phone numbers, postcodes and
card numbers, but names, addresses and everything else a caller says go to journald, which has its own
retention outside `erase_contact()`. `turn-timings.ts:12-13` states the opposite rule for the timings
line. Fix: log the length and turn number, not the words, or log them at debug.

## Findings: `packages/core`

### R12 (High). A second emergency on a resumed conversation alerts nobody, while the caller is told the team is on it

`packages/core/src/domain/pipeline.ts:730-731` (dedupe key), with
`supabase/migrations/0006_notifications_ai_analytics.sql:77-79` and
`supabase/migrations/0009_rpc_functions.sql:504-508`.

What is wrong. The owner's handover alert uses `dedupeKey: handover:<conversationId>:<reason>`.
`enqueue_notification` appends the recipient id and inserts with `on conflict (business_id, dedupe_key)
do nothing` against a permanent unique index. After a handover, the dashboard's resume
(`resume_ai`, `0009:435-452`, called by `api/internal/v1/conversations/[conversationId]/resume`) sets
the conversation back to `active`, and `resolve_inbound` reuses any `active` conversation for the same
caller and channel (`0014:145-152`). So the next emergency from that caller on that thread goes down
the handover path, the customer hears or reads "I'm passing this to the team right now"
(`handover.ts:280`), `enqueue_notification` inserts nothing, and no email, SMS or webhook is sent.

Evidence (the three pieces of code that combine):

```ts
// pipeline.ts:730
    dedupeKey: `handover:${input.conversationId}:${input.reason}`,
```
```sql
-- 0006:77
create unique index notifications_dedupe_idx on public.notifications (business_id, dedupe_key) where dedupe_key is not null;
-- 0009:504
case when p_dedupe_key is null then null else p_dedupe_key || ':' || e.id::text end
... on conflict (business_id, dedupe_key) where dedupe_key is not null do nothing
-- 0009:445 resume_ai
set status = 'active', ai_enabled = true, ... handover_at = null
```

Not run against a database (no live request). What would prove it end to end: on the local stack,
send two emergency messages on one thread with a `resume_ai` between them and count
`notifications` rows for `handover_required` (expect 1 per recipient, not 2).
Fix: include the handover instance in the key, for example `handover:<conversationId>:<handover_at>`
or the inbound message id, so each escalation alerts once and a retry of the same one still dedupes.

### R13 (Medium). `isOpenNow` is wrong after midnight on any shift that crosses it

`packages/core/src/utils/hours.ts:29-46`.

What is wrong. The check reads only today's row. After midnight, the shift that is still running
belongs to yesterday's row, which is never consulted, and today's overnight row is wrongly treated as
already open from 00:00. This drives the prompt's "the business is open/closed" line
(`prompts/receptionist.ts:57,127`), the after-hours SMS template choice (`receptionist.ts:486-490`)
and booking slots (`domain/booking.ts:91-92`).

Evidence:

```
Sat 01:00 London (Fri shift 20:00-02:00, Sat closed): open = false     (should be true)
Sat 01:00 London (only Sat 20:00-02:00, Fri closed): open = true       (should be false)
```

The existing test (`hours.test.ts:49-55`) checks only 22:00 on the opening day.
Fix: for `nowMinutes < closes` of an overnight row, look at the previous day's row; for today's
overnight row, require `nowMinutes >= opens`.

### R14 (Medium). `normalizePhone` keeps the trunk zero of `+44 (0)20 ...`, producing an undiallable number

`packages/core/src/utils/phone.ts:55-63`.

Evidence:

```
"+44 (0)20 7946 0123" -> +4402079460123
"+44 020 7946 0123"   -> +4402079460123
"020 7946 0123"       -> +442079460123
```

`+44 (0)...` is the common way UK numbers are printed on websites and in signatures. The lead extractor
(`domain/lead.ts:180-183`) runs every model-transcribed phone number through this, so a lead's phone can
be stored wrong and the callback number in the owner's alert is then wrong. The comment says the SQL
`normalize_phone()` must agree; whether it has the same fault is not checked here (out of scope).
Fix: after stripping to digits on the `+` branch, drop a `0` that immediately follows a `44` country code.

### R15 (Low). A caller ringing back on a handed-over thread is never re-escalated, even for an emergency

`packages/core/src/domain/handover.ts:123-125` with `domain/pipeline.ts:488-520`.
On a callback call the conversation is `waiting_for_human`, so `detectHandover` returns no handover for
anything, "fire" included; the assistant answers and the owner gets a plain `new_message` alert
("The customer rang back...") rather than an urgent `handover_required`. The prompt tells the model to
say 999 if anyone is in danger (`receptionist.ts:430`), so the caller is not left without advice, but
the owner's alert does not say urgent. Fix: run the emergency patterns on callback turns and, on a hit,
send the `handover_required` alert with `urgency: emergency`.

### R16 (Low). Several Supabase writes on the reply path ignore their error

`domain/pipeline.ts:379-383` (`request_handover`), `:362-367` (confusion count), `reply.ts:333-336`
(summary), `lead.ts:130` (score), `onboarding.ts:88-96, 119-125, 149-157, 204-212` (job status).
A failed `request_handover` leaves the conversation `active` and unmuted while the customer has been
told a person is taking over, so the next message gets an AI reply. The confusion counter is also a
read-modify-write (`memory.confusion_count + 1`), so two quick messages count once.
Fix: check `error` on `request_handover` (log loudly at least), and increment in SQL.

### R17 (Low). Owner webhook and Slack destinations are fetched server-side with no address check

`packages/core/src/domain/notify.ts:178-195`. `notification.destination` is POSTed to as given.
Whether a tenant user can set an internal URL depends on the web app's recipient form; see the web
section for what the route allows. If they can, it is a blind SSRF from the box (for example to
`http://127.0.0.1:54321` or the n8n port). Fix: allow only `https:` to public addresses for
`webhook`/`slack` destinations, checked when saved and again before the fetch.

## Checked and fine: `apps/relay` and `packages/core`

- Relay upgrade is refused (401) before `handleUpgrade` when the signature is missing or wrong; the
  process exits at boot without `TWILIO_AUTH_TOKEN`; non-upgrade HTTP gets 426; it listens on 127.0.0.1.
- Taking the host from `X-Forwarded-Host` cannot widen the check: the HMAC still needs the token.
- `validateTwilioSignature` compares every candidate token in constant time; secondary token honoured
  only while set; `TWILIO_SKIP_SIGNATURE_CHECK` honoured only as the exact string `true` and throws when
  `NODE_ENV=production` (see "For SAM to check" on how the web app is run).
- Every TwiML builder escapes attribute and text values; `buildConversationRelayTwiml` refuses non-`wss://`.
- `encryptSecret`/`decryptSecret`: AES-256-GCM, random 12-byte IV, auth tag checked, vague error on failure.
- `verifySharedSecret` hashes both sides before `timingSafeEqual`, so length does not leak.
- `ai_logs` request/response pass through `redactObject`; the voice timings line holds no words or numbers.
- `searchKnowledge` strips the PostgREST `or()` metacharacters; tenant handover keywords are regex-escaped.
- `generateReply` refuses truncated or empty model output rather than sending half a message.
- Firecrawl URLs are normalised and obvious internal hosts refused; the fetch runs at Firecrawl, not here.
- The errand package's core imports (`integrations/twilio`, `ai`) pull in env, logger and the AI SDKs
  only, no Supabase client or domain code.
