# Errand caller: facts file (SAM-RUN T1 to T3)

Written 2026-10-26 by SAM on the live box, read-only. Cloud build agents read this instead of opening `~/.sam`.
Every step ends FOUND (with the source) or NOT DOCUMENTED. Twilio SIDs are masked (first 4, last 4). No secret file was read.

## A. Go-button bridge

### A1. The live `closer_answer.py` and the question shape. FOUND
- Live script: `/home/col/.sam/closer/closer_answer.py` (316 lines). SAM_ui's `runAnswer` (`~/SAM_ui/src/lib/server/questions/answer.ts`)
  uses `process.env.SAM_CLOSER_ANSWER_PY || DEFAULT_ANSWER_PY`, and `DEFAULT_ANSWER_PY = '/home/col/.sam/closer/closer_answer.py'`.
  Other copies exist and are NOT live (staged or overlay copies): `~/.sam/work/answer-resume/staged/`, `~/.sam/work/jtp-restage/closer/`,
  `~/.sam/work/closer-close-loop/overlay-src/`, `~/.sam/work/choice-buttons/staged/`. Do not read these as the contract.
- Call: `python3 closer_answer.py <jobId> <questionId> <a-f> <via>` (execFile, no shell). `via` is `push` or `tab`. It prints one JSON line
  `{"questionId","state","changed","result"}` and exits 0; exit 2 for a bad id, job outside the store, unknown question, bad answer or bad via;
  exit 1 `{"error":"internal"}`. Its docstring: "This is the only code that changes a question's state."
- Lock: `fcntl.flock(LOCK_EX)` on `<job dir>/.answer.lock` around read, change and write. An answer to a question whose `state` is not `open`
  changes nothing and returns `changed: false`.
- Store: `SAM_JOB_STORE` or `~/.sam/jobs`. A job dir must match `^job_[A-Za-z0-9._-]+$`, must be a direct child of the store (realpath) and must exist.
  Question id: `^q_[0-9a-f]{8}$`.
- Record file: `~/.sam/jobs/<jobId>/closer.json`, written atomically (temp file, fsync, rename) by `closer_core.write_record`, every string scrubbed.
  A closer.json is a JSON object with a `questions` list. A fleet job's record also has `jobId, verdict, verdictKind, coverage, checks, actions,
  needsYou, refused, status, startedAt, finishedAt, questions, housekeeping` and more; the question mirror's has only `jobId, source, questions`.
- Question fields (from `closer_questions.ask()` in `~/.sam/closer/closer_questions.py`, confirmed on live records):

| field | set at creation | value / notes |
|---|---|---|
| `id` | creation | `"q_" + 8 hex` (`secrets.token_hex(4)`) |
| `kind` | creation | `yesno`, `choice2`, `choice` (3 to 6 options) or `open`. `yesno` forces options `["Accept","Decline"]`; `choice2` needs exactly two options of at most 20 characters |
| `text` | creation | sanitised one-line text |
| `options` | creation | list of labels (at most 6; labels at most 20 characters) |
| `source` | creation | free label, for example `refused-step`, `waiting-on-colin` |
| `gated` | creation | bool, default `True` in `ask()` |
| `acceptAction` | creation | `none` (default), `relaunch`, `decision`, `resume`. Only these start work after an accept. Use `none` for a Go question |
| `state` | creation `open`; answer changes it | `open` then `accepted` or `declined`; `failed` if an accept action failed |
| `createdAt` | creation | `YYYY-MM-DDTHH:MM:SSZ` (UTC) |
| `answeredAt` | answer only | UTC timestamp, `null` until answered |
| `answeredVia` | answer only | `"push"` or `"tab"`, `null` until answered |
| `result` | answer only | `"Chose <label>"` for `choice2` / `choice`; `"Accepted"` or `"Declined"` for `yesno`; `null` until answered |
| extra keys | creation | `ask(**extra)` copies extras (for example `waitingItem`, `notifiedAt`) |

- Answer mapping (`answer()`): letter `a` is `options[0]`, `b` is `options[1]`, and so on. For `choice2` / `choice` the result is
  `"Chose " + options[idx]` and `state = "accepted"` (BOTH choices set `accepted`, so `state` alone does not tell a Go from a Cancel: read `result`).
  For `yesno`, `a` gives `accepted` / `Accepted`, `b` gives `declined` / `Declined`.
- How a question is created today: only by the closer. `closer.py` registers questions through `closer_questions.ask(text, source, kind, options, gated, accept_action)`
  into the in-memory `QUESTIONS` list and writes `rec["questions"]` with `core.write_record(job_dir, rec)` at the end of its pass
  (`~/.sam/closer/closer.py`, around lines 246 to 269). It is a Python module call, not a command-line tool; there is no CLI that creates a question.
  The one non-closer writer is `~/.sam/waiting/waiting.py` (`sam-waiting`), which appends choice2 questions to the mirror (see A2).
  The push is sent separately: `~/.sam/notify-colin.sh "<title>" "<body>" --question q_xxxxxxxx --options "<a>|<b>" --job job_xxx`.

### A2. A question without a fleet job; the smallest supported way. FOUND
- A question does not need a fleet job. It needs a directory `~/.sam/jobs/<job id>/` containing a `closer.json` with a `questions` list that holds it.
  `checkAnswer` in SAM_ui only reads that file (`readQuestions([jobId])`); `closer_answer.py` only needs the dir and the file.
- Precedent: `~/.sam/jobs/job_waiting-on-colin/` holds only `closer.json` (keys `jobId, source, questions`) and `.answer.lock`. `sam-waiting`
  (`~/.sam/waiting/waiting.py`, around lines 2017 to 2200) creates its questions with `kind: "choice2"`, `gated: false`, `acceptAction: "none"`,
  a fresh `q_<8 hex>` id, written atomically under its own lock, same shape as the closer's write.
- Smallest supported route for the errand CLI: create its own job dir `~/.sam/jobs/job_errand-<errandId>_<YYYYMMDD-HHMMSS>/` (matches `^job_[A-Za-z0-9._-]+$`)
  holding a `closer.json` with `{ "jobId": "<that id>", "source": "errand", "questions": [ { ...one choice2 question... } ] }`, written atomically
  (temp file in the same dir, fsync, `os.replace`) exactly as `closer_core.write_record` does. Recommended question: `kind: "choice2"`,
  `options: ["Go", "Cancel"]`, `gated: true`, `acceptAction: "none"`, `source: "errand"`, `state: "open"`, `answeredAt/answeredVia/result: null`.
  Then send the push with `notify-colin.sh ... --question <qid> --options "Go|Cancel" --job <jobId>`.
- Retention hazards (SAM_ui `~/SAM_ui/src/lib/server/jobs/manager.ts`, `sweepDisk`, hourly): only the exact name `job_waiting-on-colin` is exempt. Any other
  `job_*` dir without `meta.json.unit` or `cmd.sh` counts as a chat turn and is dropped after `RETENTION_MS` (7 days) or when over `MAX_JOBS` (128).
  Fine for a 30-minute Go (GO_EXPIRY_MS), but the errand record must not depend on the job dir surviving past 7 days: the errand folder keeps its own copy of the go record at dispatch time.
  SAM_ui reads only the newest 200 job dirs by mtime (`readQuestions`, `MAX_JOBS = 200`), fine for a fresh dir.
- Creating a `job_errand-*` dir is the errand tool writing under `~/.sam/jobs`; this fact-finding job did NOT do it. It is a runtime decision for T19/T20 (live use is gated at deploy).
- A supported "create question" command or API: NOT DOCUMENTED. Writing the `closer.json` by hand is supported only by the precedent above.

### A3. Does Telegram carry the buttons? FOUND: no
- `~/.sam/notify-colin.sh` sends Telegram as plain text: a `sendMessage` call with body `{chat_id, text}` only, with no `reply_markup` and no inline keyboard.
  `--question`, `--options` and `--job` are passed only to `sam-push` (`PUSH_ARGS`), never to Telegram.
- So the Go button is the phone web push (lock-screen action buttons) and the SAM tab (SAM_ui `/api/questions`). Telegram carries the read-back text only.
- Push mechanics (`~/.sam/sam-push/send.mjs`): `--question` must match `q_` + 8 hex; `--options "A|B"` gives at most two labels, each cut to 20 characters (default `Accept|Decline`);
  actions are `[{action:"a", title:A},{action:"b", title:B}]`; the payload carries `questionId` and `jobId`. A tap on button a or b makes the service worker `POST /api/questions/answer`
  with header `x-answer-via: push`, body `{jobId, questionId, answer}`. Without a `jobId` in the payload the tap only opens the page and answers nothing.
  `notify-colin.sh` passes `--job` only when it matches `job_[A-Za-z0-9._-]+`.

### A4. Gated questions. FOUND: yes, and it affects the lock-screen tap
- A question is gated by the field `gated: true` in its closer.json record (the default in `ask()`); SAM_ui reads it from the record, never from the request
  (`answer.ts`: "Gated status is read from the question record here, never from the request"). `route.ts`: when `checked.gated`, `requireStepUp` runs first.
- Step-up is a biometric step-up cookie (`/api/auth/stepup`). Without it the route returns 401 `{stepUpRequired: true}` and changes nothing.
  The service worker treats a 401 as failure and re-shows the notification, so a gated question CANNOT be answered from the lock-screen button alone;
  Colin opens the SAM tab, steps up, and taps there (`answeredVia` is then `tab`).
- Recommendation: errand Go questions are `gated: true`. The Go then needs a deliberate biometric step that a stray lock-screen tap cannot give.
  The dial step must accept `answeredVia` of `push` or `tab` (an ungated question would give `push`).
- Live counts for context (all closer.json records on 2026-10-26): 12 gated yes/no questions and 1 gated choice2 exist; answers so far are `tab` only, none via `push`.

### A5. The go-record contract for the dial step (T7). FOUND
Path pattern: `~/.sam/jobs/<goJobId>/closer.json`, where `goJobId` matches `^job_[A-Za-z0-9._-]+$` and is recorded in the errand folder when the Go question is created.
The dial step reads that errand's own recorded `goJobId` and `goQuestionId`; it never searches the store for a matching question.

Tapped Go means ALL of these on the question whose `id` equals the recorded `goQuestionId`, inside the `questions` list of that closer.json:
1. `state == "accepted"`
2. `result == "Chose Go"` (the label of `options[0]`; `kind == "choice2"`, `options == ["Go","Cancel"]` as created)
3. `answeredVia` is `"push"` or `"tab"` (written only by `closer_answer.py`; any other value, or `null`, is not a Go)
4. `answeredAt` is a UTC `YYYY-MM-DDTHH:MM:SSZ` string, not before the question's `createdAt` and no more than GO_EXPIRY_MS (30 minutes) after `createdAt`
5. `text` and `options` still equal what the errand folder recorded at creation (the text must carry the read-back so the Go is for THIS brief)

Not Go: `state == "open"` (not answered), `declined`, `failed`, `result == "Chose Cancel"`, a missing file, an unreadable file, or a missing question. Fail closed on every one.

What proves the bridge wrote it: `closer_answer.py` is "the only code that changes a question's state", and it sets `state`, `answeredAt`, `answeredVia`, `result` together under `<job dir>/.answer.lock`.
This is a convention-and-permissions proof, not a cryptographic one: any process running as `col` could edit the file.
The dial step should also check `closer.json` is a regular file owned by the current user and not a symlink.

Second traces (cross-checks):
- `~/.sam/push-log.jsonl` (one JSON object per line; fields `id, ts (ms epoch), title, body, url, tag, chatId, jobId, questionId`). `sam-push` appends an entry
  when it SENDS the ping (before the push keys are checked), with `tag == "q-<questionId>"`, `questionId` and `jobId`. So it proves the Go question was pushed to Colin, NOT that he tapped it.
  A dial-time cross-check: an entry with `questionId == goQuestionId` and `ts` before `answeredAt` exists. Older entries show `jobId: null`; the errand push must pass `--job`.
- A trace of the ANSWER itself (SAM_ui request log, journal line, or a log written by `closer_answer.py`): NOT DOCUMENTED. `closer_answer.py` writes no log line, and the route does not log the call.
  Do not build a dial-time check on one. The only answer trace is `closer.json`.

Expiry: GO_EXPIRY_MS is enforced by the dial step against `answeredAt` and `createdAt`; SAM_ui does not expire questions.
Replay: a Go is single use. The dial step records the `goQuestionId` it consumed in the errand folder before dialling; a second dial on the same errand is refused (T7/T9).

### A summary line
FOUND: live script `/home/col/.sam/closer/closer_answer.py`; question shape; creation via `closer_questions.ask()` (module) or a hand-written closer.json in `~/.sam/jobs/job_<name>/` (waiting-on-colin precedent);
Telegram carries NO buttons; gating is `gated: true` in the record with a biometric step-up (blocks lock-screen taps); go-record contract above. NOT DOCUMENTED: a supported create-question command, and any answer-side log.

## B. Twilio and model

Fetched 2026-10-26 from twilio.com (fetch summaries; quotes are the page's wording as returned). Re-check anything load-bearing at build. No Twilio account call was made.

### B1. Calls create parameters. FOUND (https://www.twilio.com/docs/voice/api/call-resource)
- `MachineDetection`: "Allowed values are `Enable` or `DetectMessageEnd`." No default stated. Use `DetectMessageEnd` (locked).
- `MachineDetectionTimeout`: "The default timeout is 30 seconds."
- `Timeout` (ring seconds): "The default is `60` seconds and the maximum is `600` seconds." The errand sets 30 (RING_TIMEOUT_S) explicitly.
- `TimeLimit`: "The maximum duration of the call in seconds. Constraints depend on account and configuration." No default stated. The errand sets 480 (MAX_CALL_S).
- `StatusCallback`: URL Twilio calls with `status_callback_method`. "If no `status_callback_event` is specified, we will send the `completed` status."
- `StatusCallbackEvent`: allowed values "`initiated`, `ringing`, `answered`, and `completed`"; default completed only.
- `StatusCallbackMethod`: "`GET` or `POST`", "the default is `POST`".
- `Record`: "The default is `false`." Never set it (OPEN 11).
- `AsyncAmd`: "`true` or `false`"; by default it blocks the call until detection completes.
- Note: the page was 243k characters and only the first 100k were read; every value above was on that part.

### B2. Answering-machine detection values. FOUND (https://www.twilio.com/docs/voice/answering-machine-detection)
- `MachineDetection=DetectMessageEnd` gives `AnsweredBy` of: "`machine_end_beep`, `machine_end_silence`, `machine_end_other`, `human`, `fax`, `unknown`".
  (`Enable` gives: `machine_start`, `human`, `fax`, `unknown`.)
- Synchronous (AsyncAmd false or absent): "AMD results are returned in the `AnsweredBy` parameter of the webhook." With `Url`, "Twilio sends a webhook to the URL with the decision." So `AnsweredBy` arrives as a form field on the `Url` (call instructions) request, which blocks until the decision. With inline `Twiml` no webhook is sent, so the errand must use `Url`.
- `AsyncAmd=true` instead delivers to `AsyncAmdStatusCallback`. AsyncAmd need NOT be set: "`AsyncAmd` to `false` (the default), Twilio blocks the call." Omit it.
- Read-back field: the Call resource JSON has `answered_by` (sample `null`). The page does not say when it is populated or its values: NOT DOCUMENTED for the resource field's values (assume the same strings; confirm on the first test call, T25).

### B3. ConversationRelay WebSocket messages. FOUND (https://www.twilio.com/docs/voice/conversationrelay/websocket-messages)
- Inbound `setup`: custom parameters arrive in the field `customParameters` (example `"customParameters": { "callReference": "bar" }`).
- Inbound `prompt`: `"type": "prompt"`, `"voicePrompt"`, `"lang"`, `"last"` (boolean).
- Inbound `dtmf`: `"type": "dtmf", "digit": "1"`.
- Inbound `interrupt`: `"type": "interrupt"`, `"utteranceUntilInterrupt"`, `"durationUntilInterruptMs"`. Inbound `error`: `"type": "error"`, `"description"`.
- Outbound `text`: `"type": "text", "token", "last", "interruptible", "preemptible"`.
- Outbound `sendDigits`: `"type": "sendDigits", "digits": "9www4085551212"`. Quoted charset: "Must only contain the characters 0-9, w, #, and \*."
- Outbound `end`: `"type": "end"` with optional `"handoffData"` (a string returned to the `<Connect>` action callback).
- Also exist: outbound `play` (`source`, `loop`, `preemptible`, `interruptible`) and `language` (`ttsLanguage`, `transcriptionLanguage`).
- Compared with `apps/relay/src/protocol.ts` (read only): `SetupFrame` declares `sessionId, callSid, from, to, callType, direction, customParameters` (matches `customParameters`; the page example shows only that field);
  `PromptFrame` declares `voicePrompt, lang, last` (matches). `OutboundFrame` declares `text {token, last?, lang?}`, `sendDigits {digits}`, `end {handoffData?}`.
  Differences: (a) `text` omits the documented `interruptible` and `preemptible`; (b) there is no declared type for `dtmf` (handled as a generic frame with `frame.digit`, the documented field),
  `interrupt` or `error`; (c) `lang` on outbound `text` is declared but was not on the quoted example (the page's text example has no `lang`; the TTS-language doc says a `lang` on the token overrides `ttsLanguage`). The errand package must declare its own frame types and not import the relay's.

### B4. ConversationRelay TwiML behaviour. FOUND (https://www.twilio.com/docs/voice/twiml/connect/conversationrelay)
- `welcomeGreeting` absent: the page says "The message Twilio plays to the caller after answering a call." and lists no default. What happens when it is absent: NOT DOCUMENTED (the attribute is optional; OPEN 6 says proceed, proven by Done-means 7).
- `<Connect>` ends with an `action` URL: "Twilio requests that URL when the `<Connect>` verb ends", with call information and session details such as `SessionStatus` and `SessionDuration`; `handoffData` from an `end` message goes to it.
- `<Connect>` ends without `action`: NOT DOCUMENTED (the page documents the callback only when `action` is specified). Treat it as the call continuing past `<Connect>`: end TwiML with `<Hangup/>` after it; do not rely on the default.
- `<Parameter>`: "send custom parameters from the TwiML directly into the initial "setup" message", delivered in `customParameters`.
- Other attributes as documented: `language` default `en-US` (sets both `ttsLanguage` and `transcriptionLanguage`); `ttsProvider` `Google`/`Amazon`/`ElevenLabs`; `transcriptionProvider` `Google`/`Deepgram`;
  `speechTimeout` integer 600 to 5000 ms, default `auto`; `interruptible` `none`/`dtmf`/`speech`/`any`, default `any` (booleans accepted: true = any, false = none).

### B5. VOLTA's ConversationRelay attributes today. FOUND (`apps/web/src/lib/conversation-relay.ts`, read only)
For the `today` variant (no `VOICE_TEST_VARIANT`), the builder `buildConversationRelayTwiml` (from `@atwood/core`) receives:
| attribute | value |
|---|---|
| `language` | `'en-GB'` |
| `ttsLanguage` | `'en-GB'` |
| `ttsProvider` | `'ElevenLabs'` |
| `voice` | `'6fZce9LFNG3iEITDfqZZ'` (bare ElevenLabs ID, no provider prefix) |
| `transcriptionProvider` | `'Deepgram'` |
| `speechTimeout` | `1200` (ms) |
| `interruptible` | NOT SET by VOLTA (Twilio default `any`) |
| `welcomeGreeting` | the tenant greeting (VOLTA); the errand has its own OPENING_LINE decision (see B4) |
| `<Parameter>`s | `businessId`, `callSid`, `to` (plus `turnVariant`, `voiceModel` only for non-`today` variants); the errand sends its own (for example the errand id) |
The socket URL comes from `publicOrigin` and the `/relay` path (a contract with the tunnel config). The errand uses its own path.

### B6. Amy's model today. FOUND
- Model `gemini-3.8-flash`, thinking effort `low` (`~/.sam/work/amy-latency/speed-test/gemini-bench.md`, row `today`: first-token p50 1576 ms, p95 3570 ms, 20 of 20 ok).
- `packages/core/src/ai/google.ts`: `THINKING_BUDGET` = low 512, medium 768, high 1024, xhigh 2048, max 4096 tokens; the request sends `thinkingConfig: { thinkingBudget }` and `maxOutputTokens: request.maxOutputTokens + thinkingBudget`; default effort when unset is `low`.
  Warnings in the file: `thinkingLevel` MINIMAL is a 400 on `gemini-3.8-flash`; `thinkingBudget: 0` is a 400 on `gemini-pro-latest`; never send 0.
- ERRAND_MODEL = `gemini-3.8-flash`, effort `low`. No database was read; if VOLTA's tenant setting differs from this default the setting is not in the repo (NOT DOCUMENTED here).

### B7. Prices. FOUND (https://www.twilio.com/en-us/voice/pricing/gb, read 2026-10-26)
- Answering Machine Detection: $0.0075 per call (no per-minute rate listed). ConversationRelay: $0.07 per minute. UK outbound to mobile: $0.0305 per minute. Matches the locked figures.

### B8. Summary
Steps 1 to 7 above are FOUND except where marked NOT DOCUMENTED (the Call resource `answered_by` values, `welcomeGreeting` absent, `<Connect>` without `action`). Parameter names above are exact for the build.

## C. Baseline

Full read-backs: `~/.sam/work/errand-caller/baseline.md` (not in the repo). Non-secret lines only. Date 2026-10-26.

- C1. Base commit: `2ea20b869167128f9623a8f3733cdc79e6354292` on `restyle/glassmorphism`. FOUND
- C2. MainPID (ExecMainStartTimestamp): `atwood-relay` 2994863 (Sun 2026-10-18 17:25:14 BST); `receptionist-app-prod` 1991349 (Sun 2026-10-25 23:11:40 GMT); `receptionist-tunnel` 7993 (Sat 2026-10-17 18:05:16 BST). FOUND
  Done-means 16 compares `atwood-relay` against 2994863: it must not change.
- C3. Ingress: `/relay` matches rule #0 (path `^/relay/?$`) to `http://localhost:3002`; `/api/health` and `/errand/twiml` both match rule #1 (host-wide) to `http://localhost:3001`.
  So `/errand/twiml` currently reaches the web app (3001); the T23 tunnel rule is what routes it to the errand port. FOUND
- C4. Public answers: `/relay` 426, `/api/health` 200. FOUND
- C5. Twilio number read-backs (Dublin edge, read-only, SIDs masked). FOUND
  - VOLTA `+447462187713` (`PNbd...0b9d`): voice_url `https://receptionist.atwoodsystems.co.uk/api/webhooks/twilio/voice`, voice_method `POST`, status_callback `""` (empty), status_callback_method `POST`.
  - Robot `+447861926390` (`PN2a...b00a`): voice_url `null`, voice_method `null`, status_callback `null`, status_callback_method `null` (OPEN 8: no voice URL, leave as-is; today there is none).
  - Note: the first read-only attempt failed because `TWILIO_API_BASE_URL` (config, not secret) was not passed to the script. Its live value is `https://api.dublin.ie1.twilio.com/2010-04-01` (the systemd `Environment=` line; it includes the `/2010-04-01` path). No keystore change was needed.
- C6. No `robot-*` units, no `robot-run.mjs` process. FOUND
- C7. Port 3003 free (listeners: 3000, 3001, 3002, 3010). FOUND
