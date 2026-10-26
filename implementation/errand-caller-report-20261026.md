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
