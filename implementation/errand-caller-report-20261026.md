# Errand caller build report (T4-T21), 2026-10-26

Branch `cloud/errand-caller`, cut from `origin/restyle/glassmorphism`.

## Baseline (branch as found, before T4)

Node v22.22.0 (`/opt/node22/bin`; `~/.local/node/bin` does not exist in this container), pnpm 10.33.0, `pnpm install --frozen-lockfile`.
HEAD at cut: `90bb6db` (facts commit) on top of the spec base `2ea20b8`.

| suite | tests | pass | fail | typecheck |
|---|---|---|---|---|
| core | 284 | 284 | 0 | clean |
| relay | 86 | 86 | 0 | clean |

These match the last recorded counts (core 284, relay 86).

Pre-existing flake found during T4 (not caused by this build; `apps/relay` is never touched): relay's
`frame probe > probe one sends the first part at once and the last part at 4,000 ms`
(`apps/relay/src/protocol.test.ts:813`) fails about 1 run in 6 with `msSincePromptFinal: 1` against an expected `0`
(a real-clock millisecond tick). The count stays 86; every recorded relay run below is a passing run, and any flaky
run is noted where it happened.

## Conflicts between the tickets file and this session's instructions

- The tickets file says "Branch: `restyle/glassmorphism` ... No push" and T21 says "Commit on `restyle/glassmorphism` ... No push".
  This session's instructions override that: work is on `cloud/errand-caller` (cut from `origin/restyle/glassmorphism`) and is pushed after every ticket.
- The tickets' commits "go through the Atwood gate (`gate-prepush` / `gate-detector`)". Neither tool exists in this container; commits are plain `git commit`. SAM should run the gate over the branch before it is merged.

## T4: package scaffold, locked values, boundary test — DONE

Files (all new):
- `apps/errand/package.json`: `@atwood/errand`, ESM, scripts `start`/`test`/`typecheck` as the relay; deps `@atwood/core` (workspace), `ws`.
- `apps/errand/tsconfig.json`: copy of the relay's, comment adjusted.
- `apps/errand/src/config.ts`: every locked value as a named, commented constant (`ROBOT_NUMBER`, `GO_EXPIRY_MS`, `TURN_CAP`,
  `RING_TIMEOUT_S`, `MAX_CALL_S`, `CONFUSED_LIMIT`, `MODEL_TIMEOUT_MS`, `CALL_CREATE_TIMEOUT_MS`, `OUTCOME_REPORT_MS`, `NO_OUTCOME_ALERT_MS`,
  `RETENTION_DAYS`, `CALLING_HOURS`, `OPENING_LINE`, `VOICE_ID`, `ERRAND_MODEL` = `gemini-3.8-flash` / `ERRAND_EFFORT` = `low` (facts B6),
  `MACHINE_DETECTION`, `ERRAND_PORT`, plus the VOLTA voice attributes from facts B5 and the endpoint paths). Paths are functions read at call
  time with env overrides: `errandHome()` (`ERRAND_HOME`), `jobStore()` (`SAM_JOB_STORE`), `notifyBin()` (`ERRAND_NOTIFY_BIN`),
  `pushLog()` (`ERRAND_PUSH_LOG`). `requireTwilioBase()` throws when `TWILIO_API_BASE_URL` is unset, blank, not a URL, or names the global host.
  `maskSid()` (first 4, last 4).
- `apps/errand/src/boundary.test.ts`: walks `src`; imports are an allow-list (`node:*`, `ws`, `@atwood/core/integrations/twilio`,
  `@atwood/core/ai`, relative paths that stay inside `apps/errand`); refuses the core root, every other core subpath, `@supabase/*`, relay and web.
  Non-test source may name the global Twilio host only in `config.ts`, and may never set a `Record` parameter. Plus `requireTwilioBase` tests.
- `apps/errand/README.md`: what the package is and the four entry points.
- `pnpm-lock.yaml`: +19 lines from `pnpm install` (the new importer only).

Proof:
```
$ pnpm --filter @atwood/errand test        # tests 7, pass 7, fail 0
$ pnpm --filter @atwood/errand typecheck   # exit 0
# mutation: sed -i "1i import '@atwood/core/domain';" apps/errand/src/config.ts
        0: 'config.ts: core subpath not allowed: @atwood/core/domain'
# tests 7
# pass 6
# fail 1
# reverted (cp from backup): pass 7, fail 0
```
Counts: before core 284 / relay 86 / errand (none); after core 284 / relay 86 / errand 7. Typechecks clean.

## T5: errand folder store — DONE

Files (new):
- `apps/errand/src/brief.ts`: `Brief` type (business, number, goal, `goalKind` `table`|`other`, window date/earliest/latest,
  details, contact name/mobile, limits fixed/added); `FIXED_LIMITS` (the guardrails by name); `validateBrief()` returns the stored shape or
  `{field, error}` naming the field (a table needs `details.partySize`; fixed limits filled in when absent, refused if any is dropped);
  `canonicalJson()` (keys sorted at every level) and `briefHash()` (sha256 hex).
- `apps/errand/src/store.ts`: id regex check before any path (`assertErrandId`, `errandDir`); `makeErrandId` (UK local date/time + slug);
  `newErrand` (folder mode 700, non-recursive create so a clash takes `-2`; `brief.json` exclusive; `created` event); `writeBrief` (atomic
  replace + `brief_edited` event); `writeReadback`/`readReadback` (atomic replace); `writeGoUsed` (exclusive `wx`); `appendEvent`
  (`events.jsonl`: time, kind, fields); `appendTranscript` (`transcript.jsonl`: time, speaker `amy`|`them`, words); `writeOutcome` and
  `writeAlert` (exclusive, return false on a second write); readers for each; `listErrands`, `dialledAt`. Files mode 600. Types `Readback`,
  `GoUsed`, `Outcome` (kinds booked / not_booked / voicemail_left / not_reached / ended_early / failed; `limit` payment asked / confused /
  turn cap / maximum length), `Alert`.
- `apps/errand/src/testing/fixtures.ts`: sample brief (Ofcom drama-range numbers only) and temp-folder helper. Test-only.
- `apps/errand/src/brief.test.ts`, `apps/errand/src/store.test.ts`.

Proof:
```
# before (store.ts and brief.ts moved aside):
# tests 9  # pass 7  # fail 2
Cannot find module '/home/user/AI-Receptionist-platform/apps/errand/src/brief.ts'
# after:
# tests 23  # pass 23  # fail 0      typecheck exit 0
```
Tests cover: bad ids refused before any path is built (and nothing created); a table brief without party size fails naming
`details.partySize`; every other field named; the hash is key-order independent and changes on each of ten single-field edits;
`go-used.json`, `outcome.json`, `alert.json` cannot be written twice; a scripted sequence leaves brief, read-back, go, events (status
changes, `answered` with `AnsweredBy`, digits), transcript and outcome in the folder, all mode 600.

Counts: before core 284 / relay 86 / errand 7; after core 284 / relay 86 / errand 23. All typechecks clean.

## T6: read-back message and the Go question — DONE

Files (new):
- `apps/errand/src/readback.ts`: `renderReadback(brief, dialNumber)`: one message, fixed line order (business, number as dialled in
  E.164 and spaced, goal, kind, window "Wed 28 Oct, between 19:00 and 20:30", each detail, name and mobile Amy may give, limits, `Brief #<first 8
  of hash>`, closing line "Tap Go to place this call. Nothing dials without it."). `spacedUkNumber`, `renderWindow`, `hashTag`.
  `sendReadback(errandId, deps)`: validates the stored brief, runs the injected number check (a refusal stops with its reason; nothing created,
  nothing sent, no `readback.json`), creates the Go question by facts A2/A4 (`choice2`, options `Go`/`Cancel`, `gated: true`,
  `acceptAction: none`, `source: errand`, `state: open`, `createdAt` UTC to the second, text = the read-back on one line) in job
  `job_errand-<errand id>_<YYYYMMDD-HHMMSS>`, writes `readback.json` (text, brief hash, dial number, question id, job id, question text and
  options, sent time) *before* notifying, then calls the notifier once with `--question`, `--options Go|Cancel`, `--job`, `--full <read-back>`;
  the exit code goes into a `readback_sent` event. Live defaults: `createQuestionInStore()` (closer.json written atomically, temp + fsync +
  rename, waiting-on-colin precedent) and `runNotifier()` (`execFile`, no shell).
- `apps/errand/src/readback.test.ts`.

Note (ordering): T6 needs T8's normaliser, which is built later. The number check is an injected `NumberCheck`; T6's tests use a fake,
and T8 supplies the real one (wired by the CLI in T19). The Go question is `gated: true` as facts A4 recommends.

Proof:
```
# before (readback.ts moved aside): # tests 24  # pass 23  # fail 1
Cannot find module '/home/user/AI-Receptionist-platform/apps/errand/src/readback.ts'
# after: # tests 30  # pass 30  # fail 0      typecheck exit 0
```
Tests: every brief field appears in the text; the number line equals the dialled E.164 exactly; `readback.json` holds the hash, question id and job id;
a refused number sends nothing and writes no read-back; the notifier is called once with the question id, options, job id and full text; a notifier
failure is recorded and the read-back kept; the live question writer makes a closer.json holding only the question, and refuses a bad job id.

Counts: before core 284 / relay 86 / errand 23; after core 284 / relay 86 / errand 30. All typechecks clean.

## T7: Go-record check — DONE

Files (new): `apps/errand/src/go.ts`, `apps/errand/src/go.test.ts`; `apps/errand/src/testing/fixtures.ts` (edit: `bridgeAnswer()` plays
`closer_answer.py` on a temp store, `pushLogEntry()` writes a temp push-log line).

`checkGo(errandId, now, deps)` reads only the read-back's pins from the errand folder (question id, job id, question text and options,
brief hash, sent time) and the bridge's `closer.json` at `<store>/<jobId>/closer.json`; it never searches the store. Refusals, in order:
`no read-back`; malformed ids; `no bridge record for the read-back's question` (missing file or question); `bridge record is not a regular file`
(symlink); `bridge record is not owned by this user`; unreadable / no questions list; `bridge question does not match the read-back` (kind, text,
options, facts A5 rule 5); `not answered yet`; `Colin chose Cancel`; `answer is not Go` (declined, failed, other); `answer was not written by the
bridge` (`answeredVia` not push or tab); malformed times; `no push-log entry for the Go question before the answer` (facts A5 second trace);
`answered before the read-back was sent`; `answer time is in the future` (beyond 60 s skew); `go expired (30 minutes)` (`now - answeredAt >=
GO_EXPIRY_MS`); `go expired (answered more than 30 minutes after the read-back)` (facts A5 rule 4); `brief edited after read-back`; `go already used`.
`markGoUsed()` writes `go-used.json` by exclusive create; a racing second call returns `go already used`.

Both expiry rules are enforced (the ticket's "now - answeredAt" and the facts' "answeredAt no more than 30 minutes after createdAt"): the stricter
reading, failing closed.

Proof:
```
# before (go.ts moved aside): # tests 31  # pass 30  # fail 1
Cannot find module '/home/user/AI-Receptionist-platform/apps/errand/src/go.ts'
# after: # tests 48  # pass 48  # fail 0      typecheck exit 0
```
Tests: each refusal above returns its reason; a valid Go (tab, and push) returns ok; 29 min 59 s passes and 30 min fails; a second
`markGoUsed` fails.

Counts: before core 284 / relay 86 / errand 30; after core 284 / relay 86 / errand 48. All typechecks clean.

## T8: number and calling-hours guards — DONE

Files (new): `apps/errand/src/guards/number.ts`, `apps/errand/src/guards/hours.ts`, `apps/errand/src/guards/number.test.ts`,
`apps/errand/src/guards/hours.test.ts`.

- `normaliseUkNumber(input)`: 999 and 112 refused on the bare digits before any normalising (and again as `+44999`); the six-digit 118
  short form refused as premium (0118 Reading stays geographic); strips spaces, brackets, dots and dashes; `0...` and `0044...` become
  `+44...`; `+44 (0)...` drops the trunk zero; any other `+` or `00` prefix is "outside the UK". Refusal reasons exactly as the ticket lists:
  "emergency number", "premium or chargeable" (09, 118xxx), "personal number" (070), "pager" (076), "084/087 refused in the first release",
  "outside the UK", "not a UK number shape" (anything else, wrong length, 05). Allowed: 01, 02, 03, 071-075 and 077-079, 080; ten national digits
  (nine allowed for 01 and 080 only). This is the real `NumberCheck` for T6 and T11.
- `checkCallingHours(now)`: allowed from 08:00 up to but not including 21:00 in `Europe/London`; the refusal says the UK time now.

Proof:
```
# before (number.ts and hours.ts moved aside): # tests 50  # pass 48  # fail 2
Cannot find module '.../apps/errand/src/guards/hours.ts'
Cannot find module '.../apps/errand/src/guards/number.ts'
# first run after: # tests 91  # pass 90  # fail 1   ("020 7946 012" accepted as a 9-digit geographic; fixed: nine digits only for 01 and 080)
# after fix:       # tests 91  # pass 91  # fail 0   typecheck exit 0
```
Table (each row is its own test, all pass): refused 999, " 9 9 9 ", 112, +44 999, 0909/+44 909 (premium), 0871/+44 871 and 0845/+44845
(084/087), "118 118", 118500 (premium), 070/+44 70 (personal), 076/+44 7624 (pager), +33/0033/+1 (outside the UK), too short, too long, 0500,
words, no trunk zero (shape); allowed 0113/+44 113, 0118, 020 (four spellings incl. `(020) 7946-0123`, `+44 (0)20`, `0044 20`), 0306/+44 306,
07700/+447700, 07123, 07912, 0808/+44 808, nine-digit 0800. Hours at 07:59 / 08:00 / 20:59 / 21:00 on a GMT date and a BST date, plus a
UTC-vs-UK check.

Counts: before core 284 / relay 86 / errand 48; after core 284 / relay 86 / errand 91. All typechecks clean.

## T9: batch guard and one-errand-at-a-time guard — DONE

Files (new): `apps/errand/src/guards/batch.ts`, `apps/errand/src/guards/live.ts`, `apps/errand/src/guards/batch.test.ts`,
`apps/errand/src/guards/live.test.ts`.

- `checkBatch({ run })`: runs `systemctl --user list-units --all --plain --no-legend robot-*` and `pgrep -af robot-run.mjs` through the
  injected runner; refuses naming every `robot-*` unit (timer or service) and every live `robot-run.mjs` PID
  ("robot batch: unit robot-guardtest-1.service loaded; robot-run.mjs PID 101 live"). A thrown runner, a non-zero `systemctl`, or a `pgrep` exit
  above 1 refuses with "cannot check robot batch" (never passes open; `pgrep` exit 1 = nothing matched). `runCommand` is the live runner
  (`execFile`, no shell, 5 s timeout, resolves the exit code).
- `checkNoLiveErrand(now, { home })`: refuses "errand <id> is live" when an errand has a `dialled` event, no `outcome.json`, and was dialled
  less than `MAX_CALL_S` + 5 minutes ago; older ones are left to the watchdog.

Proof:
```
# before (batch.ts and live.ts moved aside): # tests 93  # pass 91  # fail 2
Cannot find module '.../apps/errand/src/guards/batch.ts'
Cannot find module '.../apps/errand/src/guards/live.ts'
# after: # tests 102  # pass 102  # fail 0     typecheck exit 0
```
Tests (fake runner): `robot-guardtest-1.service` loaded refuses and names it; `robot-today-3.timer` refuses; a live `robot-run.mjs` refuses with
its PID; several blockers named at once; an empty listing passes; four runner-error shapes refuse. A second errand while one is live is refused
(Done-means 5); an outcome clears it; the 13-minute cut-off is exact. `runCommand` checked against `node -e` (harmless local process).

Counts: before core 284 / relay 86 / errand 91; after core 284 / relay 86 / errand 102. All typechecks clean.

## T10: errand call create on the Dublin edge — DONE

Files (new): `apps/errand/src/twilio-call.ts`, `apps/errand/src/twilio-call.test.ts`.

`createErrandCall({ errandId, to }, deps)`: `POST ${requireTwilioBase()}/Accounts/<sid>/Calls.json` with exactly `From` = `ROBOT_NUMBER`, `To`,
`Url` = `https://receptionist.atwoodsystems.co.uk/errand/twiml?errand=<id>`, `Method` POST, `StatusCallback` = `.../errand/status?errand=<id>`,
`StatusCallbackEvent` `initiated ringing answered completed`, `StatusCallbackMethod` POST, `MachineDetection` `DetectMessageEnd`, `Timeout` 30,
`TimeLimit` 480. Never `Record`, `AsyncAmd` or `Twiml`. Abort at `CALL_CREATE_TIMEOUT_MS` (setTimeout + AbortController), never retried. Returns the
CallSid or `{ failure: timeout | rejected (HTTP status + Twilio code) | other }`. Base, SID, token and errand id are all checked before any request;
the SID and token are never logged or returned. Core's `placeCall` is untouched.

Proof:
```
# before (twilio-call.ts moved aside): # tests 103  # pass 102  # fail 1
Cannot find module '.../apps/errand/src/twilio-call.ts'
# after: # tests 106  # pass 106  # fail 0     typecheck exit 0
```
Tests (fake `fetch` counting requests): body equals the ten locked parameters exactly, no `Record` / `AsyncAmd` / `Twiml`; URL host is the configured
Dublin base; empty base, the global host, missing credentials and a bad id each throw with 0 requests; a slow fake (mock timers) is still pending at
14 999 ms, aborted at 15 000 ms as `timeout`, request count stays 1; a 400 returns `rejected` with Twilio's code; a network error returns `other`.

Counts: before core 284 / relay 86 / errand 102; after core 284 / relay 86 / errand 106. All typechecks clean.

## T11: the dial step `errand dial` — DONE

Files (new): `apps/errand/src/dial.ts`, `apps/errand/src/dial.test.ts`.

`dial(errandId, { check }, deps)`: guards in order health (`GET http://127.0.0.1:3003/errand/health`, 2 s; "errand service down") → go (T7) →
number (T8, and must equal the read-back's E.164: "number differs from the read-back") → hours (T8) → batch (T9) → live (T9). Without `--check`
it stops at the first refusal (`refused: <guard>: <reason>`, a `dial_refused` event, exit 3). With every guard passed: `markGoUsed` (exclusive create;
a race loser gets "go consumed by another dial") → exactly one `createCall` → `dialled` event (CallSid masked, number) → watchdog via
`systemd-run --user --on-active=20m --unit=errand-watch-<id> <errand CLI> watch <id>` through the injected runner (`watch_scheduled` event; a scheduling
failure is printed, the call stays placed). A failed create writes a `create_failed` event and outcome `not_reached` / "failed to place", calls the
injected reporter once, exits 1, and never calls create again. `--check` runs every guard, prints `name: pass` or `name: refused: <reason>` per line,
never consumes the Go or creates. Exit codes 0 / 3 / 1. `errandServiceHealthy()` is the live health check. Reporter (T17) and CLI command (T19) are
injected.

Proof:
```
# before (dial.ts moved aside): # tests 107  # pass 106  # fail 1
Cannot find module '.../apps/errand/src/dial.ts'
# after: # tests 121  # pass 121  # fail 0     typecheck exit 0
```
Tests (fake Twilio counting creates): no go, a go for a brief edited after read-back, an expired go and a used go each give 0 creates and their reason;
a valid go gives exactly 1 create to the read-back's E.164 with `go-used.json` written; a second dial on the same errand gives 0 (used go); service
down refuses first and leaves the Go unused; batch and hours refusals; a second errand while one is live is refused; the watchdog command and unit name;
a failed create is not retried (count 1, outcome "failed to place", reported once, no watchdog); `--check` never creates, with and without a go.

Mutation check (step 5): `checkGo` replaced by one returning ok, suite run, file restored.
```
--- mutated run:
# tests 121  # pass 100  # fail 21
    not ok 1 - no go: zero creates and the reason
    not ok 2 - a go for a brief edited after read-back: zero creates
    not ok 3 - an expired go: zero creates
    not ok 4 - a used go: the second dial on the same errand gives zero creates (must-do 18)
    (plus 1 dial --check test and 16 go.test.ts tests, which call checkGo directly)
--- restored: git diff --stat src/go.ts   -> (empty: identical to the committed code)
# tests 121  # pass 121  # fail 0
```
Before / after the mutation: 121 pass → 100 pass, 21 fail (the four Done-means 2 dial tests among them) → restored 121 pass.

Note: a create that *times out* may still have been placed by Twilio. Per the ticket it is settled at once as "not reached: failed to place";
the outcome is write-once, so a later status callback for such a call is logged but does not change it. Flagged for SAM below.

Counts: before core 284 / relay 86 / errand 106; after core 284 / relay 86 / errand 121. All typechecks clean.

## T12: errand server, own endpoints, fail-closed signatures — DONE

Files (new): `apps/errand/src/server.ts`, `apps/errand/src/signature.ts`, `apps/errand/src/server.test.ts`, `apps/errand/src/signature.test.ts`;
`apps/errand/src/testing/fixtures.ts` (edit: `twilioSign`, `listen`, `postForm`, test token).

- `signature.ts`: `publicUrlFor()` rebuilds the signed URL with core's `reconstructTwilioUrl` from the fixed `PUBLIC_ORIGIN` plus the request's
  path and query (never from headers); `verifyWebhook()` runs core's `validateTwilioSignature` under each configured token (primary, and secondary in
  a rotation); `verifySocket()` offers `wss://` then `https://` of the socket URL with no params, as the relay does (read, not imported), and reports
  which form matched.
- `server.ts`: `createErrandServer(deps)` (HTTP + `ws` with `noServer`), handlers injected. `POST /errand/twiml` and `POST /errand/status`: body
  capped at 64 KB, form parsed with core's `parseTwilioForm`, signature checked; no token, no header or a mismatch → 403, empty body, one log line.
  Errand ids validated with the T5 regex and checked to exist; an unknown/bad id on `/errand/twiml` gets core's hang-up TwiML. Status always 200
  once signed. Upgrade only on `/errand/ws`, refused as HTTP 403 with no upgrade when unsigned or wrong; accepted upgrades log `signedUrlForm`.
  `GET /errand/health` → 200 `{ ok: true }` only from loopback with no `CF-Connecting-IP`, else 404. Everything else 404. `main()` binds
  127.0.0.1:`ERRAND_PORT` (env override), refuses to start without `TWILIO_AUTH_TOKEN`, closes cleanly on SIGINT/SIGTERM. Logs are JSON lines,
  CallSids masked, no token or body logged.

Proof:
```
# before (server.ts and signature.ts moved aside): # tests 123  # pass 121  # fail 2
Cannot find module '.../apps/errand/src/server.ts'
Cannot find module '.../apps/errand/src/signature.ts'
# after: # tests 137  # pass 137  # fail 0     typecheck exit 0
# local smoke (container only, dummy token, port 3993):
{"message":"Errand service listening","port":3993}
{"ok":true} 200
{"message":"Errand service cannot start","reason":"TWILIO_AUTH_TOKEN is not set"}
```
Tests (known test token, real HTTP on an ephemeral loopback port): for each of `/errand/twiml` and `/errand/status`, unsigned → 403 empty,
wrongly signed → 403 empty, tampered body → 403, signed → 200 and the handler runs once; no token configured → 403; socket upgrade unsigned → 403,
wrong → 403, signed → 101; bad/unknown ids get a hang-up and never reach the handler; other paths 404; health 200 locally, 404 with `CF-Connecting-IP`.

Done-means 17 through the *public hostname* is owed to SAM (T23); these tests prove the same refusals on the process itself.

Counts: before core 284 / relay 86 / errand 121; after core 284 / relay 86 / errand 137. All typechecks clean.
The first relay run at T12 hit the known flake (`not ok 3 - probe one sends the first part at once and the last part at 4,000 ms`, 85/86);
the two runs straight after gave 86/86. `apps/relay` is unchanged.

## T13: call instructions endpoint, person or machine — DONE

Files: `apps/errand/src/twiml.ts` (new), `apps/errand/src/twiml.test.ts` (new), `apps/errand/src/server.ts` (edit: the default `twiml` handler is
now `errandTwiml(errandId, params, { home })`; +2 lines), `apps/errand/src/store.ts` (edit: `Outcome.source` gains `'twiml'`).

`errandTwiml()` appends an `answered` event (`AnsweredBy` value or null, mode, masked CallSid), then:
- `human`, `unknown`, absent (and any unrecognised value) → person: core's `buildConversationRelayTwiml` with url
  `wss://receptionist.atwoodsystems.co.uk/errand/ws`, **no `welcomeGreeting`**, `language` and `ttsLanguage` `en-GB`, `ttsProvider` ElevenLabs,
  `voice` `VOICE_ID`, `transcriptionProvider` Deepgram, `speechTimeout` 1200 (facts B5), `dtmfDetection` on, parameters `errandId`, `answeredBy`,
  `mode=person`; `interruptible` left unset as VOLTA does.
- `machine_end_beep` / `_silence` / `_other` → the same TwiML with `mode=voicemail`.
- `fax`, `machine_start*` → core's hang-up TwiML, and `outcome.json` "not reached: machine without a message point" written at once (write-once).
- Every ConversationRelay response ends with `<Hangup/>` after `</Connect>`: facts B4 found Twilio's behaviour after `<Connect>` without `action`
  NOT DOCUMENTED and advised not to rely on the default. (An addition to the ticket's steps, taken from the facts file.)

Proof:
```
# before (twiml.ts moved aside, server.ts at its T12 version): # tests 138  # pass 137  # fail 1
Cannot find module '.../apps/errand/src/twiml.ts'
# after: # tests 145  # pass 145  # fail 0     typecheck exit 0
```
Tests: each `AnsweredBy` value gives its mode; no `welcomeGreeting` in any output; the voice attribute equals `VOICE_ID` and the rest match facts B5;
fax hangs up and settles the outcome; the `answered` event holds the value and the masked CallSid; through the server an unsigned request is 403
and records nothing, a signed one gets the person TwiML.

Done-means 6 and 11 (detection with a ConversationRelay call, OPEN 5) and Done-means 7 (Amy waits with no welcome greeting, OPEN 6) are live
proofs, owed to SAM (T25, T26, T28).

Counts: before core 284 / relay 86 / errand 137; after core 284 / relay 86 / errand 145. All typechecks clean.

## T14: guardrails checked in code — DONE

Files (new): `apps/errand/src/guardrails.ts`, `apps/errand/src/guardrails.test.ts`.

- `checkTheirWords(text)`: `{ kind: 'payment', matched }` for card (card, card number, long number on the card, card details, credit, debit),
  expiry, security code (CVV/CVC/CV2, three digits on the back), deposit, pre-payment, pay now / take a payment, bank details (sort code, account
  number, IBAN, bank transfer), and a run of 12 or more digits read out (digits with spaces/dashes, or spoken number words); else `{ kind: 'ok' }`.
- `checkAmyLine(line, brief)`: blocks any 9+ digit phone run other than Colin's mobile (compared as national digits, so `+44` and `0` forms match),
  always the robot number, an email (incl. "at gmail", "dot com"), a UK postcode or street address, a date of birth, or a card/bank detail →
  replacement "Colin will give that to you directly."; blocks agreement words together with anything beyond the goal (deposit, extra, add-on,
  upgrade, sign-up, membership, newsletter, loyalty, change/cancel another booking) → "I can only book the table today, thank you." (a non-table
  errand gets "I can only do what Colin asked today, thank you.").
- `checkAgreedTime(time, window, offeredTimes)`: `HH:MM` or date+time; must be on the window's date and inside earliest..latest inclusive; a refused
  time is added once to `offeredTimes`.
- `callbackNumber(brief)`: Colin's mobile from the brief.
- Separate from `packages/core/src/domain/handover.ts` (not read for reuse, not touched).

Proof:
```
# before (guardrails.ts moved aside): # tests 146  # pass 145  # fail 1
Cannot find module '.../apps/errand/src/guardrails.ts'
# after: # tests 156  # pass 156  # fail 0     typecheck exit 0
```
Tests (Done-means 8): "Can I take a card number...", "We need a deposit...", "What's the long number on the card?", "Bank details please." and nine more
each return `payment`; seven ordinary booking lines (including "a contact number in case we need to reach you?") do not; lines holding the robot
number (three spellings), another number, an email, an address, a postcode, a date of birth, a sort code are blocked; five beyond-the-goal
agreements are blocked; five ordinary Amy lines pass; 18:59 and 20:31 are refused and recorded once as offered, the edges pass; the callback number
is Colin's mobile.

Counts: before core 284 / relay 86 / errand 145; after core 284 / relay 86 / errand 156. All typechecks clean.
The first relay run at T14 hit the known flake again (85/86, same `probe one ... 4,000 ms` test); the re-run straight after gave 86/86.

## T15: turn engine and the errand prompt — DONE

Files (new): `apps/errand/src/prompt.ts`, `apps/errand/src/turn.ts`, `apps/errand/src/turn.test.ts`, `apps/errand/src/prompt.test.ts`.

- `prompt.ts`: `buildErrandPrompt(brief)`: who Amy calls for, the business, goal, window (readable and `HH:MM` bounds), details, Colin's name and
  mobile, any added limits; nine rules (exact opening line, say automated assistant if asked, inside the window only, only Colin's details and
  "Colin will give that to you directly.", no payment, nothing beyond the goal and no second goal, menus by keypad digits, `cannotPlace`, the turn
  cap); the JSON reply shape `{ say, digits?, agreedTime?, offeredTimes?, reference?, nameBookedUnder?, done?: "booked"|"not_booked", reason?,
  cannotPlace? }`. `DECISION_SCHEMA` is the same shape as structured output. (`reason` is an addition to the ticket's shape so a "not booked" can say why.)
- `turn.ts`: `nextTurn(state, theirWords, { model })` in the ticket's order: count the turn → `checkTheirWords` payment → fixed ring-off line,
  `ended_early` / `payment asked`, model never called → model with an 8 s race (timeout, error or malformed reply → "Sorry, I'll have to call back
  another time. Goodbye.", `failed`) → offered and agreed times through `checkAgreedTime` (an outside agreed time is refused and the line replaced
  by a polite ask for a time inside the window) → `checkAmyLine` → `cannotPlace` twice in a row → `ended_early` / `confused` → `done: booked` (only
  with an agreed time inside the window) or `not_booked` (with offered times) → turn 20 → `ended_early` / `turn cap` → digits filtered to `0-9*#`
  (dropped characters reported). Disclosure in code: the first non-empty line starts with `OPENING_LINE` (prefixed if missing); when their words ask
  whether she is a person/robot/computer the line must contain "automated assistant" (prefixed if missing). A keys-only turn counts towards the cap
  and is not Amy's first spoken line. `googleModel(apiKey)` wraps core's `GoogleProvider` with `ERRAND_MODEL` `gemini-3.8-flash`, effort `low`,
  the schema and `timeoutMs` 8000. `packages/core/src/ai/google.ts` untouched.

Proof:
```
# before (turn.ts and prompt.ts moved aside): # tests 158  # pass 156  # fail 2
Cannot find module '.../apps/errand/src/prompt.ts'
Cannot find module '.../apps/errand/src/turn.ts'
# after (one typecheck fix in the test's fake model): # tests 173  # pass 173  # fail 0     typecheck exit 0
```
Tests (fake model): the first line starts with the opening line and is not doubled; "are you a real person?" gets "automated assistant"; an outside
time (18:00) then an inside time (19:30) ends `booked` 19:30 with name and reference, 18:00 recorded as offered; only outside times → `not_booked` with
them; a `booked` with an outside time does not end as booked; the 20th turn ends `turn cap` (19 do not); two `cannotPlace` in a row end `confused`,
separated ones do not; a model taking 9 s ends `failed` at 8 s (mock timers); an error or malformed reply ends `failed`; a payment ask ends with 0
model calls; the robot number and a membership agreement are replaced; digits "1w#" become "1#" with "w" reported; `googleModel` sends the locked model,
effort, timeout and schema to a fake provider (no real key, no network).

Counts: before core 284 / relay 86 / errand 156; after core 284 / relay 86 / errand 173. All typechecks clean.

## T16: errand socket session, person / menus / voicemail — DONE

Files: `apps/errand/src/session.ts` (new), `apps/errand/src/session.test.ts` (new), `apps/errand/src/server.ts` (edit: the default socket handler
is now `attachSession(ws, …)`, which parses JSON frames (non-JSON dropped and logged, never thrown), runs one `ErrandSession` and disposes it on
close; `ServerDeps.model` added; `lazyGoogleModel()` builds the Gemini model on first use from `GOOGLE_API_KEY`, so a missing key fails one call
with the fixed line and outcome "failed" rather than the service at boot).

`ErrandSession` declares its own inbound/outbound frame types (facts B3; nothing imported from the relay). On `setup` it reads `errandId`,
`answeredBy`, `mode` from `customParameters`; an unknown errand gets `end` at once. Person mode sends nothing until the first final prompt, then per
final prompt: `them` transcript line → `nextTurn` → `text` (last true) → `sendDigits` with a `digits` event → `amy` transcript line; guard and
dropped-digit events; on an ending decision the outcome is written (source `session`, write-once) and `end` is sent after the play allowance
(`PLAY_MS_PER_WORD` 400 ms per word, floor `PLAY_MS_MIN` 1500 ms; named constants in `config.ts`). Partial prompts ignored; turns run one at a time
in order; prompts after the end ignored; inbound `dtmf` logged as `dtmf_in`. Voicemail mode sends one `text` (`OPENING_LINE` + "I'm calling to <goal>,
<window>." + "Please call Colin back on <mobile>. Thank you, goodbye."), outcome `voicemail_left`, `end` after the allowance, every prompt ignored and
the model never called. A timer at `MAX_CALL_S` − 10 s says the ring-off line and ends `ended_early` / `maximum length`. A socket close with no
outcome logs `socket_closed` and leaves the outcome to the status callback. The session never notifies.

Proof:
```
# before (session.ts moved aside, server.ts at its T13 version): # tests 174  # pass 173  # fail 1
Cannot find module '.../apps/errand/src/session.ts'
# first run after: 3 files failed: "TypeScript parameter property is not supported in strip-only mode" (constructor
#   parameter property) -> rewritten as a plain field; then 1 file failed: the server-side socket close wrote an event
#   after the test's temp folder was removed -> dispose() now swallows a missing folder, and the test waits for the close.
# after: # tests 184  # pass 184  # fail 0  (three consecutive runs)     typecheck exit 0
```
Tests (fake socket, fake model, mock timers): no frame before the first final prompt, partials ignored; transcript has speaker, words and time for
every turn; an ending decision writes `booked` and sends `end` only after the allowance, later prompts ignored; a payment ask ends `payment asked`;
a menu prompt producing digits sends `sendDigits` and logs `digits`; inbound DTMF logged; voicemail sends exactly one `text` then `end`, ignores a
later prompt, never calls the model, outcome `voicemail_left`; the max-length timer fires at 470 000 ms, not at 469 999, with its outcome; an unknown
errand ends at once; a close with no outcome leaves none; and end to end over a signed socket on the real server.

Counts: before core 284 / relay 86 / errand 173; after core 284 / relay 86 / errand 184. All typechecks clean.

## T17: status callback, outcome and the Telegram report — DONE

Files: `apps/errand/src/status.ts` (new), `apps/errand/src/report.ts` (new), `apps/errand/src/status.test.ts` (new), `apps/errand/src/report.test.ts`
(new), `apps/errand/src/server.ts` (edit: default status handler = `handleStatus(…, { home, notify })`, report not awaited; `ServerDeps.notify`),
`apps/errand/src/store.ts` (edit: `claimReport()` — `reported.json` by exclusive create), `apps/errand/src/readback.ts` (edit: `renderDay()` split out
of `renderWindow()` so the report can say "Wed 28 Oct").

- `handleStatus()`: appends a `status` event (status, `AnsweredBy` or null, duration, masked CallSid, time) for every post. On `completed`,
  `no-answer`, `busy`, `failed`, `canceled`, if no `outcome.json`: `no-answer` / `busy` / `failed` / `canceled` → `not_reached` with the reason;
  `completed` with duration ≥ `MAX_CALL_S` → `ended_early` / `maximum length`; `completed` otherwise → `failed` / "call ended with no outcome". Then
  `reportOnce()`. The outcome is written synchronously; the report runs without holding Twilio's request open.
- `renderOutcome(outcome, brief)`: title "Errand: <business>: <kind>"; bodies for booked (date, time, name, reference), not booked (why, times
  offered), voicemail left, not reached (reason), ended early (which limit), failed.
- `reportOnce()`: claims `reported.json` exclusively *before* calling the notifier (`notify-colin.sh <title> <body> --full <text>`, injected), then a
  `reported` event with the exit code, `sinceCallEndMs` and `late` (over `OUTCOME_REPORT_MS`). A notifier failure or throw is recorded; the outcome stays.
- Neither module imports `twilio-call.ts` or `dial.ts` (test reads the source).

Proof:
```
# before (status.ts and report.ts moved aside, server.ts at its T16 version): # tests 186  # pass 184  # fail 2
Cannot find module '.../apps/errand/src/report.ts'
Cannot find module '.../apps/errand/src/status.ts'
# after: # tests 202  # pass 202  # fail 0     typecheck exit 0
```
Tests: each kind renders its fields; every status post is logged with its fields; `no-answer` writes "not reached", reports once and (no create path
exists) makes zero call creates (Done-means 14); busy/failed reasons; duration 480 → maximum length, 479 → failed; a session outcome is kept; two
`completed` posts send one message; a notifier failure is recorded and the outcome stays; through the server an unsigned status changes nothing and a
signed `no-answer` settles and reports once.

Done-means 12 (each live test's Telegram within 2 minutes of Twilio's end time) is owed to SAM (T25 to T29).

Counts: before core 284 / relay 86 / errand 184; after core 284 / relay 86 / errand 202. All typechecks clean.

## T18: watchdog and retention — DONE

Files (new): `apps/errand/src/watch.ts`, `apps/errand/src/prune.ts`, `apps/errand/src/watch.test.ts`, `apps/errand/src/prune.test.ts`.

- `watch(errandId, now, { notify })`: `outcome.json` present → `outcome present`, silent; never dialled → `not dialled`; under `NO_OUTCOME_ALERT_MS`
  since the `dialled` event → `too early` (an early timer does nothing); otherwise `alert.json` by exclusive create, then one alert "Errand <id> dialled
  at <HH:MM UK> has no outcome after 20 minutes" through the injected notifier and an `alert_sent` event; a second run → `already alerted`.
- `prune(now, { dryRun })`: removes folders whose id date is more than `RETENTION_DAYS` (90) days before `now`; a folder with no outcome dialled less
  than a day ago is never removed; paths only from validated ids; `describePrune()` prints the count and ids ("removed" / "would remove").

Proof:
```
# before (watch.ts and prune.ts moved aside): # tests 204  # pass 202  # fail 2
Cannot find module '.../apps/errand/src/prune.ts'
Cannot find module '.../apps/errand/src/watch.ts'
# after: # tests 209  # pass 209  # fail 0     typecheck exit 0
```
Tests (fake clock, Done-means 15): 19 min 59 s no alert; 20 min one alert with the errand id and dial time; a second run no second alert; outcome
present no alert; never dialled no alert. Prune: 91 days removed, 89 and exactly 90 kept, dry run removes nothing, a fresh undialled-outcome folder kept.

Counts: before core 284 / relay 86 / errand 202; after core 284 / relay 86 / errand 209. All typechecks clean.
