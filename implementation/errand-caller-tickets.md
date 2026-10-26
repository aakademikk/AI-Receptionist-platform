# Tickets: Errand caller (Amy places a call for Colin and reports back)

Spec: [errand-caller-spec.md](errand-caller-spec.md) (LOCKED 2026-10-26, Colin's 17 decisions applied). 22 must-dos, 20 done-means
(number 10 SKIPPED by OPEN 15), 17 locked decisions. Where this file and the spec differ, the spec wins; say so in the ticket's report.
Branch: `restyle/glassmorphism`. Never `main`. No push.
Consumer: `/implement`, one fresh agent per ticket. Build in order. Each code ticket leaves every suite green.
This file was written by a tickets-only job: no code, no Twilio write, no call, no deploy, no config change was made to write it.

## Shape of the work

- Facts and read-only checks first (T1 to T3): the Go-button bridge contract, the Twilio and ConversationRelay facts, and a baseline
  snapshot of the live box. SAM runs them locally (they need `~/.sam`, the keystore and the Dublin edge); they write their results into
  `implementation/errand-caller-facts.md` so the cloud build agents can read them. No live change.
- The errand path (T4 to T20): a new workspace package `apps/errand` (`@atwood/errand`) with its own call instructions (TwiML) endpoint,
  its own socket, its own process and its own turn logic, plus the guardrails, the dial step, the outcome report, the watchdog, the unit
  files and the one tunnel rule (as a staged file, not applied). Built and tested in the cloud with fakes. Nothing live.
- Automated tests are written inside each build ticket (each ticket's proof is its tests failing before and passing after), and T21
  closes the build: every suite green, the mutation check, the boundary diff, the commit.
- Live (T22 to T33): GATE tickets run by SAM with Colin: deploy, the tunnel rule, the live guard check, the test calls, the isolation
  read-back, the backup restore, the rollback rehearsal and the final report.

## Who runs what

- GATE tickets are run by SAM with Colin, never by a build agent: T22 to T33.
  Every live change is a GATE: the keystore rows, the new unit and timer, the new tunnel rule (must-do 22), the deploy, every live
  test call, and any Twilio write (this build plans none: OPEN 8 leaves the robot number as it is).
- SAM-RUN tickets (T1 to T3) are run by SAM locally, read-only: docs, files on this box, `systemctl --user` listings, and Twilio GETs on
  the Dublin edge. No change anywhere.
- Every other ticket (T4 to T21) is for a build agent and touches nothing live: no `~/.sam` write, no systemd change, no tunnel change,
  no Twilio request, no model call against a real key, no Telegram message. Paths under `~/.sam` are configurable defaults and every
  test runs against a temp folder and fakes.
- Commits go through the Atwood gate (`gate-prepush` / `gate-detector`). Any restart on the live line follows the existing deploy path
  (T10 of [amy-latency-tickets.md](amy-latency-tickets.md)): confirm HEAD, all suites, restart, confirm the new PID started after the change.
  This build restarts only the new errand unit and, once, the tunnel. `atwood-relay` and `receptionist-app-prod` are never restarted.

## How to run the tests (every code ticket)

- Node 22+ with type stripping. Put `~/.local/node/bin` first on PATH (the system Node fails with `ERR_NO_TYPESCRIPT` or silently
  ignores `--experimental-strip-types`).
- Core: `pnpm --filter @atwood/core test` and `pnpm --filter @atwood/core typecheck`.
- Relay: `pnpm --filter @atwood/relay test` and `pnpm --filter @atwood/relay typecheck`.
- Errand (from T4): `pnpm --filter @atwood/errand test` and `pnpm --filter @atwood/errand typecheck`.
- Web: `pnpm --filter @atwood/web typecheck`, only where a ticket touches `apps/web` (none in this build should; T21 checks it is untouched).
- Baseline before T4: the agent counts core and relay tests before starting (last recorded: core 284, relay 86, amy T32a) and reports the
  counts after. Core and relay counts must not change in this build: the errand path adds no test to either.

## Rules for every ticket

- Never read, print, cat, grep or source-and-echo an env, key or token file (`apps/web/.env.local`, `~/.sam/call-screener.env`,
  `~/.cloudflared/*`, anything named `*.env`, `*key*`, `*token*`). Code that needs a value takes it from the process environment as
  supplied by `with-secrets --as <consumer>` and never prints it. Twilio SIDs are masked (first 4, last 4) in all output and logs.
- No live writes: no database write, no Twilio write, no systemd or tunnel change, no Telegram or push message, outside a GATE ticket.
- Read-only Twilio GETs only where a ticket says so (T3, T24 to T30, T33).
- Every Twilio request uses `TWILIO_API_BASE_URL` (the Dublin edge), never `api.twilio.com`. The errand code refuses to run if the value
  is absent or names `api.twilio.com` (auth is region-scoped and the global host gives false answers; platform note gotcha 13).
- Errand calls write nothing to the tenant database. `apps/errand` imports nothing from `@supabase/*`, `@atwood/core/domain` or
  `@atwood/core/supabase`, and nothing from `apps/relay` or `apps/web` (T4 adds a test that enforces it).
- Out of bounds for every ticket (must-do 20, Done-means 16): `apps/relay/src`, `packages/core/src/domain`, `apps/web`, `supabase`,
  `~/.sam/work/amy-speed-test` (including `robot-batch.sh`, OPEN 9), tenant data, VOLTA's number and settings, Amy's VOLTA voice,
  prompt and model, and `main`. Never `supabase db reset` on this box.
- Match the surrounding code: long explanatory block comments, UK English, a named constant for every tunable (the locked values below).
- No audio recording on any errand call (OPEN 11): `Record` is never set on a call create.

## Locked values (named constants in `apps/errand/src/config.ts`, T4)

| constant | value | source |
|---|---|---|
| `ROBOT_NUMBER` | `+447861926390` | locked decision; must-do 7 |
| `GO_EXPIRY_MS` | 30 minutes | OPEN 2 |
| `TURN_CAP` | 20 (menu steps count) | OPEN 3; must-do 13 |
| `RING_TIMEOUT_S` | 30 | OPEN 3 |
| `MAX_CALL_S` | 480 (8 minutes) | OPEN 3 |
| `CONFUSED_LIMIT` | 2 turns in a row | must-do 12 |
| `MODEL_TIMEOUT_MS` | 8000 | Robustness "Failures and timeouts" |
| `CALL_CREATE_TIMEOUT_MS` | 15000, never retried | Robustness |
| `OUTCOME_REPORT_MS` | 2 minutes | must-do 16 |
| `NO_OUTCOME_ALERT_MS` | 20 minutes | must-do 19 |
| `RETENTION_DAYS` | 90 | OPEN 12 |
| `CALLING_HOURS` | 08:00 to 21:00, `Europe/London` | OPEN 14 |
| `OPENING_LINE` | "Hi, this is Amy, an automated assistant calling on behalf of Colin Wood." | OPEN 17 |
| `VOICE_ID` | `6fZce9LFNG3iEITDfqZZ` (ElevenLabs, en-GB) | locked decision (same voice as VOLTA) |
| `ERRAND_MODEL` | Amy's Gemini flash, name and effort from T2 | OPEN 10 |
| `MACHINE_DETECTION` | `DetectMessageEnd`, synchronous | OPEN 4; fact F2 |
| `ERRAND_PORT` | 3003 (free on 2026-10-26: 3000, 3001, 3002, 3010 in use) | T3 re-checks |
| `ERRAND_HOME` | `~/.sam/work/errand-caller/calls` | spec Robustness "Data model" |

---

# Facts and read-only checks (SAM-RUN, no live change)

## T1: SAM-RUN: the Go-button bridge contract (OPEN 1, read-only)
Status: TODO
Spec: must-do 3; OPEN 1 ("a Go button on Telegram or phone-push, written by the bridge; SAM cannot write it"); OPEN 2
Depends on: none
Blocked by: none
Context: The dial step must find a go record that the bridge wrote, not one SAM wrote. What exists today: `~/.sam/notify-colin.sh`
takes `--question <q_xxxxxxxx> --options "<a>|<b>" --job <job_id>` and passes them to `sam-push`, whose phone notification carries up to two
action buttons (`a`, `b`). A tap posts to SAM_ui `POST /api/questions/answer` (`~/SAM_ui/src/app/api/questions/answer/route.ts`: same-origin,
session, optional step-up for a gated question), which runs `closer_answer.py <jobId> <questionId> <a-f> <push|tab>`; that script says it is
"the only code that changes a question's state" and writes `answer`, `answeredAt` and `answeredVia` into the question inside
`~/.sam/jobs/<jobId>/closer.json`. Telegram is sent as plain text by `notify-colin.sh`; whether it carries buttons is not known.
Several copies of `closer_answer.py` exist under `~/.sam/work/`; the live one must be named.
Files: implementation/errand-caller-facts.md (new, section "A. Go-button bridge")
Steps:
1. Name the live `closer_answer.py` path (the one SAM_ui's `runAnswer` calls) and the live `closer.json` question shape: every field, which
   are set at creation and which only by an answer, and how a question is created on a job today (which tool or script, its arguments).
2. Say whether a question can be created without a fleet job (the push buttons need a `job_` id). If not, name the smallest supported way
   for a CLI to own a job id for an errand (for example a job record the errand tool creates), from the code, not guessed.
3. Say whether Telegram carries the buttons. If not, record that the Go button is the phone push (and the SAM tab), and Telegram carries the
   read-back text only.
4. Say whether a question can be marked gated (step-up required to answer) and how. Recommend gated for errand Go questions if it exists.
5. Write the go-record contract the dial step (T7) will read: file path pattern, the fields and values that mean "Colin tapped Go", what
   proves the bridge wrote it (`answeredVia` push or tab, written only by `closer_answer.py` under its lock), and any second trace the dial
   step can cross-check (for example a SAM_ui log line or `~/.sam/push-log.jsonl` entry for the answer), with its path and fields.
Do not touch: SAM_ui, the closer, any job, `notify-colin.sh`, `sam-push`. Send no notification.
Proof: before, `errand-caller-facts.md` does not exist. After: section A names the live script path, the question fields, how a question is
created, the Telegram buttons answer (yes or no), the gated answer, and a go-record contract a build agent can code against without opening
`~/.sam`.

## T2: SAM-RUN: Twilio, ConversationRelay and model facts (read-only)
Status: TODO
Spec: must-dos 7, 8, 13, 14; facts F1, F2; OPEN 4, 5, 6, 10, 16
Depends on: none
Blocked by: none
Context: The spec's Twilio facts came from a fetch agent's quotes ("re-check anything load-bearing at build", spec report). The build agents
need exact parameter names, values and frame shapes in the repo. Docs pages and the repo only; no account call.
Files: implementation/errand-caller-facts.md (edit, section "B. Twilio and model")
Steps:
1. Calls create (https://www.twilio.com/docs/voice/api/call-resource): exact names and allowed values for `MachineDetection`
   (`DetectMessageEnd`), `MachineDetectionTimeout` (default), `Timeout` (ring), `TimeLimit` (maximum length, seconds), `StatusCallback`,
   `StatusCallbackEvent`, `StatusCallbackMethod`; that `Record` defaults off. Quote each with its URL.
2. Answering-machine detection: the `AnsweredBy` values for `DetectMessageEnd` and on which request they arrive (the `Url` request when
   synchronous); the Call resource's read-back field for it (`answered_by`); whether `AsyncAmd` must be absent for synchronous. Quote.
3. ConversationRelay WebSocket messages: the `setup` frame's custom parameters field name; the `prompt` frame fields; the outbound `text`,
   `sendDigits` (digits charset quoted: "0-9, w, #, and *") and `end` messages; the `dtmf` inbound frame. Compare with the declared types in
   `apps/relay/src/protocol.ts` (read only) and note any difference.
4. ConversationRelay TwiML: what happens when `welcomeGreeting` is absent (documented or NOT DOCUMENTED; OPEN 6 says proceed, proven by
   Done-means 7), and what Twilio does after the `<Connect>` ends with and without an `action` URL.
5. Copy the exact ConversationRelay attributes VOLTA uses today from `apps/web/src/lib/conversation-relay.ts` (language, `ttsLanguage`,
   `ttsProvider`, `voice`, `transcriptionProvider`, `speechTimeout`, `interruptible`) so T13 can match them. Read only.
6. Amy's model (OPEN 10): the model name and thinking effort the VOLTA voice line runs today, from
   `~/.sam/work/amy-latency/speed-test/gemini-bench.md` (the `today` row) and `packages/core/src/ai/google.ts`. No database read.
7. Prices (OPEN 16): AMD $0.0075 a call, ConversationRelay about $0.07 a minute, as locked; record the pricing URLs read and the date.
8. End each step with FOUND (quote and URL) or NOT DOCUMENTED.
Do not touch: the Twilio account, the code.
Proof: before, section B does not exist. After: section B has eight steps, each with a FOUND or NOT DOCUMENTED line;
`grep -c "FOUND\|NOT DOCUMENTED" implementation/errand-caller-facts.md` prints at least 8.

## T3: SAM-RUN: baseline snapshot of the live box (read-only)
Status: TODO
Spec: must-dos 20, 22; Done-means 16, 18, 20 (the "before" figures); OPEN 8
Depends on: none
Blocked by: none
Context: Done-means 16 compares against a base commit and needs `atwood-relay`'s PID before and after the build; Done-means 18 and 20 need
today's `/relay` and `/api/health` answers; OPEN 8 leaves the robot number's voice URL as it is, so its read-back must be the same at the end.
The tunnel file cannot be printed (it names the credentials file); use `cloudflared tunnel --config ~/.cloudflared/receptionist.yml ingress rule <url>`,
which prints only the rule a URL matches.
Files: ~/.sam/work/errand-caller/baseline.md (new); implementation/errand-caller-facts.md (edit, section "C. Baseline", non-secret lines only)
Steps:
1. Base commit: `git rev-parse HEAD` on `restyle/glassmorphism` at the start of the build. Write it to both files.
2. `systemctl --user show atwood-relay -p MainPID -p ExecMainStartTimestamp`, the same for `receptionist-app-prod` and `receptionist-tunnel`.
3. Ingress: `ingress rule` for `https://receptionist.atwoodsystems.co.uk/relay`, `/api/health` and `/errand/twiml`. Record which rule each
   matches (expected: `/relay` to port 3002, the other two to the host-wide rule).
4. Public answers: `curl -s -o /dev/null -w '%{http_code}'` on `https://receptionist.atwoodsystems.co.uk/relay` (expect 426) and `/api/health` (expect 200).
5. Twilio GETs on the Dublin edge only, through the existing read-only scripts (`~/.sam/work/amy-speed-test/read-voice-url.mjs` or
   `robot-number.mjs`), masked: the VOLTA number's `voice_url`, `voice_method` and `status_callback`, and the robot number's (expected: no voice URL).
6. `systemctl --user list-units --all --plain --no-legend 'robot-*'` (expect none) and `pgrep -af robot-run.mjs` (expect none).
7. `ss -ltn` shows 3003 free.
Do not touch: any unit, the tunnel, the Twilio numbers, the database.
Proof: before, `baseline.md` does not exist. After: it holds all seven steps' read-backs with SIDs masked, and facts section C holds the base commit
and the ingress results.

---

# The errand path (build agents, nothing live)

## T4: Package scaffold `apps/errand` with the locked values and a boundary test
Status: DONE 2026-10-26 (errand 7/7 pass, typecheck clean; core 284, relay 86 unchanged; boundary mutation 6 pass 1 fail, reverted)
Spec: must-do 20; Rules above; locked decisions
Depends on: T2
Blocked by: none
Context: Errand calls get their own process (spec F4: the relay fixes its reply function when the socket opens and resolves a tenant from the
dialled number, so it cannot serve an errand). A new workspace package keeps the receptionist byte-identical. `pnpm-workspace.yaml` already
includes `apps/*`. Model the package on `apps/relay/package.json` (ESM, `node --experimental-strip-types`, `node --test`). It may depend on
`@atwood/core` for `./integrations/twilio` (signature check, TwiML builder) and `./ai` (Gemini provider) only.
Files: apps/errand/package.json (new), apps/errand/tsconfig.json (new), apps/errand/README.md (new), apps/errand/src/config.ts (new),
apps/errand/src/boundary.test.ts (new), pnpm-lock.yaml (edit by `pnpm install`)
Steps:
1. Package `@atwood/errand`, scripts `start`, `test`, `typecheck` as in the relay; dependencies `@atwood/core` (workspace) and `ws`.
2. `config.ts`: every value in "Locked values" as a named, commented constant; `ERRAND_MODEL` from facts section B step 6. Paths
   (`ERRAND_HOME`, the closer store, `notify-colin.sh`) default to the live locations and can be overridden by an environment variable for tests.
   A `requireTwilioBase()` that throws if `TWILIO_API_BASE_URL` is unset or its host is `api.twilio.com`.
3. `boundary.test.ts`: walks `apps/errand/src` and fails if any file imports `@supabase/`, `@atwood/core/domain`, `@atwood/core/supabase`,
   the core root index, or anything under `apps/relay` or `apps/web`; or contains the string `api.twilio.com` outside `config.ts`'s refusal
   check; or sets `Record` on a call create. Plus tests for `requireTwilioBase()`.
4. README: what the package is, the four entry points to come (server, CLI, watch, prune), and that it is the errand path of the spec.
Do not touch: `apps/relay`, `apps/web`, `packages/core`.
Proof: before, `apps/errand` does not exist. After: `pnpm --filter @atwood/errand test` and `typecheck` pass; core and relay counts unchanged;
temporarily adding `import '@atwood/core/domain'` to a source file makes the boundary test fail (revert it).

## T5: Errand folder store: id, brief, events, transcript, outcome
Status: DONE 2026-10-26 (errand 23/23 pass, 16 new; core 284, relay 86 unchanged)
Spec: must-dos 1, 17; Robustness "Data model"
Depends on: T4
Blocked by: none
Context: One folder per errand under `ERRAND_HOME/<errand id>/`, the id being the date, time and a short slug (for example
`2026-10-27-1412-luigis-table`). It holds the brief, the read-back, the go, a call-event log, a transcript (one line per turn: speaker,
words, time) and the outcome; the CallSid ties it to Twilio's record. No database rows.
Files: apps/errand/src/store.ts (new), apps/errand/src/brief.ts (new), apps/errand/src/store.test.ts (new), apps/errand/src/brief.test.ts (new)
Steps:
1. `brief.ts`: the brief type and validator for must-do 1: `business` (name), `number` (as given), `goal` (plain words), `window` (`date`,
   `earliest`, `latest`, local UK time), `details` (free key-value, for a table: `partySize` required when the goal kind is `table`),
   `contact` (`name`, `mobile`: Colin's), `limits` (the fixed guardrails listed by name, plus any Colin adds as text). A validation error names the field.
2. `briefHash(brief)`: sha256 of canonical JSON (sorted keys). Any edit to any field changes it.
3. `store.ts`: `newErrand(brief, now)` creates the folder (mode 700) with `brief.json`; the id regex is `^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9-]{1,40}$`
   and every path is built from a validated id only. Writers: `readback.json`, `go-used.json` (created with exclusive create, so a second write
   fails), `events.jsonl` (append: time, kind, fields), `transcript.jsonl` (append: time, speaker `amy` or `them`, words), `outcome.json`
   (written once: a second write fails), `alert.json` (written once). Readers for each. Files mode 600.
4. Tests in a temp `ERRAND_HOME`: a bad id is refused before any path is built; a table brief with no party size fails naming it; the hash changes
   on any field edit; `go-used.json` and `outcome.json` cannot be written twice; the folder holds every must-do 17 part after a scripted sequence.
Do not touch: anything outside `apps/errand`.
Proof: before, the test files do not exist. After: the errand suite passes with the new tests, which failed before (module absent).

## T6: Read-back message and the Go question
Status: DONE 2026-10-26 (errand 30/30 pass, 7 new; core 284, relay 86 unchanged)
Spec: must-dos 2, 3; OPEN 1; Done-means 1
Depends on: T1, T5
Blocked by: none
Context: SAM reads the whole brief back to Colin in one message, with the number exactly as it will be dialled, and the Go button rides on that
message (facts section A). The read-back records the brief hash it was built from, so any edit afterwards voids the go (T7).
Files: apps/errand/src/readback.ts (new), apps/errand/src/readback.test.ts (new)
Steps:
1. `renderReadback(brief, dialNumber)`: one message, one line per brief field in a fixed order, the number in E.164 (as dialled) and spaced
   (`+44 7700 900123`), the window as "Tue 28 Oct, between 19:00 and 20:30", the limits listed, a short hash tag (first 8 of the brief hash), and
   the closing line "Tap Go to place this call. Nothing dials without it."
2. `sendReadback(errandId, deps)`: validates the brief, normalises the number (T8's normaliser; a refused number stops here and says why),
   creates the Go question by the contract in facts section A (options "Go" and "Cancel", gated if section A step 4 allows), sends it through
   `notify-colin.sh` with `--question`, `--options`, `--job` and `--full <read-back>`, and writes `readback.json`: text, brief hash,
   question id, job id, sent time. The notifier and the question creator are injected.
3. Tests with fakes: every brief field appears in the text; the number line equals the dialled E.164 exactly; `readback.json` holds the hash;
   a refused number sends nothing; the notifier is called once with the question id.
Do not touch: `notify-colin.sh`, SAM_ui, the closer (call them only through the injected functions).
Proof: before, the test file does not exist. After: the errand suite passes with the new tests, which failed before.

## T7: Go-record check (must-do 3)
Status: DONE 2026-10-26 (errand 48/48 pass, 18 new; core 284, relay 86 unchanged)
Spec: must-do 3; OPEN 1, OPEN 2; Done-means 2
Depends on: T1, T5, T6
Blocked by: none
Context: Nothing dials without Colin's explicit go for that exact read-back. The go is valid only if it (a) matches the brief as read back,
(b) is younger than 30 minutes, (c) has not been used. The record is the bridge's (facts section A); SAM cannot write it, and the check reads
only the bridge's file, never anything SAM writes in the errand folder.
Files: apps/errand/src/go.ts (new), apps/errand/src/go.test.ts (new)
Steps:
1. `checkGo(errandId, now, deps)` returns `{ ok: true, go }` or `{ ok: false, reason }`. Refuse with a named reason when: no `readback.json`;
   no bridge record for the read-back's question id; the answer is not Go (Cancel or unanswered); `answeredVia` is not push or tab; the
   second trace from section A step 5 is missing (if section A found one); `answeredAt` is before the read-back's sent time; `now - answeredAt`
   is 30 minutes or more; the current `briefHash` differs from the read-back's ("brief edited after read-back"); `go-used.json` exists.
2. `markGoUsed(errandId, go, now)` writes `go-used.json` with exclusive create; a race loses cleanly with "go already used".
3. Tests with a fake bridge store in a temp folder: each refusal above returns its reason; a valid go returns ok; a go 29 minutes 59 seconds old
   passes and 30 minutes fails; a second `markGoUsed` fails.
Do not touch: the closer, SAM_ui.
Proof: before, the test file does not exist. After: the errand suite passes with the new tests, which failed before.

## T8: Number and calling-hours guards (must-do 4, OPEN 13, OPEN 14)
Status: DONE 2026-10-26 (errand 91/91 pass, 43 new; core 284, relay 86 unchanged)
Spec: must-do 4; OPEN 13; OPEN 14; Done-means 3
Depends on: T4
Blocked by: none
Context: Allowed: UK 01, 02, 03, 07 mobiles (071 to 075, 077 to 079) and 080 freephone. Refused: 999, 112, 09 (premium), 118 (directory),
070 (personal), 076 (pagers), 084 and 087 (OPEN 13), anything else, and anything outside +44. No dialling outside 08:00 to 21:00 UK time.
Files: apps/errand/src/guards/number.ts (new), apps/errand/src/guards/hours.ts (new), apps/errand/src/guards/number.test.ts (new),
apps/errand/src/guards/hours.test.ts (new)
Steps:
1. `normaliseUkNumber(input)`: strips spaces, brackets and dashes; `0...` becomes `+44...`; `0044` becomes `+44`; returns the E.164 or a refusal
   with its reason ("premium or chargeable", "personal number", "pager", "084/087 refused in the first release", "emergency number",
   "outside the UK", "not a UK number shape"). 999 and 112 are refused before any normalising.
2. `checkCallingHours(now)`: refuses outside 08:00 to 21:00 `Europe/London` (21:00 itself refused), saying the UK time now.
3. Tests: a table of numbers covering Done-means 3 (999, 112, 09xx, 118xxx, 070, 076, 084, 087, a +33 number refused; 01, 02, 03, 07 mobile,
   080 allowed) in local and E.164 forms; hours at 07:59, 08:00, 20:59, 21:00 in both GMT and BST dates.
Do not touch: anything outside `apps/errand`.
Proof: before, the test files do not exist. After: the errand suite passes; every row of the table has its expected result.

## T9: Batch guard and one-errand-at-a-time guard (must-dos 5, 6)
Status: DONE 2026-10-26 (errand 102/102 pass, 11 new; core 284, relay 86 unchanged)
Spec: must-dos 5, 6; fact F5; OPEN 9; Done-means 4, 5
Depends on: T5
Blocked by: none
Context: Batch runs are transient user units named `robot-<variant>-<n>` (`systemd-run --user`); manual runs are `robot-run.mjs` processes.
The guard is one-way (OPEN 9): no change to `robot-batch.sh`. One errand call at a time.
Files: apps/errand/src/guards/batch.ts (new), apps/errand/src/guards/live.ts (new), apps/errand/src/guards/batch.test.ts (new),
apps/errand/src/guards/live.test.ts (new)
Steps:
1. `checkBatch(deps)`: runs `systemctl --user list-units --all --plain --no-legend 'robot-*'` and `pgrep -af robot-run.mjs` through an injected
   runner; refuses naming every loaded `robot-*` unit (timer or service) and every live `robot-run.mjs` PID. A runner error refuses too
   ("cannot check robot batch"), never passes open.
2. `checkNoLiveErrand(now, deps)`: refuses if any errand folder has a `dialled` event and no `outcome.json` and was dialled less than
   `MAX_CALL_S` plus 5 minutes ago, naming that errand id. Older ones are left to the watchdog (T18), not counted as live.
3. Tests with a fake runner: `robot-guardtest-1.service` loaded refuses and names it; a `robot-today-3.timer` refuses; a live
   `robot-run.mjs` refuses with its PID; an empty listing passes; a runner error refuses. A second errand while one is live is refused (Done-means 5).
Do not touch: `~/.sam/work/amy-speed-test`, systemd.
Proof: before, the test files do not exist. After: the errand suite passes with the new tests, which failed before.

## T10: Errand call create on the Dublin edge (must-do 7)
Status: DONE 2026-10-26 (errand 106/106 pass, 4 new; core 284, relay 86 unchanged)
Spec: must-do 7; OPEN 3, OPEN 4; Robustness "Failures and timeouts"; Done-means 9 (maximum length on every create)
Depends on: T2, T4
Blocked by: none
Context: Core's `placeCall` (`packages/core/src/integrations/twilio.ts`) has no machine detection or time limit and falls back to
`api.twilio.com` when the base is unset. The errand path has its own small create function instead, so the receptionist's code is unchanged.
Synchronous `DetectMessageEnd` needs a `Url` (inline `Twiml` gets no `AnsweredBy`; fact F2).
Files: apps/errand/src/twilio-call.ts (new), apps/errand/src/twilio-call.test.ts (new)
Steps:
1. `createErrandCall({ errandId, to }, deps)`: POST `${requireTwilioBase()}/Accounts/<sid>/Calls.json` with `From` `ROBOT_NUMBER`, `To`,
   `Url` `https://receptionist.atwoodsystems.co.uk/errand/twiml?errand=<id>`, `Method` POST, `StatusCallback` `.../errand/status?errand=<id>`,
   `StatusCallbackEvent` `initiated ringing answered completed`, `StatusCallbackMethod` POST, `MachineDetection` `DetectMessageEnd`,
   `Timeout` `RING_TIMEOUT_S`, `TimeLimit` `MAX_CALL_S`. Never `Record`, never `AsyncAmd`. Parameter names exactly as in facts section B.
2. Abort at `CALL_CREATE_TIMEOUT_MS`; never retry. Return the CallSid or a failure class (timeout, rejected with Twilio's code, other).
   The SID and token come from the environment and are never logged; the CallSid is logged masked.
3. Tests with a fake `fetch` that counts requests: the body carries every parameter above with the locked values; the URL host is the
   configured base; a base of `api.twilio.com` or none throws before any request; a slow fake is aborted at 15 s and the count stays 1.
Do not touch: `packages/core/src/integrations/twilio.ts`.
Proof: before, the test file does not exist. After: the errand suite passes with the new tests, which failed before.

## T11: The dial step `errand dial` (must-dos 3 to 7, 18)
Status: DONE 2026-10-26 (errand 121/121 pass, 15 new; mutation: 21 fail incl. the 4 go dial tests, restored go.ts diff empty; core 284, relay 86 unchanged)
Spec: must-dos 3, 4, 5, 6, 7, 18; Done-means 2, 4, 5, 14, 20
Depends on: T7, T8, T9, T10
Blocked by: none
Context: The one place a call is created. Every guard runs before the create; a refusal says why and places no call. The rollback rehearsal
(Done-means 20) needs "errand service down" when the errand service is not answering. `--check` runs every guard and stops before the create,
so the live guard check (T24) can prove a pass without dialling.
Files: apps/errand/src/dial.ts (new), apps/errand/src/dial.test.ts (new)
Steps:
1. `dial(errandId, { check }, deps)` in this order, stopping at the first refusal: errand service health (`GET http://127.0.0.1:3003/errand/health`,
   2 s timeout; refusal "errand service down"); go (T7); number (T8); calling hours (T8); batch (T9); no live errand (T9).
2. With every guard passed and no `--check`: `markGoUsed`, then `createErrandCall`, append a `dialled` event (CallSid masked, time), and schedule
   the watchdog with `systemd-run --user --on-active=20m --unit=errand-watch-<id> <errand CLI> watch <id>` through an injected runner
   (the unit name never starts with `robot-`). A failed create writes `outcome.json` "not reached: failed to place" and sends the outcome (T17); it
   never retries and never calls create again.
3. Exit codes: 0 placed (or all guards pass under `--check`), 3 refused, 1 internal. One plain line to stdout naming the result or the refusal reason.
   Under `--check` every guard runs (no stop at the first refusal) and prints one line each (`batch: pass`, `go: refused: no read-back`), so a single
   guard can be proved on the live box without a valid go.
4. Tests with a fake Twilio that counts creates (Done-means 2): no go, a go for a brief edited after read-back, an expired go and a used go each
   give zero creates and their reason; a valid go gives exactly one; a second `dial` on the same errand gives zero (used go, must-do 18); service down
   refuses with "errand service down"; `--check` never creates; a failed create is not retried (count 1).
5. Mutation check (Done-means 2): temporarily replace `checkGo` with one that returns ok, run the tests, confirm the four go tests fail, restore.
   Write the before and after counts in the ticket's report.
Do not touch: anything outside `apps/errand`.
Proof: before, the test file does not exist. After: the errand suite passes; the mutation check's failing count is recorded; the restored code is
identical to the committed code (`git diff` on `go.ts` empty).

## T12: Errand server: own process, own endpoints, Twilio signatures fail closed (must-dos 20, 21)
Status: DONE 2026-10-26 (errand 137/137 pass, 16 new; core 284, relay 86 unchanged; public-hostname refusals owed to SAM at T23)
Spec: must-dos 20, 21; Done-means 17
Depends on: T4
Blocked by: none
Context: One Node process on 127.0.0.1:3003 serving `POST /errand/twiml`, `POST /errand/status`, the WebSocket `/errand/ws` and
`GET /errand/health`. Signatures are checked with `@atwood/core/integrations/twilio`'s `validateTwilioSignature` and `reconstructTwilioUrl`,
the same audited implementation the relay uses. For the socket, follow the relay's approach in `apps/relay/src/signature.ts` (read only, do not
import from it): Twilio signs the `wss://` form (measured 2026-09-16); offer the `https://` form too and log which matched.
Files: apps/errand/src/server.ts (new), apps/errand/src/signature.ts (new), apps/errand/src/server.test.ts (new), apps/errand/src/signature.test.ts (new)
Steps:
1. HTTP server and `ws` server on `ERRAND_PORT`, bound to 127.0.0.1. Public origin `https://receptionist.atwoodsystems.co.uk` from a constant.
2. Every Twilio route checks `X-Twilio-Signature` against the public URL (with query string) and the form body; missing auth token, missing header
   or a mismatch answers 403 with no body detail and logs one line. The socket upgrade is refused (HTTP 403, no upgrade) the same way.
3. `/errand/health` answers 200 `{ ok: true }` only to a request from 127.0.0.1 with no `CF-Connecting-IP` header (so it is not public), else 404.
4. Errand ids in query strings are validated with the T5 regex before use; an unknown or bad id on `/errand/twiml` returns a hang-up TwiML.
5. Tests with a known test token: unsigned and wrongly signed requests to each route and the upgrade are refused; correctly signed ones pass;
   a health request with `CF-Connecting-IP` gets 404.
Do not touch: `apps/relay`.
Proof: before, the test files do not exist. After: the errand suite passes with the new tests, which failed before.

## T13: Call instructions (TwiML) endpoint: person or machine (must-dos 8, 14)
Status: DONE 2026-10-26 (errand 145/145 pass, 8 new; core 284, relay 86 unchanged; live detection proofs owed to SAM at T25/T28)
Spec: must-dos 8, 14; fact F2; OPEN 4, 5, 6; Done-means 6, 11
Depends on: T2, T5, T12
Blocked by: none
Context: With synchronous detection, Twilio posts `AnsweredBy` on the `Url` request after the greeting ends (machine) or the person speaks
(human). Amy waits for the person to speak first, so the person path has no `welcomeGreeting` (OPEN 6, proven by Done-means 7).
A machine gets one short message in Amy's voice, then hang-up. `unknown` is treated as a person. The `setup` frame carries no `AnsweredBy`,
so it is passed as a `<Parameter>`.
Files: apps/errand/src/twiml.ts (new), apps/errand/src/twiml.test.ts (new), apps/errand/src/server.ts (edit)
Steps:
1. Append an `answered` event with the `AnsweredBy` value and the masked CallSid to `events.jsonl`.
2. `human`, `unknown` or absent: `buildConversationRelayTwiml` with url `wss://receptionist.atwoodsystems.co.uk/errand/ws`, no
   `welcomeGreeting`, and the voice attributes copied from facts section B step 5 (ElevenLabs `VOICE_ID`, `en-GB`, `ttsLanguage` `en-GB`,
   transcription provider and `speechTimeout` as VOLTA), `dtmfDetection` on, parameters `errandId`, `answeredBy`, `mode=person`.
3. `machine_end_beep`, `machine_end_silence`, `machine_end_other`: the same TwiML with `mode=voicemail` (Amy's voice says the message; T16).
4. `fax`, or any `machine_start` value: `<Hangup/>` and the outcome later reads "not reached: machine without a message point".
5. Tests: each `AnsweredBy` value gives the expected mode; no `welcomeGreeting` attribute in any output; the voice attribute equals `VOICE_ID`;
   an unsigned request is refused (T12).
Do not touch: `apps/web/src/lib/conversation-relay.ts` (copy its values; never import it).
Proof: before, the test file does not exist. After: the errand suite passes with the new tests, which failed before.

## T14: Guardrails checked in code (must-dos 9, 10, 11, 15)
Status: DONE 2026-10-26 (errand 156/156 pass, 11 new; core 284, relay 86 unchanged)
Spec: must-dos 9, 10, 11, 15; Done-means 7, 8
Depends on: T5
Blocked by: none
Context: The prompt alone does not enforce these. Pure functions, run on every turn by the turn engine (T15): one on what the other side says,
one on what Amy is about to say.
Files: apps/errand/src/guardrails.ts (new), apps/errand/src/guardrails.test.ts (new)
Steps:
1. `checkTheirWords(text)`: detects a payment ask (card, card number, long card number, card details, expiry, CVV or security code, deposit,
   pre-payment, pay now, bank details, sort code, account number, a run of 12 or more digits read out). Returns `payment` with the matched kind.
2. `checkAmyLine(line, brief)`: blocks a line that holds any phone number other than Colin's mobile (and always blocks the robot number), an email
   address, a postal address, a date of birth, or a card or bank detail; blocks agreement words on anything beyond the goal (deposit, extra,
   sign-up, membership, change to another booking). A blocked line is replaced by a fixed line: personal details → "Colin will give that to you
   directly."; extras → "I can only book the table today, thank you."
3. `checkAgreedTime(time, window)`: a time Amy would agree must sit inside the window (date, earliest, latest, inclusive). Outside → refused, and
   the time is added to `offeredTimes`.
4. `callbackNumber(brief)` always returns Colin's mobile from the brief.
5. Tests (Done-means 8): "can I take a card number", "we need a deposit", "what's the long number on the card", "bank details please" each return
   `payment`; ordinary booking talk does not; a line holding the robot number or an email is blocked; a time one minute outside the window is
   refused and recorded as offered; the callback number is Colin's mobile.
Do not touch: `packages/core/src/domain/handover.ts` and its patterns (the receptionist's own; do not reuse or change them).
Proof: before, the test file does not exist. After: the errand suite passes with the new tests, which failed before.

## T15: Turn engine and the errand prompt (must-dos 8, 9, 12, 13, 15)
Status: DONE 2026-10-26 (errand 173/173 pass, 17 new; core 284, relay 86 unchanged)
Spec: must-dos 8, 9, 12, 13, 15; OPEN 3, OPEN 10, OPEN 17; Done-means 7, 9
Depends on: T2, T14
Blocked by: none
Context: Each turn the model gets the errand prompt and the transcript so far and returns a structured decision; code then applies the
guardrails and the caps. Model: `ERRAND_MODEL` (Amy's Gemini flash, OPEN 10) through `@atwood/core/ai`'s `GoogleProvider`, timed out at
`MODEL_TIMEOUT_MS`. Pure apart from the injected model.
Files: apps/errand/src/prompt.ts (new), apps/errand/src/turn.ts (new), apps/errand/src/turn.test.ts (new), apps/errand/src/prompt.test.ts (new)
Steps:
1. `buildErrandPrompt(brief)`: who Amy is calling for, the goal, the window, the details, Colin's name and mobile, the rules (disclose, inside the
   window only, nothing beyond the goal, no payment, menus by digits), and the JSON reply shape: `{ say, digits?, agreedTime?, offeredTimes?,
   reference?, nameBookedUnder?, done?: "booked" | "not_booked", cannotPlace?: boolean }`.
2. `nextTurn(state, theirWords, deps)`: order: count the turn; `checkTheirWords` payment → polite ring-off line and end, outcome "ended early:
   payment asked"; call the model (timeout or error → fixed line "Sorry, I'll have to call back another time. Goodbye.", end, outcome "failed");
   apply `checkAgreedTime` and `checkAmyLine`; `cannotPlace` twice in a row → polite ring-off, outcome "ended early: confused"; turn count reaching
   `TURN_CAP` → polite ring-off, outcome "ended early: turn cap"; digits filtered to `0-9*#` (anything else dropped and logged; a digits-only turn
   counts towards the cap, must-do 13).
3. Disclosure in code (must-do 8): Amy's first spoken line always starts with `OPENING_LINE` (prefixed if the model left it out); if their words ask
   whether she is a person or a robot, the line must say she is an automated assistant (prefixed if missing).
4. Window (must-do 9): when only outside times were offered and the model ends, the outcome is "not booked" with the offered times; Amy says thanks
   and ends. No second goal is tried (Won't do: "any other night").
5. Tests with a fake model: the first line starts with the opening line; "are you a real person?" gets "automated assistant"; an outside time then an
   inside time ends "booked" with the inside time; the 20th turn ends "turn cap"; two `cannotPlace` turns end "confused"; a model that takes 9 s
   ends "failed"; a payment ask ends before the model is called; digits "1w#" become "1#".
Do not touch: `packages/core/src/ai/google.ts`, the receptionist prompts.
Proof: before, the test files do not exist. After: the errand suite passes with the new tests, which failed before.

## T16: Errand socket session: person, menus and voicemail (must-dos 8, 12, 13, 14)
Status: DONE 2026-10-26 (errand 184/184 pass, 11 new; core 284, relay 86 unchanged; live voicemail and wait-first proofs owed to SAM at T26/T28)
Spec: must-dos 8, 12, 13, 14, 17; fact F1; Done-means 7, 9, 11
Depends on: T12, T13, T15
Blocked by: none
Context: The `/errand/ws` socket runs one session per call. Person mode waits for the other side, then runs a turn per final `prompt`
frame. Voicemail mode speaks one message and ends, with no back-and-forth. Every turn goes to the transcript with its time.
Files: apps/errand/src/session.ts (new), apps/errand/src/session.test.ts (new), apps/errand/src/server.ts (edit)
Steps:
1. On `setup`: read `errandId`, `answeredBy`, `mode` from the custom parameters (field name from facts section B step 3); load the brief; an unknown
   errand ends the session at once.
2. Person mode: send nothing until the first final `prompt` (must-do 8: Amy waits). For each final prompt: write a `them` transcript line, run
   `nextTurn`, send `text` (last true), then `sendDigits` if any (with a `digits` event), write an `amy` line; on an ending decision send the line,
   wait for it to play (fixed allowance per word, named constant), then `end`. Partial prompts are ignored. Inbound `dtmf` frames are logged as events.
3. Voicemail mode: send one `text`: `OPENING_LINE` plus the request in one sentence plus "Please call Colin back on <mobile>. Thank you, goodbye.";
   ignore every prompt; `end` after the play allowance; outcome "voicemail left".
4. A session timer at `MAX_CALL_S` minus 10 s says a polite ring-off line and ends with outcome "ended early: maximum length" (Twilio's `TimeLimit`
   is the hard stop behind it). A socket drop with no outcome leaves it to the status callback (T17).
5. The session writes its outcome to `outcome.json` through the store (write-once) and never sends Telegram itself (T17 does, once).
6. Tests with a fake socket and fake model: no frame is sent before the first prompt; a menu prompt producing digits sends `sendDigits`; voicemail mode
   sends exactly one `text` then `end` and ignores a later prompt; the max-length timer ends with its outcome (fake clock); every turn is in the
   transcript with speaker, words and time.
Do not touch: `apps/relay/src` (including its `RelaySession`).
Proof: before, the test file does not exist. After: the errand suite passes with the new tests, which failed before.

## T17: Status callback, outcome and the Telegram report (must-dos 16, 17, 18)
Status: DONE 2026-10-26 (errand 202/202 pass, 18 new; core 284, relay 86 unchanged; live 2-minute Telegram owed to SAM at T25-T29)
Spec: must-dos 12 (outcome says which limit), 16, 17, 18; Robustness "Monitoring and alerts"; Done-means 12, 14
Depends on: T5, T12, T16
Blocked by: none
Context: Twilio posts every status change to `/errand/status`. On the terminal one, the outcome is settled and Colin gets exactly one message,
within 2 minutes of the call ending. `notify-colin.sh` sends Telegram first and falls back to the phone push if Telegram fails; the outcome stays on disk.
Files: apps/errand/src/status.ts (new), apps/errand/src/report.ts (new), apps/errand/src/status.test.ts (new), apps/errand/src/report.test.ts (new),
apps/errand/src/server.ts (edit)
Steps:
1. Append every status post (status, `AnsweredBy` if present, duration, time, masked CallSid) to `events.jsonl`.
2. On `completed`, `no-answer`, `busy`, `failed` or `canceled`: if `outcome.json` is absent, write it: `no-answer`, `busy`, `failed` →
   "not reached" with the reason; `completed` with a duration of `MAX_CALL_S` or more → "ended early: maximum length"; `completed` otherwise →
   "failed: call ended with no outcome".
3. `renderOutcome(outcome, brief)` gives the message for each kind in must-do 16: booked (date, time, name booked under, reference if any);
   not booked (why, times offered); voicemail left; not reached (no answer, busy or failed); ended early (payment asked, confused, turn cap, maximum length);
   failed. Title "Errand: <business>: <kind>".
4. Send once: a `reported` event is written with exclusive create before calling the notifier, so a repeated status post never sends twice. The
   notifier (`notify-colin.sh <title> <body> --full <text>`) is injected; its exit code and time go into the event.
5. The status handler never imports or calls `createErrandCall` (must-do 18); a test asserts it.
6. Tests: each kind renders its fields; two `completed` posts send one message; `no-answer` writes "not reached" and makes zero call creates (Done-means 14);
   a duration of 480 gives "maximum length"; a notifier failure is recorded and the outcome file stays.
Do not touch: `notify-colin.sh`.
Proof: before, the test files do not exist. After: the errand suite passes with the new tests, which failed before.

## T18: Watchdog and retention (must-do 19, OPEN 12)
Status: DONE 2026-10-26 (errand 209/209 pass, 7 new; core 284, relay 86 unchanged)
Spec: must-do 19; OPEN 12; Robustness "Backups and restore", "Monitoring and alerts"; Done-means 15
Depends on: T5, T17
Blocked by: none
Context: The dial step schedules `errand watch <id>` 20 minutes after dialling (T11). If no outcome exists then, Colin gets one alert. Errand folders
are kept 90 days; the prune runs daily from a timer installed at deploy (T22).
Files: apps/errand/src/watch.ts (new), apps/errand/src/prune.ts (new), apps/errand/src/watch.test.ts (new), apps/errand/src/prune.test.ts (new)
Steps:
1. `watch(errandId, now, deps)`: if `outcome.json` exists, exit 0 silently. If dialled at least `NO_OUTCOME_ALERT_MS` ago with no outcome and no
   `alert.json`: write `alert.json` (exclusive create), send one alert "Errand <id> dialled at <time> has no outcome after 20 minutes". If not yet
   20 minutes, do nothing (the transient timer fired early).
2. `prune(now, { dryRun }, deps)`: lists folders whose id date is more than `RETENTION_DAYS` days before `now`, and removes them unless `dryRun`.
   A folder without an `outcome.json` and dialled less than a day ago is never pruned. Prints the count and ids.
3. Tests with a fake clock (Done-means 15): 19 minutes 59 seconds no alert; 20 minutes one alert; a second run no second alert; an outcome present
   no alert. Prune: 91 days removed, 89 kept, dry run removes nothing.
Do not touch: `sam-backup`, the live calls folder.
Proof: before, the test files do not exist. After: the errand suite passes with the new tests, which failed before.

## T19: The `errand` command line for SAM
Status: DONE 2026-10-26 (errand 235/235 pass, 26 new; core 284, relay 86 unchanged)
Spec: must-dos 1, 2, 3, 17; Won't do ("chat in, Telegram out, files on disk")
Depends on: T6, T11, T17, T18
Blocked by: none
Context: SAM drives the errand from chat with one command. Credentials arrive through `with-secrets --as errand-caller` (T20 stages the rows).
Files: apps/errand/src/cli.ts (new), apps/errand/src/cli.test.ts (new), apps/errand/SAM.md (new)
Steps:
1. Subcommands: `new <brief.json>` (validate, create the folder, print the id), `readback <id>` (T6), `dial <id> [--check]` (T11),
   `status <id>` (prints the brief summary, events, transcript and outcome in plain text), `watch <id>` (T18), `prune [--dry-run]` (T18),
   `list` (ids with their state). Bad usage exits 2.
2. `SAM.md`: how SAM turns Colin's chat into a brief (every must-do 1 field; ask Colin for any missing one, never guess the number or the
   window), runs `new` then `readback`, waits for Colin's tap, runs `dial`, tells Colin at once in chat if a dial is refused and why, and never
   runs `dial` twice for one go. States that SAM never writes the bridge's go record. States how to answer questions from `status <id>`.
3. Tests: each subcommand's usage errors; `new` then `status` in a temp `ERRAND_HOME`; `dial` without a go prints the refusal and exits 3.
Do not touch: `~/.local/bin` (the wrapper is installed at T22).
Proof: before, the test file does not exist. After: the errand suite passes with the new tests, which failed before.

## T20: Unit files, keystore rows, tunnel rule and runbook, staged in the repo (must-do 22, rollback)
Status: DONE 2026-10-26 (errand 243/243 pass, 8 new; core 284, relay 86 unchanged; keystore column format and with-secrets path owed to SAM at T22)
Spec: must-dos 20, 22; Robustness "Rollback", "Auth and secrets", "Backups and restore"; Done-means 18, 20
Depends on: T12, T18, T19
Blocked by: none
Context: Everything the deploy GATE (T22) and the tunnel GATE (T23) will apply, written as files in the repo so Colin can read them first. Nothing
is installed here. Model the unit on `apps/relay/atwood-relay.service` (tarball Node, absolute path, `Restart=always`, light hardening), but launched
through `with-secrets --as errand-caller` as the keystore expects (`~/.sam/consumer-map.tsv` lint: a launch row must contain `with-secrets --as <ID>`).
Files: apps/errand/deploy/atwood-errand.service (new), apps/errand/deploy/errand-prune.service (new), apps/errand/deploy/errand-prune.timer (new),
apps/errand/deploy/errand (new, CLI wrapper), apps/errand/deploy/keystore-rows.tsv (new, staged), apps/errand/deploy/tunnel-rule.yml (new),
apps/errand/deploy/RUNBOOK.md (new)
Steps:
1. `atwood-errand.service`: `ExecStart` via `with-secrets --as errand-caller` running `~/.local/node/bin/node --experimental-strip-types src/server.ts`
   in `apps/errand`, `Environment=ERRAND_PORT=3003`, `NoNewPrivileges=yes`, `PrivateTmp=yes`, `LimitCORE=0`.
2. `errand-prune.timer`: daily at 04:40 (after `sam-backup` at 04:16), running `errand prune`.
3. `errand` wrapper: runs the CLI through `with-secrets --as errand-caller` with the tarball Node.
4. `keystore-rows.tsv`: consumer `errand-caller` (service and tool) granted `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_BASE_URL` and
   `GOOGLE_API_KEY`, by name only; the launch, restart, health and status rows in the map's format. Names only, no values.
5. `tunnel-rule.yml`: the one ingress rule `hostname: receptionist.atwoodsystems.co.uk`, `path: ^/errand/(twiml|status|ws)$`,
   `service: http://localhost:3003`, to be placed before the host-wide rule (must-do 22). `/errand/health` is deliberately not matched.
6. `RUNBOOK.md`: deploy steps (T22), tunnel add and read-back (T23), rollback (stop and disable `atwood-errand`, remove the one rule, restart the
   tunnel, check `/relay` 426 and `/api/health` 200, a dial then refuses "errand service down"), restore, and the base commit from facts section C.
7. A test that parses `tunnel-rule.yml` and checks the path regex matches the three errand paths and not `/relay`, `/api/health` or `/errand/health`.
Do not touch: `~/.config/systemd/user`, `~/.cloudflared`, `~/.sam/consumer-map.tsv`, `~/.local/bin`.
Proof: before, `apps/errand/deploy` does not exist. After: the seven files exist, the rule test passes, and the runbook names each GATE step.

## T21: Suites green, boundary diff, mutation check and commit
Status: DONE 2026-10-26 (core 284, relay 86 = T4 baseline; errand 243/243; web typecheck clean; boundary diff empty; mutation 23 fail, go.ts restored identical; branch cloud/errand-caller, pushed; Atwood gate not available in the cloud, owed to SAM)
Spec: must-do 20; Done-means 2 (mutation check), 16 (code part)
Depends on: T4 to T20
Blocked by: none
Context: Closes the build before anything live. The boundary diff here is the code half of Done-means 16; T30 repeats it after the live tests.
Files: implementation/errand-caller-build-report.md (new)
Steps:
1. Run core, relay and errand tests and typechecks, and the web typecheck. Record the counts; core and relay equal the T4 baseline.
2. `git diff --stat <base commit from facts section C>..HEAD -- apps/relay/src packages/core/src/domain apps/web supabase` prints nothing.
3. Re-run T11 step 5's mutation check and record the failing count.
4. Commit on `restyle/glassmorphism` through the Atwood gate. No push.
Do not touch: anything live.
Proof: before, the report does not exist. After: it records the four suites' counts, the empty boundary diff, the mutation result and the commit SHA.

---

# Live (GATE: SAM with Colin, never a build agent)

## T22: GATE: deploy the errand service (Colin's go)
Status: TODO
Spec: must-dos 20, 21; Robustness "Auth and secrets", "Backups and restore"; Done-means 16 (PID), 20 (service part)
Depends on: T3, T21
Blocked by: Colin's go
Context: Adds a new unit, a timer, a CLI wrapper and keystore rows. Restarts nothing that exists: `atwood-relay` and `receptionist-app-prod`
keep their PIDs. With no tunnel rule yet, the service is reachable only on 127.0.0.1.
Files: ~/.sam/work/errand-caller/deploy.md (new); the files from `apps/errand/deploy/` installed as `RUNBOOK.md` says
Steps:
1. SAM states to Colin: the commit, the four things installed, that no existing service restarts. Wait for go.
2. Confirm HEAD is T21's commit; all suites green.
3. Apply the staged keystore rows (back up `consumer-map.tsv` first, the house way); `with-secrets --check-wiring` clean for `errand-caller`.
4. Install `atwood-errand.service`, `errand-prune.service` and `.timer`, and `~/.local/bin/errand`; `daemon-reload`; enable and start.
5. Read back: `curl -s http://127.0.0.1:3003/errand/health` 200; the unit's start time; `atwood-relay` and `receptionist-app-prod` PIDs equal T3's;
   `errand list` runs; `errand-prune.timer` next run shown.
Do not touch: the tunnel, the Twilio numbers, the relay, the web app, the env file.
Proof: before, `deploy.md` does not exist. After: it records the commit, the health answer, the unit start time, both unchanged PIDs and the timer.

## T23: GATE: the errand tunnel rule (must-do 22, Colin's go)
Status: TODO
Spec: must-dos 21, 22; Done-means 17, 18
Depends on: T22
Blocked by: Colin's go
Context: One new ingress rule before the host-wide rule. Restarting `receptionist-tunnel` drops any live call for a few seconds: do it when no
VOLTA call is in progress (check the relay journal for an open session) and no robot batch is scheduled.
Files: ~/.cloudflared/receptionist.yml (edit, backed up first; never printed); ~/.sam/work/errand-caller/tunnel.md (new)
Steps:
1. SAM states the rule (from `apps/errand/deploy/tunnel-rule.yml`) and the restart. Wait for go.
2. Back up the file; insert the rule before the host-wide rule; `cloudflared tunnel --config ... ingress validate`; restart `receptionist-tunnel`.
3. Read back with `ingress rule`: `/errand/twiml`, `/errand/status`, `/errand/ws` match port 3003; `/relay` matches 3002; `/api/health` and
   `/errand/health` match the host-wide rule.
4. Public checks: `/relay` 426, `/api/health` 200 (Done-means 18).
5. Done-means 17: through the public hostname, an unsigned POST and a wrongly signed POST to `/errand/twiml` and `/errand/status`, and an unsigned and a
   wrongly signed WebSocket upgrade to `/errand/ws`, are each refused (403). `/errand/health` from outside is not 200.
Do not touch: any other ingress rule, the relay, the app.
Proof: before, `tunnel.md` does not exist and `ingress rule .../errand/twiml` matches the host-wide rule (T3). After: `tunnel.md` holds the three
`ingress rule` read-backs, the 426 and 200, and the six refusals.

## T24: GATE: batch guard on the live box (Done-means 4)
Status: TODO
Spec: must-do 5; Done-means 4
Depends on: T22
Blocked by: Colin's go (a transient user unit is a systemd change)
Context: A harmless transient unit named like a robot run must block a dial, and the same dial must pass the guard once it is gone. `--check`
runs every guard and prints one line each without placing a call (T11 step 3), so a test errand created here with `errand new` (Colin's mobile,
no read-back, no go) is enough: its `go` line refuses, and only the `batch` line is under test.
Files: ~/.sam/work/errand-caller/guard-live.md (new)
Steps:
1. `systemd-run --user --unit=robot-guardtest-1 sleep 600`.
2. `errand dial <id> --check`: the `batch` line is refused, naming `robot-guardtest-1`.
3. `systemctl --user stop robot-guardtest-1`; listing shows no `robot-*` unit.
4. `errand dial <id> --check`: the `batch` line passes. No call is created in either run (Dublin GET of the account's calls since step 1: none from the robot number).
Do not touch: `robot-batch.sh`, any real robot unit.
Proof: before, `guard-live.md` does not exist. After: it holds both `--check` outputs and the listing between them.

## T25: GATE: first test errand to Colin's mobile (Done-means 1, 6)
Status: TODO
Spec: must-dos 1, 2, 3, 7, 16, 17; OPEN 5, OPEN 7; Done-means 1, 6, 12, 13
Depends on: T23, T24
Blocked by: Colin's go (his tap on the Go button), Colin's time
Context: The first live call proves the whole path end to end on Colin's own mobile and reads the call back from the Dublin edge. Within calling hours.
Colin answers, speaks first ("Hello, Colin's Kitchen"), and lets Amy state the errand; he may end it as he likes.
Files: ~/.sam/work/errand-caller/live/t25.md (new)
Steps:
1. Colin asks SAM in chat for a test errand to his own mobile (a table for two inside a window SAM gives him). SAM writes the brief, `errand new`,
   `errand readback`. Done-means 1: Colin confirms on his phone the read-back shows every brief field and the number as dialled. Record his words.
2. Colin taps Go. `errand dial <id>`.
3. After the call: GET the call from the Dublin edge (masked): `from` is `+447861926390`, `answered_by` is set (machine detection on), and the
   folder's `answered` event holds the same `AnsweredBy` value (Done-means 6).
4. Telegram: Twilio's call end time against the message time, at most 2 minutes (Done-means 12).
Do not touch: the robot number's settings (OPEN 8), the VOLTA number.
Proof: before, `t25.md` does not exist. After: it holds Colin's read-back confirmation, the masked call read-back with From and `answered_by`, the
folder path, and the end-to-Telegram gap.

## T26: GATE: Colin plays a restaurant (Done-means 7)
Status: TODO
Spec: must-dos 8, 9, 10; OPEN 6, OPEN 17; Done-means 7, 12, 13
Depends on: T25
Blocked by: Colin's go, Colin's time
Context: Proves Amy waits, discloses, holds the window and gives only Colin's details.
Files: ~/.sam/work/errand-caller/live/t26.md (new)
Steps:
1. New test errand (window for example 19:00 to 20:30). Read-back, Go, dial.
2. Colin answers and speaks first; offers a time outside the window; then one inside; asks "are you a real person?"; asks for a callback number.
3. From the transcript: the first line is Colin's; Amy's first line starts with the opening line; she declined the outside time and accepted the inside
   one; she said she is an automated assistant; she gave Colin's mobile, never the robot number, and no other personal detail. Colin confirms by ear.
4. Outcome "booked" with the inside time; Telegram within 2 minutes.
Do not touch: anything other than this one call.
Proof: before, `t26.md` does not exist. After: it quotes the transcript lines for each check in step 3, Colin's by-ear words, and the Telegram gap.

## T27: GATE: payment ask ends the call (Done-means 8, live part)
Status: TODO
Spec: must-dos 11, 15; Done-means 8, 12
Depends on: T25
Blocked by: Colin's go, Colin's time
Context: The automated payment tests are in T14 and T15; this is the one live check.
Files: ~/.sam/work/errand-caller/live/t27.md (new)
Steps:
1. New test errand; read-back, Go, dial. Colin answers, then asks for a card number to hold the table.
2. Amy rings off politely. Outcome "ended early: payment asked"; Telegram within 2 minutes.
Do not touch: anything other than this one call.
Proof: before, `t27.md` does not exist. After: it quotes the payment line and Amy's ring-off line, the outcome, and the Telegram gap.

## T28: GATE: voicemail (Done-means 11)
Status: TODO
Spec: must-do 14; OPEN 4, OPEN 5; Done-means 11, 12
Depends on: T25
Blocked by: Colin's go, Colin's time
Context: Proves synchronous detection works with a ConversationRelay call (OPEN 5) and that one message is left.
Files: ~/.sam/work/errand-caller/live/t28.md (new)
Steps:
1. New test errand; read-back, Go, dial. Colin declines the call so it goes to his voicemail.
2. Colin hears the message: the opening line, the request, Colin's mobile to call back. Record his words.
3. `answered_by` on the Dublin read-back is a `machine_end_*` value; outcome "voicemail left"; the transcript holds Amy's one line and no turn after it;
   Telegram within 2 minutes.
Do not touch: anything other than this one call.
Proof: before, `t28.md` does not exist. After: it holds the `answered_by` value, Colin's confirmation, the outcome and the Telegram gap.

## T29: GATE: the errand record answers questions (Done-means 12, 13 across the live tests)
Status: TODO
Spec: must-dos 16, 17; Done-means 12, 13
Depends on: T25, T26, T27, T28
Blocked by: none (read-only over the live tests' folders)
Context: Done-means 12 needs every live test's Telegram within 2 minutes; Done-means 13 needs one folder to hold every must-do 17 part and SAM to
answer from it alone.
Files: ~/.sam/work/errand-caller/live/record-check.md (new)
Steps:
1. A table of the four live calls: call end time (Twilio, Dublin GET), Telegram time (from `notify-colin.sh`'s log), gap; each at most 2 minutes.
2. For T26's folder: tick each must-do 17 part (brief, read-back, go, every status change, the `AnsweredBy` value, digits sent (none expected),
   each turn with speaker, words and time, the outcome).
3. A fresh SAM context given only `errand status <T26 id>` answers "what did they say about the time?"; record the answer and check it against the transcript.
Do not touch: the folders (read only).
Proof: before, `record-check.md` does not exist. After: four gaps all at most 2 minutes, every part ticked, and the answer quoted with its transcript lines.

## T30: GATE: isolation read-back after the live tests (Done-means 16)
Status: TODO
Spec: must-do 20; OPEN 8; Done-means 16
Depends on: T29
Blocked by: none (read-only)
Context: The receptionist, its tenants and VOLTA must be exactly as before.
Files: ~/.sam/work/errand-caller/isolation.md (new)
Steps:
1. `git diff --stat <base commit>..HEAD -- apps/relay/src packages/core/src/domain apps/web supabase` empty; `~/.sam/work/amy-speed-test` unchanged
   (file list and sha256 against a listing taken in T3, or `git status` if it is a repo).
2. Read-only select on the local tenant database: no `calls` or `messages` row created during the live test window from or to the robot number or
   Colin's mobile. Count only, no row content.
3. Dublin GETs (masked): VOLTA number `voice_url`, method and status callback equal T3's; robot number unchanged from T3 (OPEN 8).
4. `atwood-relay` MainPID and start time equal T3's.
Do not touch: the database (select only), the numbers (GET only).
Proof: before, `isolation.md` does not exist. After: the empty diff, the zero count, the equal read-backs and the equal PID.

## T31: GATE: restore one errand folder from the nightly backup (Done-means 19)
Status: TODO
Spec: Robustness "Backups and restore"; Done-means 19
Depends on: T25 and one nightly `sam-backup` run after it
Blocked by: Colin's go (the restore uses the backup's decryption key)
Context: `~/.sam` is in the nightly encrypted `sam-backup` (04:16, "sam state" block), so errand folders are covered with no change.
Files: ~/.sam/work/errand-caller/restore.md (new); a scratch folder under `/tmp`, removed after
Steps:
1. Restore T25's folder from the latest backup into a scratch folder, by the backup's own restore path.
2. `sha256sum` every file in both; they match.
3. Remove the scratch folder.
Do not touch: the live calls folder, the backup set.
Proof: before, `restore.md` does not exist. After: it holds both checksum lists, equal, and the scratch removal.

## T32: GATE: rollback rehearsal (Done-means 20)
Status: TODO
Spec: Robustness "Rollback"; Done-means 20
Depends on: T30
Blocked by: Colin's go (a tunnel restart and a service stop)
Context: The rollback is: stop and disable the errand service, remove its one tunnel rule, restart the tunnel. Nothing else changed, so the
receptionist needs no rollback. Rehearse once, then restore.
Files: ~/.sam/work/errand-caller/rollback.md (new)
Steps:
1. SAM states the steps and the two tunnel restarts. Wait for go. Check no VOLTA call is live.
2. Follow `RUNBOOK.md` rollback: stop and disable `atwood-errand`; remove the rule; restart the tunnel.
3. `/relay` 426, `/api/health` 200; `errand dial <test id> --check` refuses with "errand service down".
4. Restore: re-add the rule, restart the tunnel, enable and start the service; T23 step 3 read-back and `/errand/health` 200 again.
Do not touch: anything outside the runbook.
Proof: before, `rollback.md` does not exist. After: it holds the 426, the 200, the refusal line, and the restored read-backs.

## T33: GATE: errand caller report and final read-back
Status: TODO
Spec: every must-do; Done-means 1 to 20 (10 SKIPPED); OPEN 7, 8, 15, 16
Depends on: T21 to T32
Blocked by: none
Context: Closes the spec for Colin. Done-means 10 (live menu test) is SKIPPED by OPEN 15: menus are handled per must-do 13 and fact F1 and unit-tested
in T15 and T16; the live test is deferred to a later release. OPEN 7: the first real errand to a landline is the landline proof; it is not part of this build.
Files: ~/.sam/work/errand-caller/report.md (new)
Steps:
1. One line per done-means 1 to 20 with PASS, FAIL or SKIPPED and the ticket that proves it; 10 reads SKIPPED with OPEN 15.
2. Costs: the four test calls' prices from the Dublin call read-backs, against the locked prices (AMD $0.0075 a call, ConversationRelay about $0.07 a minute).
3. Final read-back: `errand-caller` service active, the three errand paths match port 3003, `/relay` 426, `/api/health` 200, the robot number unchanged
   from T3, no `robot-guardtest-1` unit, `errand-prune.timer` scheduled.
4. Open items for Colin: the landline proof on the first real errand (OPEN 7), the menu test for the next release (OPEN 15), anything a GATE found.
Do not touch: settings, code, the Twilio numbers.
Proof: before, `report.md` does not exist. After: 20 done-means lines (19 PASS or FAIL, 10 SKIPPED), the costs, the final read-back and the open items.

---

# Coverage

## Must-dos

| must-do | tickets |
|---|---|
| 1 SAM writes the per-call brief with every field | T5 (brief type), T19 (`new`, SAM.md), T25 |
| 2 one read-back message, number exactly as dialled | T6, T25 |
| 3 no dial without a go matching the read-back, under 30 minutes, unused; refusal says why | T1, T6, T7, T11, T25 |
| 4 allowed UK number kinds only (084 and 087 refused, OPEN 13) | T8, T11 |
| 5 refuse while a robot batch is scheduled or running, naming it | T9, T11, T24 |
| 6 one errand call at a time | T9, T11 |
| 7 robot number, Dublin edge, machine detection, ring timeout, maximum length | T2, T10, T11, T25 |
| 8 waits for them to speak, discloses up front, says automated if asked | T13, T15, T16, T26 |
| 9 any time inside the window, never outside; reports offered times | T14, T15, T26 |
| 10 only Colin's name and mobile; callback is Colin's mobile | T14, T15, T26 |
| 11 rings off on payment, checked in code | T14, T15, T27 |
| 12 rings off when confused, at the turn cap or the maximum length; outcome says which | T15, T16, T17 |
| 13 phone menus by keypad digits; menu steps count to the cap | T2, T15, T16 (live test SKIPPED, OPEN 15) |
| 14 machine at end of greeting: one short message, hang up; unknown is a person | T13, T16, T28 |
| 15 nothing beyond the goal | T14, T15, T27 |
| 16 one Telegram within 2 minutes with the outcome | T17, T25 to T29 |
| 17 a record of each errand SAM can read | T5, T16, T17, T19, T29 |
| 18 never an automatic redial | T7, T11, T17 |
| 19 no outcome 20 minutes after dialling raises an alert | T11 (schedules it), T18 |
| 20 own TwiML endpoint, socket, process and turn logic; receptionist unchanged; no tenant rows | T4, T12, T13, T15, T16, T21, T22, T30 |
| 21 errand endpoints accept only Twilio-signed requests, fail closed | T12, T23 |
| 22 one new tunnel rule before the host-wide rule, on Colin's go, read back | T20, T23 |

## Done means

| check | ticket proof |
|---|---|
| 1 read-back shows every field and the number as dialled; Colin confirms | T6, T25 |
| 2 no go, edited brief, expired go, used go refused with zero creates; valid go one; mutation check | T7, T11, T21 |
| 3 number table refused and allowed | T8 |
| 4 `robot-guardtest-1` blocks and is named; passes once stopped; fake-list test | T9, T24 |
| 5 second dial while one is live refused | T9, T11 |
| 6 first live call: From robot number, detection on, `AnsweredBy` in the record | T25 |
| 7 Colin plays a restaurant: waited, disclosed, declined then accepted, only Colin's details | T26 |
| 8 payment tests end the call; live card ask ends with "payment asked" | T14, T15, T27 |
| 9 turn cap and two confused turns end the call; maximum length on every create | T10, T15, T16 |
| 10 live phone-menu test | SKIPPED (Colin, 2026-10-26, OPEN 15); menus built and unit-tested in T15, T16; recorded in T33 |
| 11 voicemail: message left and heard, "voicemail left", `machine_end_*` | T28 |
| 12 every live test's Telegram within 2 minutes | T17, T25, T26, T27, T28, T29 |
| 13 folder holds every part; SAM answers from it alone | T29 |
| 14 no-answer leads to no second create | T11, T17 |
| 15 fake clock: one alert after 20 minutes | T18 |
| 16 no diff under the protected paths; no tenant rows; VOLTA unchanged; relay PID kept | T3, T21, T30 |
| 17 unsigned and wrongly signed requests through the public hostname refused | T12, T23 |
| 18 tunnel rule read back; `/relay` 426, `/api/health` 200 | T20, T23 |
| 19 one errand folder restored from the nightly backup, checksums match | T31 |
| 20 rollback rehearsed: service stopped, rule removed, 426 and 200, dial refuses "errand service down", restored | T11, T20, T32 |

## Locked decisions and Robustness lines that need building

| line | ticket |
|---|---|
| OPEN 1 Go button written by the bridge; SAM cannot write it | T1, T6, T7, T19 (SAM.md) |
| OPEN 2 go expiry 30 minutes | T7 |
| OPEN 3 turn cap 20, ring 30 s, maximum 8 minutes | T4, T10, T15, T16 |
| OPEN 4 synchronous detection | T10, T13, T28 |
| OPEN 5 detection with ConversationRelay proven live | T25, T28 |
| OPEN 6 no welcome greeting waits, proven live | T13, T26 |
| OPEN 7 first live landline call is the proof | T33 (open item) |
| OPEN 8 robot number voice URL left as-is, no Twilio write | T3, T30, T33 |
| OPEN 9 one-way batch guard, no change to `robot-batch.sh` | T9 |
| OPEN 10 Amy's Gemini flash | T2, T4, T15 |
| OPEN 11 transcript only, no recording | T4 (boundary test), T10 |
| OPEN 12 retention 90 days | T18, T20, T22 |
| OPEN 13 084 and 087 refused | T8 |
| OPEN 14 calling hours 08:00 to 21:00 UK | T8, T11 |
| OPEN 15 menu test skipped | T33 |
| OPEN 16 detection and ConversationRelay prices | T2, T33 |
| OPEN 17 opening words | T4, T15, T16, T26 |
| Call create 15 s timeout, never retried | T10, T11 |
| Model turn 8 s timeout, fixed line, outcome "failed" | T15 |
| Socket drop caught by the status callback | T16, T17 |
| Failed Telegram falls back to the phone push; outcome stays on disk | T17 |
| Refused dials said in chat at once | T11, T19 (SAM.md) |
| Dial step runs only on this box as `col`; keys never printed | T19, T20, T22 |
