# Tickets: Amy latency (voice reply delay)

Spec: [amy-latency-spec.md](amy-latency-spec.md) (LOCKED 2026-10-17 09:50). "Decisions at lock" in the spec override its OPEN lines:
target (a) relay-side p50 at most 0.78 s and p95 at most 1.46 s; stall setting 3 s; voice-channel eval runner, latency alert
and true caller-perceived delay measurement are in scope.
Branch: `restyle/glassmorphism`, on top of `5a95538` and `13da8b4`. Never `main`.
Consumer: `/implement`, one fresh agent per ticket. Build in order. Each ticket leaves both suites green.

## Shape of the work

- Step 1 (T1 to T11): measure only. Ends in GATE T11. Nothing in step 2 or step 3 starts before T11 is DONE.
- Step 2 (T12 to T19): stream the first sentence on ordinary turns. Every step 2 ticket depends on T11.
- Step 3 (T20 to T23): thinking budget and voice prompt trim. Every step 3 ticket depends on T11.
- Whole build (T24 to T26): commit, live deploy and measurement, latency alert.
- At T11 Colin decides which of step 2 and step 3 goes first, or drops one (spec "How step 1 decides").
  Step 2 and step 3 tickets do not depend on each other, so either block can run first. If Colin drops a block, mark its
  tickets `Status: DROPPED (Colin, <date>)` and skip them; T24 to T26 then cover only what was built.
- GATE tickets (T10, T11, T25, T26) are run by SAM with Colin, not by a build agent. Any ticket that changes the live
  receptionist goes through the existing deploy path (pull or confirm the checkout, both suites, restart `atwood-relay`,
  confirm the new PID started after the change) and only on Colin's explicit go. Commits go through the Atwood gate
  (`gate-prepush` / `gate-detector`); push only if Colin asks.

## How to run the tests (every ticket)

- Node 22+ with type stripping. Put `~/.local/node/bin` first on PATH (system Node fails with `ERR_NO_TYPESCRIPT`).
- Core: `pnpm --filter @atwood/core test` and `pnpm --filter @atwood/core typecheck`.
- Relay: `pnpm --filter @atwood/relay test` and `pnpm --filter @atwood/relay typecheck`.
- Web typecheck (T9, T19, T24): `pnpm --filter @atwood/web typecheck`.
- Baseline measured 2026-10-17 before T1: core 232/232, relay 62/62. Report the counts after every ticket.

## Rules for every ticket

- Never read, print, cat, grep or source-and-echo an env, key or token file (`apps/web/.env.local`, `~/.sam/call-screener.env`,
  anything named `*.env`, `*key*`, `*token*`). Scripts that need a key load the file into the process and never print a value,
  the way `~/.sam/work/receptionist-eval-gemini/run-eval.sh` and `~/.local/bin/receptionist-watch.mjs` do.
- No live database writes. Read-only selects on `ai_logs` only where a ticket says so.
- No deploy, relay restart, Twilio change or systemd change outside a GATE ticket.
- Match the surrounding code: long explanatory block comments, UK English, named constants for every tunable.
- No change to `speechTimeout` (`apps/web/src/lib/conversation-relay.ts:77`), the handover patterns in `handover.ts`,
  `decideCallerClosing`, `decideMutedTurn`, `isWrapUpLine`, or any SQL migration.

---

# Step 1: stage timing (logged only, no behaviour change)

## T1: Test seams for a whole voice turn (fake Supabase, fake provider)
Status: DONE 2026-10-17 (core 233/233, relay 62/62, core typecheck clean; voice.test.ts smoke passes via seams)
Spec: foundation for Done-means 1, 3, 5, 10, 12 (no must-do of its own)
Depends on: none
Blocked by: none
Context: Nothing in core can run `replyToCaller` in a test today. `getAdminClient()` (`packages/core/src/supabase/admin.ts:24`)
builds a real client from env, and `getProvider()` (`packages/core/src/ai/index.ts`) builds a real SDK client from env. No test
calls `replyToCaller` or `handleInboundMessage`. Later tickets need a whole voice turn with a fake database and a fake model.
Test-only seams; production paths unchanged.
Files: packages/core/src/supabase/admin.ts (edit), packages/core/src/ai/index.ts (edit),
packages/core/src/testing/fake-supabase.ts (new), packages/core/src/testing/fake-provider.ts (new),
packages/core/src/domain/voice.test.ts (new)
Steps:
1. `admin.ts`: add `setAdminClientForTests(client: SupabaseClient | null)`. When set, `getAdminClient()` returns it and never
   touches env. Comment that it exists for tests only.
2. `ai/index.ts`: add `setProviderForTests(name: ProviderName, provider: AiProvider | null)`, which sets or clears the entry in
   the existing `clients` map.
3. `fake-supabase.ts`: a small chainable fake covering exactly what a voice turn touches (read the calls in `pipeline.ts`,
   `context.ts`, `voice.ts`, `reply.ts`, `notify.ts`, `lead.ts`): `rpc('resolve_inbound' | 'append_message' | 'request_handover' |
   'enqueue_notification' | 'upsert_lead')`, and `from(...)` select/insert/update/eq/maybeSingle/single/order/limit on
   `business_ai_context`, `conversations`, `messages`, `leads`, `knowledge_items`, `ai_logs`. It serves a VOLTA-like tenant fixture,
   records every call in order with a timestamp, and lets a test add a delay to any one call (T16 needs a slow outbound
   `append_message`). `append_message` returns `was_created: false` when the same `p_provider_message_id` is seen twice.
4. `fake-provider.ts`: an `AiProvider` whose `generate` returns a scripted `GenerateResult` (text, stopReason, usage, refusal,
   truncated) or throws a scripted `ProviderError`; it records each request. Leave room for a streaming variant (T13 adds it).
5. `voice.test.ts`: one smoke test. Fake Supabase plus fake provider replying "Yes, we cover Rayleigh." A `replyToCaller` call
   returns that text, `endCall: false`, and the fake recorded an inbound and an outbound `append_message`. Clear both seams in
   `afterEach`.
Do not touch: any production behaviour in `pipeline.ts`, `voice.ts`, `reply.ts`; `getAdminClient`'s real path; the provider adapters.
Proof: before, `voice.test.ts` does not exist and there is no way to inject a client. After: core test and typecheck green,
count = 232 + the new test; relay 62/62 unchanged.

## T2: Google adapter streams internally and reports first and last token times (whole reply unchanged)
Status: DONE 2026-10-17 (google.test.ts 18 new tests: 5 fixtures x 1/2/5 chunks equal whole path; core 251/251, relay 62/62, typecheck clean)
Spec: must-do 4; Done-means 3; decision 8 (fixture half)
Depends on: T1
Blocked by: none
Context: Step 1 must measure Gemini time to first token without changing what callers hear. `GoogleProvider.generate`
(`packages/core/src/ai/google.ts:66`) calls `client.models.generateContent` once. The SDK (`@google/genai` 2.14.0) also has
`generateContentStream`, returning `AsyncGenerator<GenerateContentResponse>`. The reply call has no `jsonSchema`, so it can
stream; lead extraction and summaries must stay on `generateContent`. Refusal (SAFETY / PROHIBITED_CONTENT), truncation
(MAX_TOKENS), token counts (thinking folded into completion), cost and `stopReason` must come out exactly as today.
Files: packages/core/src/ai/provider.ts (edit), packages/core/src/ai/google.ts (edit), packages/core/src/ai/google.test.ts (new),
packages/core/src/domain/reply.ts (edit)
Steps:
1. `provider.ts`: `GenerateRequest` gains optional `stream?: boolean` ("stream internally to time the first token; the result is
   still the whole reply"). `GenerateResult` gains optional `timing?: { firstTokenMs: number | null; lastTokenMs: number }` and
   `TokenUsage` gains optional `visibleTokens?: number | null` and `thinkingTokens?: number | null`. Anthropic and OpenAI adapters
   ignore `stream` and set none of the new fields.
2. `google.ts`: constructor takes an optional second argument, the `models` object to use (defaults to `new GoogleGenAI({ apiKey }).models`),
   so a test can pass a fake. When `request.stream` is true and there is no `jsonSchema`, call `generateContentStream` with the same
   `model`, `contents` and `config`. Accumulate `chunk.text` in order. Take `finishReason` and `finishMessage` from the last chunk that
   carries a candidate with one, and `usageMetadata` from the last chunk that carries it. `firstTokenMs` = ms from start to the first
   chunk with non-empty text (null if none), `lastTokenMs` = ms from start to the end of the stream. Build the `GenerateResult` from
   these through the same code as the whole path (factor the shared part into one function so the two cannot drift).
   Set `usage.visibleTokens` and `usage.thinkingTokens` on both paths. Errors go through `toProviderError` as now.
   The 45 s `abortSignal` timeout is unchanged.
3. `reply.ts` `generateReply`: pass `stream: memory.channel === 'voice'` in the `generateWithRetry` call. Nothing else changes.
   Return the provider's `timing` and the visible/thinking token split on `GenerateReplyResult` as optional fields for T4.
4. `google.test.ts`: fixtures for STOP with text, SAFETY, PROHIBITED_CONTENT, MAX_TOKENS with partial text, and empty output; each
   given to the fake both as one `generateContent` response and as the same content split into 1, 2 and 5 stream chunks with
   `finishReason` and `usageMetadata` on the final chunk only. Assert the streamed `GenerateResult` equals the whole one in `text`,
   `stopReason`, `truncated`, `refusal`, `usage.promptTokens`, `usage.completionTokens`, `usage.cachedTokens` and `costUsd`
   (ignore `latencyMs` and `timing`). Assert a `jsonSchema` request never calls `generateContentStream`. Assert `firstTokenMs <= lastTokenMs`.
Do not touch: `THINKING_BUDGET` and its comment, the Anthropic and OpenAI adapters' behaviour, `generateWithRetry`'s retry rule,
`extractLead`, `summariseConversation`, the truncation and empty-reply guards in `reply.ts`.
Proof: before, `google.test.ts` does not exist and `generate` never streams. After: the equivalence tests pass for all five
fixtures; core 232 + T1 + new tests all green; relay 62/62 unchanged; core typecheck clean.

## T3: Live check that Gemini's final stream chunk carries finishReason and usage (decision 8)
Status: DONE 2026-10-17 (probe-stream.out: 5 rows, stopReason and promptTokens non-null on all, STOP x4, MAX_TOKENS x1; row 5 needed a long-answer prompt to hit the cap)
Spec: decision 8 (live half before deploy); open question 8
Depends on: T2
Blocked by: none
Context: Fixtures prove the adapter handles the fields if they arrive. Only the real API proves they do arrive. This runs against
the Gemini API with the key the eval already uses; it touches nothing live (no relay, no database). If the fields do not arrive,
step 1 stops here and SAM reports to Colin (decision 8).
Files: ~/.sam/work/amy-latency/probe-stream.sh (new), ~/.sam/work/amy-latency/probe-stream.ts (new)
Steps:
1. `probe-stream.sh`: loads `~/.sam/call-screener.env` the way `run-eval.sh` does (`set -a; . file; set +a`, output to /dev/null),
   then runs `probe-stream.ts` with `~/.local/node/bin/node --experimental-strip-types` from `packages/core`. Never prints a value.
2. `probe-stream.ts`: builds a `GoogleProvider` from the env key, sends 5 short voice-like requests to `gemini-3.8-flash` with
   `effort: 'low'` and `stream: true` (one of them with `maxOutputTokens: 5` to force MAX_TOKENS). For each, print stopReason,
   promptTokens, visibleTokens, thinkingTokens, completionTokens, firstTokenMs, lastTokenMs, and whether `stopReason` and usage
   were present on the final chunk. Print no reply text.
3. Save the output to `~/.sam/work/amy-latency/probe-stream.out`.
Do not touch: the relay, the database, the live tenant settings, any env file's contents.
Proof: before, no probe output exists. After: `probe-stream.out` shows 5 rows, `stopReason` non-null on every row (STOP on four,
MAX_TOKENS on the forced one) and promptTokens non-null on every row. If any row lacks them: mark this ticket BLOCKED, stop step 1,
and report to SAM.

## T4: One timings line per voice turn, written by replyToCaller
Status: DONE 2026-10-17 (8 new tests incl. one timings line per turn, no caller text/number; core 259/259, relay 62/62, typechecks clean)
Spec: must-do 1, 3; Done-means 1
Depends on: T1, T2
Blocked by: none
Context: Colin needs a per-stage breakdown to decide between streaming and prompt trimming. Stages live in three files:
`replyToCaller` (`voice.ts:111`), `handleInboundMessage` (`pipeline.ts:250`: `resolve_inbound` at :258, inbound `append_message`
at :282, context and memory load `Promise.all` at :313, confusion-count update at :350, callback lookup at :476, the reply at :552)
and `generateReply` (`reply.ts:42`: prompt build at :51, model call at :73, `recordAiLog` at :102), plus `recordAssistantTurn`
(`voice.ts:310`). The line goes to stdout through `logger`, so it lands in the `atwood-relay` journal. It must hold no caller
words, reply text or phone numbers (must-do 3).
Files: packages/core/src/domain/turn-timings.ts (new), packages/core/src/domain/turn-timings.test.ts (new),
packages/core/src/domain/voice.ts (edit), packages/core/src/domain/pipeline.ts (edit), packages/core/src/domain/reply.ts (edit),
packages/core/src/domain/voice.test.ts (edit)
Steps:
1. `turn-timings.ts`: `createTurnTimer(now = () => performance.now())` with `time(stage, fn)` (awaits `fn`, records elapsed ms
   even when it throws), `set(stage, ms)`, `note(key, value: number | string | boolean | null)`, and `snapshot()`. Stage names are
   a fixed union: `resolve_inbound`, `append_inbound`, `load_context_memory`, `confusion_update`, `callback_lookup`, `prompt_build`,
   `gemini_first_token`, `gemini_last_token`, `record_ai_log`, `record_assistant_turn`, `total`. Notes: `prompt_tokens`,
   `visible_tokens`, `thinking_tokens`, `kind` (`model` | `canned` | `handover` | `muted` | `duplicate` | `failed`).
2. `HandleInboundMessageInput` and `GenerateReplyInput` gain optional `timer`. Wrap each stage above in `timer?.time(...)`.
   Stages that do not run on a turn are absent, not zero. Gemini first and last token come from T2's `timing`.
3. `replyToCaller`: create the timer, pass it down, time `recordAssistantTurn`, set `total`, set `kind` on every return path
   (including the `catch` at :153, kind `failed`), and in a `finally` write exactly one line:
   `logger.info('Voice turn timings', { traceId, callSid, turn, kind, stages, tokens })`. Only numbers, the kind, `callSid`,
   `turn` and `traceId` go in.
4. Tests (`turn-timings.test.ts` and `voice.test.ts`): capture `console.log`; run a model turn through `replyToCaller` with T1's fakes.
   Assert exactly one `Voice turn timings` line; every stage from must-do 1 that runs on a model turn is present and a finite number
   >= 0; tokens are numbers; `kind` is `model`. Add a canned goodbye turn (`kind: 'canned'`, no Gemini stages) and a duplicate turn
   (`kind: 'duplicate'`). Assert the serialised line contains neither the heard text, the reply text, nor the from number
   (`+447700900123` style), and that `callSid` survived `redactObject` unchanged.
Do not touch: what any branch of `replyToCaller` returns, the order of steps in `handleInboundMessage`, `recordAiLog`'s row shape,
the relay.
Proof: before, no `Voice turn timings` line exists and the test fails. After: the new tests pass; core green with count reported;
relay 62/62 unchanged; core typecheck clean.

## T5: Relay logs when a turn's first text frame leaves
Status: DONE 2026-10-17 (2 new relay tests: 1500 ms injected clock gives one turn_first_frame, superseded/empty give none; relay 64/64, typecheck clean, core 259/259)
Spec: must-do 2; Done-means 2
Depends on: none
Blocked by: none
Context: The target is defined on the time from `prompt_final` to the first `text` frame for that turn. Today the only text frame
is built at `apps/relay/src/protocol.ts:452` and logged as `turn_answered`; after step 2 the first frame comes earlier. Relay events
go through `onEvent` to `logger.info('Relay call event', ...)` in `server.ts:135`; they do not carry `callSid`, which the stats
script (T7) needs to join with T4's timings line.
Files: apps/relay/src/protocol.ts (edit), apps/relay/src/protocol.test.ts (edit)
Steps:
1. `RelaySessionOptions` gains `now?: () => number` (default `Date.now`), so tests control the clock.
2. In `handlePrompt`, record the time of `prompt_final` for the turn. When the turn's first `text` frame is handed out (today: pushed
   into `messages` at :452), emit `turn_first_frame` with `{ callSid, turn, msSincePromptFinal, streamed: false }`. Once per turn.
   No event for a superseded turn, an empty reply or the silence backstop's line.
3. Test: injected clock; a final prompt answered by a fake reply that resolves 1,500 ms later produces one `turn_first_frame`
   with `msSincePromptFinal: 1500`, `streamed: false`, and the call's `callSid`. A superseded turn produces none.
Do not touch: the frames sent, `turn_answered`, barge-in, the silence backstop, `server.ts`.
Proof: before, no `turn_first_frame` event exists and the new test fails. After: relay 62 + new tests green; relay typecheck clean;
core unchanged.

## T6: Relay frame probe for decisions 2 and 3 (off by default)
Status: DONE 2026-10-17 (8 frame probe tests with fake timers; flag off leaves existing tests unchanged; relay 71/71, typecheck clean, core 259/259)
Spec: decisions 2, 3; open questions 2, 3
Depends on: T5
Blocked by: none
Context: Twilio's docs do not say whether ConversationRelay starts speaking on the first `last: false` frame, or how it treats frames
after an `interrupt`. Colin wants both proved on a real call in step 1, before step 2 is built on them. This is transport-only,
off unless `RELAY_FRAME_PROBE=1`, and answers only three exact spoken phrases, so normal turns are untouched even when on.
Files: apps/relay/src/protocol.ts (edit), apps/relay/src/protocol.test.ts (edit), apps/relay/src/server.ts (edit)
Steps:
1. `RelaySessionOptions` gains `frameProbe?: boolean` (default false). `server.ts` sets it from `process.env.RELAY_FRAME_PROBE === '1'`
   next to the other relay-local knobs, and logs `frameProbe: 'on' | 'off'` in `Relay listening`.
2. When on and a final prompt, lowercased with punctuation removed, contains `latency probe` and `one`, `two` or `check`, the session
   handles it itself (no call to `reply`, no transcript, no `ai_logs`), using `send`:
   - one (decision 2): send `{ type: 'text', token: 'Probe one. This first part was sent on its own. ', last: false }` now, then after
     4,000 ms `{ type: 'text', token: 'And this second part was sent four seconds later.', last: true }`.
   - two (decision 3): send a long `last: false` text (about 15 seconds of speech, plain sentences). If an `interrupt` arrives while it
     plays, log it, wait 2,000 ms, then send `{ type: 'text', token: 'Late part, sent after you interrupted.', last: false }` and nothing
     else (no closing `last: true`).
   - check: reply `{ type: 'text', token: 'Probe check. Can you hear this?', last: true }`.
   Log `probe_frame` with `{ turn, probe, frame, last, msSincePromptFinal }` for every frame sent and `probe_interrupt` for the interrupt.
   The probe constants (4,000 and 2,000 ms, the phrases) are named constants. Every token is non-empty.
3. Tests (fake timers): flag off, the phrase goes to `reply` as normal. Flag on: probe one sends the `last: false` frame at once and the
   `last: true` frame at 4,000 ms; probe two after an interrupt sends exactly one late `last: false` frame at +2,000 ms and no `last: true`;
   check sends one `last: true` frame. No probe frame is empty.
Do not touch: normal turn handling, the silence backstop, `takeBackUnheard`, the TwiML, the systemd unit and the env file.
Proof: before, the probe tests fail (no `frameProbe` option). After: relay green with the new tests, count reported; with the flag off
every existing relay test passes unchanged; relay typecheck clean.

## T7: Stats script: per-stage and first-frame p50/p95 from the relay journal
Status: DONE 2026-10-17 (latency-stats.test.mjs passes on hand-worked fixture; live journal since 2026-10-01 runs, 5 calls, 0 answered turns as expected; callSid-less events attributed by setup order, see report)
Spec: must-do 5; Done-means 4 (script), Done-means 19 (same script)
Depends on: T4, T5, T6
Blocked by: none
Context: Done-means 4 and 19 both read numbers from `journalctl --user -u atwood-relay` with one script. It joins T4's
`Voice turn timings` lines and T5's `turn_first_frame` events on `callSid` and `turn`. Superseded, interrupted and call-ending turns
are left out of the target figures, as in the trial baseline (`/home/col/.sam/work/receptionist-eleven-trial/report.md`).
Probe turns (T6) are always left out.
Files: ~/.sam/work/amy-latency/latency-stats.mjs (new), ~/.sam/work/amy-latency/fixtures/journal-sample.jsonl (new),
~/.sam/work/amy-latency/latency-stats.test.mjs (new)
Steps:
1. `latency-stats.mjs --since "<time>" [--until "<time>"] [--file <path>]`: reads `journalctl --user -u atwood-relay -o cat --since ...`
   (or `--file` for tests), parses the JSON lines, keeps `Voice turn timings`, `Relay call event` with `event` in `prompt_final`,
   `turn_first_frame`, `turn_superseded`, `interrupt`, `reply_cut_off`, `turn_answered`, `session_end`, `probe_frame`.
2. Exclusions: a turn whose reply was superseded, cut off by an interrupt, or whose `turn_answered.endCall` is true; any probe turn.
3. Print: counts (calls, answered turns, model turns); a table of p50 and p95 per stage from must-do 1; Supabase subtotal (resolve,
   append, context/memory load, `record_ai_log`, `record_assistant_turn`); `gemini_last_token - gemini_first_token`; thinking tokens
   (min, p50, max); first-frame p50/p95 over all answered turns and over model turns only, with the target beside each
   (0.78 s / 1.46 s / 0.83 s) and PASS or MISS. Percentiles by nearest rank, written down in a comment.
4. A `--json` flag prints the same as JSON for the write-up and T24.
5. Fixture: a hand-built journal sample with known values (two calls, eight turns, one superseded, one interrupted, one ending,
   one probe). The test runs the script on it and checks every printed figure against values worked out by hand in the test.
Do not touch: the relay, the journal itself, the receptionist-watch script.
Proof: before, no script. After: `node ~/.sam/work/amy-latency/latency-stats.test.mjs` passes; running it against the live journal
since 2026-10-01 completes without error (old turns simply have no timings line) and prints counts.

## T8: True caller-perceived delay from a call recording (decision 9)
Status: DONE 2026-10-17 (measure-gaps.test.mjs: gaps 2000/3100/2600 ms measured exactly; record-call.mjs start CAxxxx --dry-run prints masked request, no network)
Spec: decision 9; open question 9
Depends on: none
Blocked by: none
Context: Nothing measures end of caller speech to Amy's first audio. Colin wants it measured before (step 1) and after (T26).
Twilio can record a live call in two channels (REST `POST /2010-04-01/Accounts/{AccountSid}/Calls/{CallSid}/Recordings.json` with
`RecordingChannels=dual`), one channel per party. Gaps between channels give the delay per turn. `ffmpeg` is at `/usr/bin/ffmpeg`.
Starting a recording is a change on the live Twilio account, so the script is built and tested here and only run inside a GATE (T10, T26).
Files: ~/.sam/work/amy-latency/record-call.mjs (new), ~/.sam/work/amy-latency/measure-gaps.mjs (new),
~/.sam/work/amy-latency/measure-gaps.test.mjs (new)
Steps:
1. `record-call.mjs start <CallSid>` / `fetch <CallSid>`: loads the Twilio credentials from `apps/web/.env.local` the way
   `receptionist-watch.mjs` does (parse in process, never print), starts a dual-channel recording on that call, and later downloads
   the WAV to `~/.sam/work/amy-latency/recordings/<CallSid>.wav`. It does not delete the Twilio copy (SAM asks Colin).
   `--dry-run` prints the request it would make with the SIDs masked.
2. `measure-gaps.mjs <wav>`: splits channels with `ffmpeg`, runs `silencedetect` on each (named thresholds, for example -35 dB and
   0.25 s), works out which channel is Amy (the one speaking first, because the greeting plays before the caller says anything), and
   for each caller utterance prints end-of-caller-speech to start-of-Amy-speech in ms, then p50 and p95.
3. Test: generate a synthetic stereo WAV with `ffmpeg` (tone bursts with known gaps of 2,000, 3,100 and 2,600 ms, left channel first),
   run `measure-gaps.mjs` on it, expect each gap within 60 ms.
Do not touch: the TwiML and web app, the Twilio number configuration, any env file's contents.
Proof: before, no scripts. After: `node ~/.sam/work/amy-latency/measure-gaps.test.mjs` passes; `record-call.mjs start CAxxxx --dry-run`
prints a masked request and makes no network call.

## T9: Step 1 suites green and committed through the Atwood gate
Status: DONE 2026-10-17 (core 259/259, relay 71/71, core/relay/web typecheck clean; step 1 committed on restyle/glassmorphism, no push)
Spec: Done-means 18 (step 1 part), Done-means 21 (step 1 part)
Depends on: T1, T2, T4, T5, T6
Blocked by: none
Context: Step 1 must be committed before it is deployed, so the live relay runs a known commit. Nothing is deployed here.
Files: none (git only)
Steps:
1. Run core and relay tests, core, relay and web typechecks. Report counts against the baseline (core 232, relay 62).
2. `git status`: only the step 1 files changed; nothing under `supabase/`, nothing in `apps/web/src/lib/conversation-relay.ts`.
   `implementation/amy-latency-spec.md` and this tickets file go in the same commit if still untracked.
3. Commit on `restyle/glassmorphism` through the Atwood gate. Never `main`, never force. Push only if Colin asks.
Do not touch: `main`, any deploy, any env file, the systemd unit.
Proof: before, `git log -1` is `13da8b4`. After: `git log --oneline 13da8b4..HEAD` shows the step 1 commit(s); suites green with counts.

## T9b: callSid on every relay event, a session_end on hang-up, stats join on callSid, and the no-finish-reason stream guard
Status: DONE 2026-10-17 (core 262, relay 74, typechecks clean, stats test passes; before-run failed as expected)
Spec: must-do 2 and 5 (trustworthy per-call joins), must-do 4 (streamed result equals the whole one); added 2026-10-17 by SAM with
Colin's yes, from the step 1 build report point 4 and review findings 1, 3 and 4 (`/home/col/.sam/work/amy-latency/step1-review.md`)
Depends on: T9
Blocked by: none
Context (review finding 1): `packages/core/src/ai/google.ts:118` to `:143` accepts whatever text has arrived when the stream ends, even
if no chunk carried a `finishReason`, giving `stopReason: null, truncated: false`, so the caller would hear half a sentence as a whole
reply. The whole-response path cannot do this. Guard: after the loop, if no finish reason arrived and the text is non-empty, throw a
retryable `ProviderError` (message `stream ended without finish reason`) through the same path as other provider errors.
Context (callSid): Only `setup` and `turn_first_frame` carry `callSid` (not `probe_frame` or `probe_interrupt` either). Every other relay event (`prompt_final`,
`turn_superseded`, `interrupt`, `reply_cut_off`, `turn_answered`, ...) lacks it, so `latency-stats.mjs` attributes them to the most
recent `setup`, which mixes up two concurrent calls. A caller hanging up never logs `session_end` (live journal: 5 setups, 0 session_end):
`server.ts`'s `ws.on('close')` logs `Relay socket closed` without `callSid` or a session end. Fix both before T10 so the step 1
evidence and every later figure join on `callSid`. Logging only; no frame, timing or reply changes.
Files: apps/relay/src/protocol.ts (edit), apps/relay/src/protocol.test.ts (edit), apps/relay/src/server.ts (edit),
~/.sam/work/amy-latency/latency-stats.mjs (edit), ~/.sam/work/amy-latency/latency-stats.test.mjs (edit),
~/.sam/work/amy-latency/fixtures/ (edit or add a sample), packages/core/src/ai/google.ts (edit), packages/core/src/ai/google.test.ts (edit)
Steps:
0. `google.ts`: the no-finish-reason guard above. `google.test.ts`: a sixth fixture, text split into 1, 2 and 5 chunks with no
   `finishReason` on any chunk, expects the retryable `ProviderError`; the five existing equivalence fixtures still pass unchanged.
1. `protocol.ts`: wrap `onEvent` once in the `RelaySession` constructor so every event carries `callSid` once `setup` has been seen
   (`{ callSid: this.call?.callSid ?? null, ...fields }`, so fields already carrying `callSid` keep theirs; review finding 3). Update the
   exact-fields assertion for `probe_frame` (`protocol.test.ts:827`). Add a read-only `callSid` getter and a `turnCount` getter on `RelaySession`.
2. `server.ts`: `Relay socket closed` gains `callSid` and `turns`. When the session did not end itself (`!session.isEnded`), log one
   `Relay call event` with `event: 'session_end'`, `reason: 'socket_closed'`, `callSid`, `turns`, `code`. Nothing else in the close handler changes.
3. `latency-stats.mjs`: join on `callSid` when an event has it; keep the last-`setup` attribution only as the fallback for old journal
   lines without it, and print how many events used the fallback. Count `session_end` with reason `socket_closed` as an ordinary end.
   Review finding 4: the `reasons.unattributable` column (`latency-stats.mjs:166`, printed at `:386`) is never incremented; point it at
   the real unattributable-events counter or remove it, and make the test check the printed figure.
4. Tests: relay, every event emitted after `setup` in an existing scripted call carries the call's `callSid`, and events before `setup`
   carry none; a fake socket close without an end logs one `session_end` `socket_closed`. Stats, a fixture with two interleaved
   calls (events alternating) attributes every turn to the right call and reports 0 fallback events; the old fixture still passes
   and reports its fallback count.
Do not touch: frames sent, timings, barge-in, silence backstop, probe behaviour, any core file other than `google.ts` and
`google.test.ts`, the whole (non-streamed) Gemini path, `generateWithRetry`, the env file, the systemd unit.
Proof: before, the no-finish-reason fixture, the interleaved-calls stats test and the relay callSid test fail. After: all pass; relay
green with count (71 + new); core green with count (259 + new); core and relay typecheck clean; `latency-stats.mjs --since 2026-10-01` still runs on the live journal and prints the
fallback count. Commit on `restyle/glassmorphism` (subject starting `Amy latency step 1b:`), not pushed.

## T10: GATE: deploy step 1 to the live relay and collect the step 1 evidence (Colin's go)
Status: TODO
Spec: must-do 5; Done-means 4; decisions 2, 3, 8 (live), 9 (before figure)
Depends on: T3, T7, T8, T9, T9b
Blocked by: Colin's go to deploy (SAM asks; no go, no deploy)
Context: Live production (the VOLTA demo tenant) runs from this checkout through `atwood-relay.service`. A relay restart drops any
call in progress. The probe is turned on only for the probe calls and off again before the baseline calls.
Files: ~/.config/systemd/user/atwood-relay.service.d/frame-probe.conf (new, then removed), ~/.sam/work/amy-latency/step1-evidence.md (new)
Steps:
1. SAM states to Colin: the commit, that step 1 is logging only plus the off-by-default probe, the restart, and the recording.
   Wait for go.
2. Deploy path: confirm HEAD is T9's commit, run both suites, add the drop-in with `Environment=RELAY_FRAME_PROBE=1`
   (not the env file), `systemctl --user daemon-reload`, restart `atwood-relay`, confirm the new PID start time is after the restart
   and `Relay listening` shows `frameProbe: 'on'`.
3. Decision 2: Colin rings 07462 187713 and says "latency probe one". He reports whether "Probe one..." started before the 4 s gap
   or arrived together with the second part. Journal `probe_frame` times go in the evidence file.
4. Decision 3: Colin says "latency probe two", talks over it, waits, then says "latency probe check". He reports whether the late part
   was spoken and whether the check line played. Record: is a closing `last: true` needed after an interrupt (yes if the check line
   did not play), and are late `last: false` frames spoken.
5. Remove the drop-in, daemon-reload, restart, confirm `frameProbe: 'off'`.
6. Decision 9 before figure: on one baseline call, SAM runs `record-call.mjs start <CallSid>` while Colin talks, then `fetch`, then
   `measure-gaps.mjs`. Record per-turn gaps, p50, p95.
7. Must-do 5: at least 30 answered turns across at least 5 calls (Colin, or the 6-line script from the trial report).
8. Decision 8 live: read-only select on `ai_logs` for voice `reply` rows since the restart: `stop_reason`, `prompt_tokens`,
   `completion_tokens` non-null on every row. Thinking tokens from the timings lines.
9. Run `latency-stats.mjs --since "<restart time>"`, save its output and `--json` beside the evidence file.
Do not touch: the env file, the TwiML, `speechTimeout`, the Twilio number configuration, the database (reads only), `main`.
Proof: before, `step1-evidence.md` does not exist and the journal has no `Voice turn timings` lines. After: the evidence file holds
the probe results for decisions 2 and 3, the `ai_logs` result for decision 8, the recording gaps, and stats output showing at least
30 answered turns across at least 5 calls; `Relay listening` shows `frameProbe: 'off'` after step 5.
If decision 8 fails (fields missing), stop: set this ticket and T11 to BLOCKED and report.

## T11: GATE: SAM puts the stage timings and the step 1 proofs (decisions 2, 3, 8) to Colin before any step 2 ticket starts
Status: TODO
Spec: must-do 5, 19 (the count), Done-means 4 (write-up), Done-means 14 (thinking-token statement); decisions 1, 2, 3, 8, and the
closing paragraph of "Decisions at lock"
Depends on: T10
Blocked by: Colin's answer
Context: Step 1's numbers decide what happens next (spec "How step 1 decides"). If Gemini's time to first token dominates, the levers
may shift (prompt size, Gemini prompt caching, model tier) and Colin decides. Every step 2 and step 3 ticket depends on this one.
Files: ~/.sam/work/amy-latency/step1-baseline.md (new)
Steps:
1. Write `step1-baseline.md` from T10's evidence: the per-stage p50/p95 table; first-frame p50/p95 over all answered turns and over
   model turns against target (a); Gemini time to first token p50 and last-minus-first p50; the Supabase subtotal; the thinking-token
   count on voice turns (must-do 19, Done-means 14); the true caller-perceived delay (decision 9); the decision 2, 3 and 8 results.
2. Apply the rule: first-token p50 above about 0.6 s means step 3 first and Colin says whether target (a) still stands;
   last-minus-first the bigger share means step 2 first; Supabase subtotal above about 0.3 s p50 is reported as a third lever, out of scope;
   zero thinking tokens means T22 makes no change. Give SAM's recommendation in one paragraph.
3. Spell out what the decision 2 and 3 results mean for step 2: if ConversationRelay waits for `last: true` before speaking, streaming
   saves nothing and step 2 should be dropped; if a closing `last: true` is needed after an interrupt, T18 changes (Colin decides how).
4. SAM puts it to Colin. Record his answer here, under this ticket, with the date: order of steps 2 and 3, any step dropped,
   whether target (a) stands, any new lever (that becomes a new spec, not a ticket here).
Do not touch: any code, the live system.
Proof: before, `step1-baseline.md` does not exist and no answer is recorded here. After: the file exists with every item in step 1,
and Colin's answer is written under this ticket. Only then set `Status: DONE`.

---

# Step 2: stream the first sentence on ordinary turns (option A)

All step 2 tickets depend on T11 and follow Colin's answer there. If T11 records that ConversationRelay does not speak before
`last: true`, step 2 is DROPPED.

## T12: Sentence splitter for spoken streaming (pure)
Status: TODO
Spec: must-do 7, 8, 9 (core cleaning), 10; Done-means 7 (core half), Done-means 8
Depends on: T11
Blocked by: none
Context: A streamed turn must say the same words as the whole turn would: `limitForSpeech(cleanModelReply(full)).body` with the
400-character `MAX_SPOKEN_CHARS` cap (`packages/core/src/utils/speech.ts:44`, `:116`; `cleanModelReply` in `utils/sms.ts:167`).
The final frame must never be empty, so the last sentence is always held until the model finishes. Pure function, no I/O.
Files: packages/core/src/utils/speech-stream.ts (new), packages/core/src/utils/speech-stream.test.ts (new),
packages/core/src/utils/index.ts (edit, export it like its neighbours)
Steps:
1. `createSpeechSplitter()` returning `{ push(delta: string): string[]; finish(): string }`. `push` returns zero or more pieces to send
   now with `last: false`; `finish` returns the text for the closing `last: true` frame.
2. A sentence is complete when `.`, `?` or `!` is followed by whitespace and then a non-space character. Work on the accumulated raw text;
   do not release text inside an open code fence, unclosed backtick, unclosed `[` or `(` of a link, unclosed `<`, or a URL still at the end.
   Strip a leading `Reply:`-style label and a leading wrapping quote from the first piece (as `cleanModelReply` would). Clean each piece
   with `cleanForSpeech`; skip pieces that clean to nothing.
3. Hold-back rule: release piece k only when piece k+1 is complete and non-empty after cleaning, and the cleaned text up to the end of
   piece k+1 plus one is within `MAX_SPOKEN_CHARS`. Stop releasing once that would pass the cap.
4. Each released piece ends with exactly one space, so words never run together (Twilio: "Don't trim LLM tokens"). `finish()` returns
   `limitForSpeech(cleanModelReply(full)).body` with the released prefix removed (compared with whitespace normalised). By the hold-back
   rule this is non-empty whenever the whole reply is non-empty. If the whole reply cleans to nothing, `finish()` returns `''` and the
   caller treats it as an empty reply (T15).
5. Tests over fixed model outputs: one sentence (nothing released, all in `finish`); three sentences; wrapped quotes; a `Reply:` label;
   a `<thinking>` tag split across two deltas; markdown bold and a list; emoji; a URL mid-sentence; a link; a reply over 400 characters;
   a reply whose last chunk cleans to nothing; a reply of only markup. Each fed as 1-character, 7-character and whole-reply deltas.
   Assert: joined pieces plus `finish()` equal `limitForSpeech(cleanModelReply(full)).body` up to whitespace; `finish()` is non-empty
   unless the whole reply cleans to nothing; no piece is empty or whitespace-only; adjacent pieces never join two words.
   Edge: a reply that opens with a quote and never closes it. If exact equality cannot hold there, the test allows exactly that one
   leading quote character to differ and says so in a comment; nothing else may differ.
Do not touch: `cleanForSpeech`, `limitForSpeech`, `cleanModelReply`, `MAX_SPOKEN_CHARS`.
Proof: before, `speech-stream.test.ts` does not exist. After: all fixtures pass at all three delta sizes; core green with count;
relay unchanged; core typecheck clean.

## T13: Google adapter hands out text as it arrives, with a 3 s stall limit and retry only before the first word
Status: TODO
Spec: must-do 13, 14; Done-means 10 (core half: retry rule and stall)
Depends on: T11, T2
Blocked by: none
Context: T2 made the adapter stream internally. Step 2 needs the text as it arrives, a way to stop the request, a stall limit once
the first sentence has gone out (3 s, decision 6), and the existing single retry after 750 ms (`generateWithRetry`, `ai/index.ts`)
only if nothing has reached the caller. Anthropic and OpenAI tenants keep the whole path (spec "Won't do").
Files: packages/core/src/ai/provider.ts (edit), packages/core/src/ai/google.ts (edit), packages/core/src/ai/index.ts (edit),
packages/core/src/ai/google.test.ts (edit), packages/core/src/testing/fake-provider.ts (edit)
Steps:
1. `GenerateRequest` gains optional `onText?: (delta: string) => void` and `signal?: AbortSignal`. Only the Google adapter honours
   `onText`; it combines `signal` with the existing timeout signal (`AbortSignal.any`).
2. Named constant `STREAM_STALL_MS = 3000` in `google.ts` (or `provider.ts`), with a comment pointing at the spec decision. A
   `markSpoken()` hook (or an option the caller sets once the first piece is sent) starts the stall clock; after that, no new chunk for
   `STREAM_STALL_MS` aborts the request and throws a `ProviderError` with `retryable: false` and message `stream stalled`.
3. `generateWithRetry` gains an option `retryIf?: () => boolean`; the voice path passes "nothing has been spoken yet". Default unchanged.
4. Fake provider: a streaming variant driven by a script of `{ delta | wait | finish(reason, usage) | throw }` steps, honouring `signal`.
5. Tests (fake timers): deltas reach `onText` in order before the call resolves; abort via `signal` stops reading and rejects;
   after `markSpoken`, 3,000 ms of silence throws `stream stalled` and 2,999 ms does not; before `markSpoken`, a long gap does not trip it;
   a retryable throw before any spoken piece is retried once after 750 ms; the same throw after a spoken piece is not retried.
Do not touch: `THINKING_BUDGET`, the 45 s timeout, the whole-reply result shape (T2's equivalence tests must still pass), extraction.
Proof: before, the new tests fail (no `onText`, no stall). After: new and T2 tests pass; core green with count; core typecheck clean.

## T14: generateReply streams speakable pieces for voice when asked
Status: TODO
Spec: must-do 7, 9, 10, 12 (core outcomes unchanged); Done-means 8 (through generateReply)
Depends on: T11, T12, T13
Blocked by: none
Context: `generateReply` (`reply.ts:42`) builds the prompt, calls the model, writes `ai_logs`, then cleans and trims. With an
`onSpeech` callback it should feed the model's deltas through T12's splitter and pass each released piece out at once. The return value,
the `ai_logs` row (full model output) and the refusal, truncation and empty-reply outcomes stay as today (`reply.ts:121-163`).
Files: packages/core/src/domain/reply.ts (edit), packages/core/src/domain/reply.test.ts (new)
Steps:
1. `GenerateReplyInput` gains optional `onSpeech?: (piece: string) => void` and `signal?: AbortSignal`. Ignored unless
   `memory.channel === 'voice'` and `settings.ai_provider === 'google'`.
2. When active: pass `onText` into the request, feed it to a splitter, call `onSpeech` for each piece, call the adapter's `markSpoken`
   after the first piece, pass `signal`, and use `retryIf: () => nothing spoken yet`.
3. After the call: `ai_logs` row as now. Refusal, truncation and empty reply behave exactly as now (refused result, or `providerRefused`
   throw). On success the returned `body` is the whole `limitForSpeech` result as now, plus a new field `finalPiece` = `splitter.finish()`.
4. Tests with T1's fakes: a three-sentence reply calls `onSpeech` before the provider resolves; `body` equals the non-streamed body for
   the same output; `finalPiece` is non-empty; SMS and web channels never call `onSpeech`; an Anthropic tenant never calls it.
Do not touch: `recordAiLog`, `summariseConversation`, the SMS trim path, the truncation guard's behaviour.
Proof: before, `reply.test.ts` does not exist. After: tests pass; core green with count; core typecheck clean.

## T15: Voice turns stream only when ordinary; failures after the first sentence close with today's line
Status: TODO
Spec: must-do 6, 11, 12, 16 (transcript); Done-means 5 (core half), Done-means 10 (core half), Done-means 12 (first half);
Robustness "fallback lines logged at warn or error with the reason"
Depends on: T11, T14
Blocked by: none
Context: Only ordinary turns may stream: no canned closing line (`cannedReply`), no handover (`detectHandover`, decided before the model),
not muted, not a duplicate. In `handleInboundMessage` (`pipeline.ts`) those are all decided before `generateReply` at :552, so passing
`onSpeech` only into that call is enough. After partial speech: SAFETY or PROHIBITED_CONTENT gives today's `ai_error` handover line
(`renderHandoverMessage`, :581) with the handover requested and owner notified; truncation, empty reply, provider error or stall give
`CANNOT_TAKE_CALL` (`voice.ts:60`) and `endCall: true`, as the catch at `voice.ts:153` does now. The transcript row holds everything sent.
Files: packages/core/src/domain/pipeline.ts (edit), packages/core/src/domain/voice.ts (edit), packages/core/src/domain/voice.test.ts (edit)
Steps:
1. `HandleInboundMessageInput` gains optional `onSpeech` and `signal`, passed only into the `generateReply` call at :552. Add `finalPiece`
   to the returned `reply` when streaming happened. If `signal` aborted, return normally with `aborted: true` and `reply: null`
   and skip the extraction and notification closure (the turn was abandoned); log at info.
2. `VoiceTurnInput` gains optional `onSpeech` and `signal`. `replyToCaller` wraps `onSpeech` to accumulate `sentSoFar`.
   `VoiceTurnResult` gains `streamed: string` (what was already sent; `''` when not streamed) and keeps `speak` as the text for the
   closing `last: true` frame.
3. Outcomes when `sentSoFar` is non-empty:
   - success: `speak = finalPiece`; `closing` from `isWrapUpLine(sentSoFar + finalPiece)`; `endCall: false`.
   - refusal (handover `ai_error`): `speak = renderHandoverMessage` line, `endCall: true`, handover requested and notified as today.
   - thrown (truncation, empty, provider error, stall): `speak = CANNOT_TAKE_CALL`, `endCall: true`, logged at error with the reason.
   - aborted: no `speak`; transcript written with `sentSoFar` only.
   When nothing was sent, every path is exactly today's.
4. `recordAssistantTurn` body: `sentSoFar + speak` (full text sent, failure line included), or `sentSoFar` for an aborted turn.
   `ai_logs` unchanged. The catch path needs `conversationId`, which it does not have today: add an optional `onResolved(conversationId)`
   callback to `HandleInboundMessageInput`, called right after `resolve_inbound`, and keep the id in `replyToCaller`.
5. Tests with T1's fakes: goodbye, "anything else?", each `HandoverReason` that `detectHandover` can return, capture pending, muted,
   duplicate: `onSpeech` is never called and `speak` is non-empty. Ordinary turn: `onSpeech` called before return, `endCall: false`,
   transcript body = everything sent. After the first piece: SAFETY gives the handover line + `endCall: true` + one `request_handover`;
   MAX_TOKENS, throw and stall each give `CANNOT_TAKE_CALL` + `endCall: true`; transcript holds the first piece plus the line.
   A throw before the first piece is retried once and then behaves as today.
Do not touch: `decideCallerClosing`, `decideMutedTurn`, `isWrapUpLine`, handover patterns, `capturePending` rule at `voice.ts:281`,
the SMS and WhatsApp paths (no `onSpeech` there), the T4 timings line (extend `kind` only if needed).
Proof: before, the new cases fail (no `onSpeech`). After: all pass; core green with count; core typecheck clean; relay unchanged.

## T16: The next turn waits for the previous turn's transcript row
Status: TODO
Spec: must-do 17; Done-means 12 (second half); must-do 15 (transcript mark on a streamed turn)
Depends on: T11, T15
Blocked by: none
Context: Today the reply returns only after `recordAssistantTurn` (`voice.ts:224`), so the next turn always reads a complete transcript.
With streaming the caller hears the reply before that write and can answer early. `recordInterruptedTurn` (`voice.ts:352`) also looks
up the row by `callSid` and `turn` and would find nothing if it ran before the write.
Files: packages/core/src/domain/voice.ts (edit), packages/core/src/domain/pipeline.ts (edit), packages/core/src/domain/voice.test.ts (edit)
Steps:
1. In `voice.ts`, a module-level map from `callSid` to the promise of the latest pending `recordAssistantTurn`. Clear an entry when it
   settles and is still the latest.
2. `HandleInboundMessageInput` gains optional `waitBeforeMemoryLoad?: Promise<unknown>`, awaited (errors ignored) just before the
   context and memory load at `pipeline.ts:313`. `replyToCaller` passes the pending write for its `callSid`.
3. `recordInterruptedTurn` awaits the pending write for its `callSid` before its select.
4. Tests: fake Supabase delays the outbound `append_message` by 500 ms (fake timers or real short delay). Turn 2 starts while turn 1's
   write is pending; assert turn 2's `messages` select for memory happens after turn 1's write completes. Same for `recordInterruptedTurn`.
Do not touch: `recordAssistantTurn`'s row shape, `append_message`, SMS (no `callSid`, no wait).
Proof: before, the ordering test fails (turn 2 loads memory first). After: it passes; core green with count; core typecheck clean.

## T17: Relay sends streamed frames, ends with one non-empty last:true frame
Status: TODO
Spec: must-do 7, 8, 9 (relay sanitising), 11; Done-means 5 (relay half), 6, 7, 9; must-do 2 (first frame when streamed)
Depends on: T11, T15
Blocked by: T11 result on decision 2 (step 2 dropped if ConversationRelay waits for `last: true`)
Context: `handlePrompt` (`protocol.ts:394`) awaits the whole reply, then returns one `text` frame with `last: true`. It must now send
`last: false` frames through the session's `send` as pieces arrive, while the turn is still `pendingTurn`, then return the closing
`last: true` frame (and `end` if asked). `sanitiseForSpeech` (:92) trims, which would join words across frames, so streamed pieces need
a variant that keeps one edge space. The protocol type is declared locally (`RelayReplyRequest`, :105) and checked against core's
`replyToCaller` by typecheck in `server.ts`.
Files: apps/relay/src/protocol.ts (edit), apps/relay/src/protocol.test.ts (edit)
Steps:
1. `RelayReplyRequest` gains optional `onSpeech?: (piece: string) => void` and `signal?: AbortSignal`; `RelayReply` gains optional
   `streamed?: string`. `RelaySessionOptions` gains `streamReplies?: boolean` (default false). Streaming is active only when
   `streamReplies` and `send` are both set.
2. `sanitisePieceForSpeech(text)`: same character rule as `sanitiseForSpeech`, collapses runs of whitespace to one space, does not trim;
   returns `''` if no non-space character remains. Pieces that sanitise to `''` are not sent.
3. Per streamed piece, if `pendingTurn === turn`: `send([{ type: 'text', token, last: false }])`; the first one emits T5's
   `turn_first_frame` with `streamed: true`. Track everything sent for the turn.
4. On return: closing frame `{ type: 'text', token: sanitiseForSpeech(reply.speak), last: true }` if non-empty (if empty, log
   `empty_reply` as today and send no `last: true`). `lastSpoken.token` = everything sent for the turn. `end` as today. Silence backstop
   armed only after the closing frame, from the whole spoken length (`streamed + speak`), as today for `wrapped_up` and
   `asked_anything_else`.
5. Tests with a fake reply fn that calls `onSpeech` on a timer before resolving: first `last: false` frame is sent before the fake resolves
   (Done-means 6); last frame has `last: true` and non-empty text; no frame of any kind has an empty or whitespace-only token, for fakes that
   stream one piece, several pieces, and pieces that sanitise to nothing (Done-means 7); a streamed ordinary reply never sends `end`; a
   `wrapped_up` reply arms the backstop only after the closing frame with the whole length; an `asked_anything_else` reply is one frame
   (the fake never streams it, and the session sends nothing else) (Done-means 9); a non-streamed reply produces exactly one `last: true`
   frame (Done-means 5 relay half).
Do not touch: interim prompt handling, `parseFrame`, the silence timings, `NO_REPLY`, the setup frame, `server.ts` (T19).
Proof: before, the streaming tests fail. After: they pass; with `streamReplies` off every existing relay test passes unchanged;
relay green with count; relay typecheck clean.

## T18: Barge-in on a streamed turn stops the frames and the Gemini request
Status: TODO
Spec: must-do 15; Done-means 11
Depends on: T11, T17
Blocked by: T11 result on decision 3 (if a closing `last: true` is needed after an interrupt, Colin's answer at T11 replaces step 2 below)
Context: Today `interrupt` clears `pendingTurn` and calls `takeBackUnheard` (`protocol.ts:347-353`); a newer final prompt replaces
`pendingTurn` (:419). With streaming, both must also stop further frames and abort the model request. `takeBackUnheard` must measure
what was heard against everything sent for that turn.
Files: apps/relay/src/protocol.ts (edit), apps/relay/src/protocol.test.ts (edit)
Steps:
1. One `AbortController` per pending turn, its `signal` passed in the reply request. On `interrupt` or a newer final prompt, abort it.
2. After abort: no further frames for that turn, no `last: true`, no `end` from that turn. Log `stream_aborted` with `{ turn, by, sentChars }`.
3. `takeBackUnheard` uses `lastSpoken.token` = everything sent for the turn so far (set as each piece goes out), so `reply_cut_off` and
   `onInterrupted` reflect it.
4. Tests: fake reply streams two pieces then waits; `interrupt` arrives; assert the fake's signal is aborted, no more frames are sent
   even if the fake later calls `onSpeech` or resolves, and `reply_cut_off.heardChars` compares against both pieces. Repeat with a
   newer final prompt instead of `interrupt`.
Do not touch: the non-streamed barge-in behaviour (existing tests unchanged), the closing-state take-back rule `HEARD_IN_FULL`.
Proof: before, the abort tests fail. After: they pass; relay green with count; relay typecheck clean.

## T19: Streaming setting in the relay, default on
Status: TODO
Spec: must-do 18; Done-means 13; Robustness rollback
Depends on: T11, T16, T17, T18
Blocked by: none
Context: One setting turns streaming off with no code deploy (a relay restart only). Relay-local knobs are read straight off
`process.env` in `server.ts` (see `RELAY_PORT`, `RELAY_HOST`). Default on once Done-means 7 to 12 pass, which they do by this ticket.
Files: apps/relay/src/server.ts (edit), apps/relay/README.md (edit), apps/relay/src/protocol.test.ts (edit)
Steps:
1. `server.ts`: `const STREAM_REPLIES = process.env.RELAY_STREAM_REPLIES !== '0';` with a comment: set `RELAY_STREAM_REPLIES=0` in a
   systemd drop-in to speak every turn whole, exactly as before. Pass `streamReplies` to `RelaySession`; pass `onSpeech` and `signal`
   through to `replyToCaller`. Log `streamReplies: 'on' | 'off'` in `Relay listening`.
2. README: one paragraph on the setting and how to turn it off (drop-in, daemon-reload, restart).
3. Test: with `streamReplies: false` and a reply fn that would stream, every turn is one `last: true` frame and `onSpeech` is not passed.
Do not touch: `RELAY_HOST` loopback default, signature checks, the env file, the systemd unit file.
Proof: before, there is no `RELAY_STREAM_REPLIES`. After: the test passes; relay and core green with counts; relay, core and web
typechecks clean (`server.ts` still type-checks `replyToCaller` against `RelayReplyFn`).

---

# Step 3: cut time to first word (voice only)

All step 3 tickets depend on T11.

## T20: Eval runner can run all 32 cases on the voice channel
Status: TODO
Spec: decision 5; open question 5; constraint "eval gate 28/32"
Depends on: T11
Blocked by: none
Context: Only 2 of the 32 behaviour cases build the voice prompt; the rest use SMS. Colin said yes to running all 32 on voice before
and after the trim. Cases and judges do not change (spec "Won't do"); only the channel the prompt is built for.
Cases are built with `memory(channel, ...)` in `packages/core/src/prompts/receptionist.behaviour.test.ts`; the runner script is
`~/.sam/work/receptionist-eval-gemini/run-eval.sh` (outside the repo).
Files: packages/core/src/prompts/receptionist.behaviour.test.ts (edit), ~/.sam/work/receptionist-eval-gemini/run-eval.sh (edit)
Steps:
1. Test file: an `EVAL_CHANNEL` env knob (unset = today). When `voice`, every case's memory is built with channel `voice`. Results JSON
   records the channel. Add one unit test (no model) that the knob maps every case to `voice`, and unset leaves them as they are.
2. `run-eval.sh <effort> [model] [channel]`: passes `EVAL_CHANNEL`; the tag and results file name include the channel when set
   (for example `results-gemini-38-flash-low-voice.json`). Unchanged when the third argument is absent. Still never prints a value.
3. Run the before baselines (real model, costs money, no live system): `run-eval.sh low` and `run-eval.sh low gemini-3.8-flash voice`.
   Save both results files as `-before-trim` copies.
Do not touch: any case, any judge, the scoring, `DEFAULT_EVAL_MODEL`, the env file's contents.
Proof: before, `EVAL_CHANNEL` does not exist and the knob test fails. After: core green with count (model eval still skipped without
`RUN_MODEL_EVALS`); both before-trim results files exist with per-case results; SMS-channel score reported against 28/32.

## T21: Snapshot of the non-voice prompts
Status: TODO
Spec: must-do 21; Done-means 16
Depends on: T11
Blocked by: none
Context: The trim (T23) may touch only the voice branch of `buildReceptionistSystemPrompt` (`packages/core/src/prompts/receptionist.ts:49`).
SMS, WhatsApp, email and web prompts must stay byte for byte the same. The snapshot must be taken before T23 changes anything.
Files: packages/core/src/prompts/receptionist.snapshot.test.ts (new), packages/core/src/prompts/__snapshots__/ (new, four files)
Steps:
1. Using the fixtures in `receptionist.test.ts` (reuse or copy `makeContext`) and a fixed `now`, build the prompt for `sms`, `whatsapp`,
   `email` and `web`, with and without a returning contact and with a callback pending.
2. Write them once to `__snapshots__/<channel>-<case>.txt` (a `UPDATE_SNAPSHOTS=1` path that refuses to run in CI is fine), then the
   test compares byte for byte.
Do not touch: `receptionist.ts`.
Proof: before, the test does not exist. After: it passes on the current code; temporarily changing one character in a shared prompt line
makes it fail (revert the change); core green with count.

## T22: Thinking budget decision for voice replies
Status: TODO
Spec: must-do 19; Done-means 14
Depends on: T11
Blocked by: none
Context: `THINKING_BUDGET` (`packages/core/src/ai/google.ts:51`) says `gemini-3.8-flash` at low spends nothing on thinking. T11's write-up
states the measured thinking-token count on voice turns.
Files: if zero: none. If not zero and Colin approved a change at T11: packages/core/src/ai/google.ts (edit), packages/core/src/ai/google.test.ts (edit),
packages/core/src/domain/reply.ts (edit)
Steps:
1. If T11 records zero thinking tokens on every voice turn: add one line to `step1-baseline.md`, "Thinking budget: no gain available,
   left unchanged", and change no code.
2. Otherwise, only what Colin approved at T11: a voice-only budget passed from `generateReply` when `memory.channel === 'voice'`, never 0
   (a hard 400 on `gemini-pro-latest`). Tests: SMS and web requests still get today's budget; no request on any effort or model sends 0.
Do not touch: SMS, WhatsApp, email and web budgets; the `THINKING_BUDGET` comment's measurements.
Proof: zero case: `git diff` shows no change to `THINKING_BUDGET`, and the line is in the write-up (before: the line is absent).
Change case: the new tests fail before and pass after; core green with count.

## T23: Leaner voice prompt, gated by the eval
Status: TODO
Spec: must-do 20; Done-means 15, 17; decisions 4, 5
Depends on: T11, T20, T21, T22
Blocked by: none
Context: Average voice prompt is about 3,037 tokens. Aim for about 30% fewer, but the eval rules: no token is cut that costs eval score
(decision 4). Gates: SMS-channel run at least 28/32; `voice-price-is-spoken-not-written` and `voice-never-reads-out-email` pass 3 of 3;
the all-voice run (T20) has no case worse than its before-trim result (decision 5). Voice branch: `memory.channel === 'voice'`
(`spoken` at `receptionist.ts:65`).
Files: packages/core/src/prompts/receptionist.ts (edit), packages/core/src/prompts/receptionist.test.ts (edit if a voice assertion moves),
~/.sam/work/amy-latency/count-voice-prompt.sh (new), ~/.sam/work/amy-latency/count-voice-prompt.ts (new)
Steps:
1. `count-voice-prompt`: loads the eval env file without printing, builds the voice prompt for the VOLTA fixture, and asks Gemini's
   `models.countTokens` for its size. Run it before any change and record the number.
2. Trim only text that is emitted when the channel is voice (voice-only lines, or a voice-specific shorter form of a shared section).
   Keep every fact, rule and safety line the eval checks. Iterate: count, run `run-eval.sh low` and the voice-channel run, keep a cut
   only if no gate drops.
3. Record before and after token counts, the share saved, and all three eval results in `~/.sam/work/amy-latency/prompt-trim.md`.
   If 30% cannot be reached without losing score, stop at the largest cut that keeps every gate and say so.
Do not touch: SMS, WhatsApp, email and web output (T21 snapshot must pass unchanged), eval cases and judges, `THINKING_BUDGET`.
Proof: before, `prompt-trim.md` does not exist and the voice prompt count equals the before figure. After: T21 snapshot passes; core
green with count; `run-eval.sh low` at least 28/32; both voice cases 3/3; the all-voice run has no case worse than before-trim; the
token saving is recorded (about 30% target, the eval having priority).

---

# Whole build

## T24: Full suites, typechecks and commit through the Atwood gate
Status: TODO
Spec: Done-means 18, 21
Depends on: T19 and T23 (or whichever of steps 2 and 3 Colin kept at T11)
Blocked by: none
Context: Nothing is deployed here.
Files: none (git only)
Steps:
1. Core and relay tests; core, relay and web typechecks. Report counts against the baseline (core 232, relay 62) and against T9.
2. `git status`: only intended files; nothing under `supabase/`; `conversation-relay.ts` unchanged (`speechTimeout: 1200`).
3. Commit on `restyle/glassmorphism` through the Atwood gate, on top of `5a95538`, `13da8b4` and T9. Push only if Colin asks.
Do not touch: `main`, any deploy, any env file, the systemd unit.
Proof: before, the step 2/3 work is uncommitted. After: `git log --oneline 13da8b4..HEAD` shows the commits;
`git branch --contains HEAD` lists `restyle/glassmorphism` and not `main`; suites green with counts.

## T25: GATE: deploy steps 2 and 3 to the live relay and measure against the target (Colin's go)
Status: TODO
Spec: Done-means 19, 20; decision 1 (target), decision 9 (after figure); must-do 6, 11, 15 (live)
Depends on: T24, T7, T8
Blocked by: Colin's go to deploy
Context: Live production runs from this checkout. A restart drops a call in progress. Streaming is on by default (T19);
rollback without a code change is a drop-in with `RELAY_STREAM_REPLIES=0` and a restart.
Files: ~/.sam/work/amy-latency/after-evidence.md (new)
Steps:
1. SAM states to Colin: the commits, what changes for callers, the restart, the rollback, the recording. Wait for go.
2. Deploy path: confirm HEAD is T24's commit, run both suites, restart `atwood-relay`, confirm the new PID start time and
   `Relay listening` with `streamReplies: 'on'` and `frameProbe: 'off'`.
3. At least 30 answered turns across at least 5 calls. Run `latency-stats.mjs --since "<restart time>"`: first-frame p50 at most 0.78 s and
   p95 at most 1.46 s over all answered turns, p50 at most 0.83 s over model turns (decision 1). Save output.
4. Decision 9 after figure: record one call with `record-call.mjs`, run `measure-gaps.mjs`, compare with T10's before figure.
5. Done-means 20: Colin rings 07462 187713 and reads the 6-line script from the trial report. He confirms by ear: Amy starts sooner;
   line 3 (barge-in) still stops her quickly; line 5 hands over as before; line 6 gets "anything else?" then a goodbye.
6. If any check fails: SAM offers Colin the rollback drop-in; nothing else is changed without his say.
Do not touch: the env file, TwiML, `speechTimeout`, the Twilio number configuration, the database (reads only), `main`.
Proof: before, `after-evidence.md` does not exist. After: it holds the stats output with PASS on all three target figures (or Colin's
recorded decision on a MISS), before and after true-delay figures, and Colin's four by-ear confirmations.

## T26: GATE: latency alert in receptionist-watch (Colin's go)
Status: TODO
Spec: decision 7; open question 7; Robustness "Monitoring and alerts"
Depends on: T25, T7
Blocked by: Colin's go (it edits a live monitoring script that runs every 5 minutes)
Context: `receptionist-watch` (`~/.local/bin/receptionist-watch.mjs`, run by `receptionist-watch.timer` every 5 minutes) raises nothing on
latency today. It has `record(name, ok, detail)`, `alert(title, body)` through `sam-push`, and a 30-minute re-alert rule (`REALERT_MS`).
Turning it on before step 2 has met the target would alert all day, which is why it comes after T25. Do not read or print its env loading.
Settings from the target: N = the last 20 answered model-generated turns within the last 24 hours (named constant `LATENCY_WINDOW_TURNS`);
alert when their first-frame p50 is above 780 ms (`LATENCY_P50_ALERT_MS`, the target in decision 1); no alert with fewer than 10 such turns.
Files: ~/.local/bin/receptionist-watch.mjs (edit), ~/.sam/work/amy-latency/watch-latency.test.mjs (new)
Steps:
1. SAM asks Colin for go. Before editing, copy the script to `~/.sam/work/amy-latency/receptionist-watch.mjs.bak-<date>`.
2. Add `checkLatency()`: read `journalctl --user -u atwood-relay -o cat --since "24 hours ago"`, apply the same joins and exclusions as
   T7, take the last `LATENCY_WINDOW_TURNS` model turns, compute p50 (nearest rank), and `record('relay latency', ok, detail)` with the p50,
   the count and the threshold. It uses the existing alert and re-alert path; no new channel.
3. A `--latency-file <path>` option reads a journal sample instead, for the test. `watch-latency.test.mjs` runs the script's latency check
   on two fixtures: p50 600 ms (ok) and p50 900 ms (not ok), plus one with 5 turns (no verdict).
4. `node --check` the edited script, run the test, then let one timer run happen and check its journal for the new check's line.
Do not touch: the other checks, the probe, `REALERT_MS`, the env file, the timer's schedule.
Proof: before, the 900 ms fixture raises nothing (no latency check exists). After: the test shows ok for 600 ms, not ok for 900 ms,
no verdict for 5 turns; the next `receptionist-watch.service` run logs the latency check without error.

---

## Coverage

| Spec item | Ticket(s) |
|---|---|
| Must do 1: timings line per voice turn, all stages and tokens, turn kind | T4 (T2 supplies first/last token and tokens) |
| Must do 2: first-frame event with time since `prompt_final` | T5, T17 (streamed first frame) |
| Must do 3: no caller words, reply text or phone numbers in the line | T4 |
| Must do 4: internal streaming, same whole reply and `ai_logs` | T2 |
| Must do 5: fresh baseline, 30 turns / 5 calls, per-stage table, Colin decides | T7, T10, T11 |
| Must do 6: only ordinary turns stream | T15, T17, T25 |
| Must do 7: first sentence sent as `last: false` as soon as produced | T12, T14, T17 |
| Must do 8: `last: true` frame always has text; no empty token | T12, T17 |
| Must do 9: same cleaning per frame; spaces kept | T12, T14, T17 |
| Must do 10: same words as `limitForSpeech(cleanModelReply(full))`, 400 cap | T12, T14 |
| Must do 11: streamed turn never ends call; wrap-up and backstop after `last: true` | T15, T17, T25 |
| Must do 12: failure after partial speech closes with today's line, then `end` | T14, T15 |
| Must do 13: retry only if nothing sent | T13, T15 |
| Must do 14: stall setting, named, 3 s | T13, T15 |
| Must do 15: barge-in stops frames and Gemini; take-back against all sent | T18, T16 (interrupt mark waits for row), T25 |
| Must do 16: transcript holds full text sent; interrupted holds text to that point | T15 |
| Must do 17: next turn's memory load waits for transcript row | T16 |
| Must do 18: one setting turns streaming off; default on | T19 |
| Must do 19: thinking budget only if step 1 shows thinking tokens | T11, T22 |
| Must do 20: leaner voice prompt, eval lines kept | T23 |
| Must do 21: other channels' prompts byte for byte the same | T21, T23 |
| Done-means 1 | T4 (T1 seams) |
| Done-means 2 | T5 |
| Done-means 3 | T2 |
| Done-means 4 | T7 (script), T10 (live run), T11 (write-up to Colin) |
| Done-means 5 | T15 (core), T17 (relay) |
| Done-means 6 | T17 |
| Done-means 7 | T12 (pieces), T17 (frames) |
| Done-means 8 | T12, T14 |
| Done-means 9 | T17 |
| Done-means 10 | T13 (retry, stall), T15 (lines, handover, `end`), T17 (relay sends closing frame then `end`) |
| Done-means 11 | T18 |
| Done-means 12 | T15 (transcript), T16 (ordering) |
| Done-means 13 | T19, T17 (existing tests unchanged with streaming off) |
| Done-means 14 | T11 (count stated), T22 |
| Done-means 15 | T23 |
| Done-means 16 | T21 |
| Done-means 17 | T20 (runner, before figures), T23 (gate) |
| Done-means 18 | T9 (step 1), T24 |
| Done-means 19 | T7 (script), T25 |
| Done-means 20 | T25 |
| Done-means 21 | T9, T24 |
| Decision 1: target (a), p50 0.78 s / p95 1.46 s | T7 (PASS/MISS), T11, T25 |
| Decision 2: prove first `last: false` is spoken, in step 1 | T6 (probe), T10 (call), T11 (to Colin) |
| Decision 3: prove frames after `interrupt`, in step 1 | T6, T10, T11; T18 blocked on the result |
| Decision 4: about 30% fewer prompt tokens, eval rules | T23 |
| Decision 5: all 32 cases on voice before and after; none worse; at least 28/32 | T20, T23 |
| Decision 6: stall 3 s | T13 |
| Decision 7: receptionist-watch latency alert, N and threshold from the target | T26 |
| Decision 8: final stream chunk carries finishReason and usage; stop if not | T2 (fixtures), T3 (live API), T10 (live `ai_logs`), T11 |
| Decision 9: true caller-perceived delay before and after | T8 (tools), T10 (before), T25 (after) |
| Decisions closing paragraph: stage timings to Colin before step 2; levers may shift | T11 |
| Robustness: rollback setting | T19, T25 |
| Robustness: stall timeout, retry once, abort on barge-in | T13, T18 |
| Robustness: fallback lines logged at warn or error with reason | T15 |
| Robustness: alert | T26 |
| Step 1 build report point 4 (2026-10-17): callSid on every relay event, session_end on hang-up | T9b |
| Step 1 review findings 1 and 4 (2026-10-17): no-finish-reason stream guard; unattributable column | T9b |

No spec open question is still OPEN: all nine are answered in "Decisions at lock". The live answers to decisions 2, 3 and 8 come from
T10 and gate step 2 through T11.
