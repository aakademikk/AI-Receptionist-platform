# Tickets: voice end-of-call and lead source

Spec: [voice-end-of-call-spec.md](voice-end-of-call-spec.md) (LOCKED 2026-09-24).
Branch: `restyle/glassmorphism`. Never `main`. Build in order; each ticket leaves both suites green.

## The spec's open question, answered before ticketing

Q: can the relay tell when Amy has finished speaking?
A: No. Twilio's ConversationRelay WebSocket messages doc (checked 2026-09-24) lists five inbound
types (setup, prompt, dtmf, interrupt, error) and no playback-finished event.
So the relay estimates when her audio ends from the length of what it sent, then starts the 3 s.
The rate is a named constant, tuned on the live call (spec check 10). T5 carries this.

## How to run the tests (every ticket)

- Node 22+ with type stripping. On Colin's box put `~/.local/node/bin` first on PATH
  (system Node fails with `ERR_NO_TYPESCRIPT`).
- Core: `pnpm --filter @atwood/core test` and `pnpm --filter @atwood/core typecheck`.
- Relay: `pnpm --filter @atwood/relay test` and `pnpm --filter @atwood/relay typecheck`.
- Baseline before T1: core 191/191, relay 44/44, both typechecks clean. Report counts after every ticket.

---

## T1: Voice conversations get source `voice_call`
Status: TODO
Spec: must-do 7, 8; check 8
Depends on: none
Blocked by: none
Context: `leads.source` is copied from `conversations.source` inside `upsert_lead`
(`supabase/migrations/0009_rpc_functions.sql`, the `insert into public.leads`). The conversation's
source is `p_source`, passed by `handleInboundMessage` when it calls `resolve_inbound`.
Today that is `'inbound_sms'` for every channel except WhatsApp, so voice calls read `inbound_sms`.
`source` is free text, no enum or check constraint, so no migration is needed.
Files: packages/core/src/domain/pipeline.ts (edit), packages/core/src/domain/source.ts (new),
packages/core/src/domain/source.test.ts (new)
Steps:
1. New `source.ts` exporting `sourceForChannel(channel: CommsChannel): string`:
   `whatsapp` -> `'whatsapp'`, `voice` -> `'voice_call'`, everything else -> `'inbound_sms'`.
2. In `pipeline.ts`, the `resolve_inbound` call (`p_source: channel === 'whatsapp' ? ...`) uses `sourceForChannel(channel)`.
3. Tests: voice gives `voice_call`, sms gives `inbound_sms`, whatsapp gives `whatsapp`.
Do not touch: any SQL migration, `record_missed_call` and its `'missed_call'` source, existing lead rows (no backfill),
`supabase/tests/functional.sql`.
Proof: core test and typecheck green, count = baseline + the new tests; the three new assertions pass.

## T2: Pure closing-phrase rules and closing lines
Status: TODO
Spec: must-do 1, 2, 3; checks 1, 2
Depends on: none
Blocked by: none
Context: Colin chose code-side detection of what the CALLER says (not a model signal).
Everything here is pure (no database, no model) so it is unit-testable; T3 wires it in.
Rules: caller says goodbye -> ask "anything else?" once per call; after that, a "no" or another goodbye
-> one short goodbye and hang up; anything else -> normal conversation.
Separately, recognise when Amy's OWN reply is a wrap-up line, which arms the silence backstop in T5.
A false positive on Amy's wrap-up only costs one "are you still there?", so err towards arming.
A false positive on the caller's goodbye costs a spurious "anything else?", so err towards NOT matching.
Files: packages/core/src/domain/closing.ts (new), packages/core/src/domain/closing.test.ts (new),
packages/core/src/domain/index.ts (edit, export the new module the way the others are exported)
Steps:
1. Constants, UK English, written for speech: `ANYTHING_ELSE_LINE` ("Is there anything else I can help you with?"),
   `GOODBYE_LINE` (short, e.g. "No problem. Thanks for calling, bye for now."),
   `STILL_THERE_LINE` ("Are you still there?").
2. `isCallerClosing(heard)`: true for goodbye-type utterances ("bye", "goodbye", "cheers, bye", "that's all",
   "that's everything", "no thanks, bye", "thanks, that's it"). False when the utterance also carries a request or
   question ("bye, actually can you ...", "what time do you close, bye" etc.): a question mark or a request verb after the phrase wins.
3. `isDecliningMore(heard)`: true for "no", "no thanks", "nope", "that's it", "that's all", "no that's everything", and any `isCallerClosing` match.
   False for "no, but ..." or anything with a question.
4. `decideCallerClosing({ heard, anythingElseAsked })` returning `'ask_anything_else' | 'goodbye' | 'none'`:
   not yet asked + closing -> `ask_anything_else`; already asked + declining -> `goodbye`;
   already asked + caller closing -> `goodbye` (never a second ask); otherwise `none`.
5. `isWrapUpLine(speak)`: true when Amy's reply signs off ("have a good evening", "have a great day", "bye for now",
   "take care", "thanks for calling") AND does not end in a question. "Have a good evening, what's the address?" is false.
6. Tests for every rule above, including each false case named here.
Do not touch: `handover.ts` and its patterns (the 09-17 buying-signal fix, commit `404a834`), the receptionist prompt.
Proof: core test and typecheck green; closing tests cover: caller goodbye -> ask (check 1),
after ask "no thanks" -> goodbye, after ask second "bye" -> goodbye not ask, after ask a new question -> none (check 2),
the wrap-up true and false cases.

## T3: Voice turns use the closing rules
Status: TODO
Spec: must-do 1, 2, 3, 6; checks 1, 2, 7
Depends on: T2
Blocked by: none
Context: `replyToCaller` in `voice.ts` is the only seam between relay and domain. It calls `handleInboundMessage`
with `channel: 'voice'`, which records the caller's turn, runs the escalation (handover) check, then generates a reply.
The closing lines must be spoken WITHOUT a model call (the caller is waiting), but the caller's turn must still be
recorded and the handover check must still run first: a handover always wins over a closing line.
`endCall` must never be true while `capturePending` is true (see the `capturePending` comment in `pipeline.ts`).
The relay tells the domain whether "anything else?" has been asked on this call; the domain tells the relay what
kind of turn it just produced. The relay's copy of these shapes (`RelayReplyRequest`, `RelayReply` in
`apps/relay/src/protocol.ts`) is checked against core's by typecheck, so add new fields as OPTIONAL in T3
and let T4 use them.
Files: packages/core/src/domain/pipeline.ts (edit), packages/core/src/domain/voice.ts (edit),
apps/relay/src/protocol.ts (edit: optional fields on `RelayReplyRequest` and `RelayReply` only)
Steps:
1. `HandleInboundMessageInput` gets optional `cannedReply?: string`. In step 4 ("Generate the reply"), when it is set,
   use it as the reply body instead of calling `generateReply`, and skip the model entirely.
   Everything before step 4 (record, idempotency, escalation) runs unchanged. The reply is still an `ai` sender reply,
   so `recordAssistantTurn` writes it to the transcript as today.
2. `VoiceTurnInput` gets optional `anythingElseAsked?: boolean`.
   `VoiceTurnResult` gets `closing: 'asked_anything_else' | 'wrapped_up' | 'none'`.
3. In `replyToCaller`: call `decideCallerClosing` on `heard` first. `ask_anything_else` -> pass `cannedReply: ANYTHING_ELSE_LINE`;
   `goodbye` -> pass `cannedReply: GOODBYE_LINE`.
4. After the pipeline returns: if a handover happened, today's logic decides `endCall` exactly as now and `closing` is `'none'`.
   Otherwise: goodbye -> `endCall: true`, `closing: 'none'`; anything-else -> `endCall: false`, `closing: 'asked_anything_else'`;
   a normal reply that `isWrapUpLine` -> `closing: 'wrapped_up'`, `endCall: false`; else `closing: 'none'`.
   The error, duplicate and muted branches return `closing: 'none'`.
5. In `protocol.ts` add `anythingElseAsked?: boolean` to `RelayReplyRequest` and
   `closing?: 'asked_anything_else' | 'wrapped_up' | 'none'` to `RelayReply`. No behaviour change in the relay yet.
Do not touch: `handover.ts`, the handover and capture branches' existing `endCall` rule, SMS/WhatsApp behaviour
(`cannedReply` is only ever set by `voice.ts`), the receptionist prompt.
Proof: core and relay tests and both typechecks green, counts reported; existing handover and capture tests pass unchanged (check 7).
If `voice.ts` logic cannot be unit-tested without a database, say so in the report; the decision logic itself is proven by T2.

## T4: The relay remembers "anything else?" was asked
Status: TODO
Spec: must-do 2; check 2
Depends on: T3
Blocked by: none
Context: `RelaySession` in `apps/relay/src/protocol.ts` holds one call's state. It must pass `anythingElseAsked` on every
reply request and set it once a reply comes back with `closing: 'asked_anything_else'`. It never resets within a call
(at most once per call). The relay holds state only; it never decides wording.
Files: apps/relay/src/protocol.ts (edit), apps/relay/src/protocol.test.ts (edit)
Steps:
1. Private `anythingElseAsked = false` on `RelaySession`; include it in the request built in `handlePrompt`.
2. After a reply that is still worth speaking (after the `pendingTurn` check), set it when `reply.closing === 'asked_anything_else'`.
   A superseded or interrupted reply does not set it (the caller never heard the question).
3. Tests with `recordingReply` / `deferredReply`: false on turn 1; true on the turn after an asked reply; stays true;
   stays false when the asking reply was interrupted.
Do not touch: barge-in and `pendingTurn` logic, `maxTurns`, `parseFrame`, `sanitiseForSpeech`.
Proof: relay test and typecheck green, count = previous + new tests.

## T5: Silence backstop in the relay
Status: TODO
Spec: must-do 3, 4, 5; checks 3, 4, 5, 6
Depends on: T4
Blocked by: none (open question answered above: no playback-finished event, estimate it)
Context: The backstop is armed ONLY after a spoken reply with `closing` of `'asked_anything_else'` or `'wrapped_up'`
and `endCall: false`. Never after an ordinary turn: a caller may pause as long as they like mid-call (Colin, 2026-09-24).
Twilio sends no event when TTS playback ends, so the countdown starts at send time plus an estimate of how long the
line takes to say: `estimatedSpeechMs(token) = token.length / SPEECH_CHARS_PER_SECOND * 1000`, with
`SPEECH_CHARS_PER_SECOND = 15` as a named, exported constant. Then `SILENCE_PROMPT_MS = 3000` -> send `STILL_THERE_LINE`;
then its own estimated duration plus `SILENCE_HANGUP_MS = 3000` -> send `end`. Both timings are named exported constants.
Any inbound `prompt` (partial `last: false` included), `interrupt` or `dtmf` frame cancels the countdown and disarms it.
Frames produced by a timer have no `handle()` call to return from, so the session needs a way to send unsolicited frames.
The relay holds no copy: the still-there line is injected by `server.ts` from core's `STILL_THERE_LINE`.
Files: apps/relay/src/protocol.ts (edit), apps/relay/src/server.ts (edit), apps/relay/src/protocol.test.ts (edit)
Steps:
1. `RelaySessionOptions` gets `send?: (frames: OutboundFrame[]) => void` and `stillThereLine?: string`
   (backstop disabled when either is missing, so existing tests are unaffected).
2. After returning a spoken reply that arms the backstop, schedule the first timer as above. When it fires and the session is
   not ended: send `{ type: 'text', token: stillThereLine, last: true }` via `send`, log `silence_prompt`, schedule the second timer.
   When that fires: set ended, send `{ type: 'end' }`, log `session_end` with `reason: 'silence'`.
3. Cancel on any inbound prompt/interrupt/dtmf and when the session ends for any reason. Add `dispose()` that clears timers.
4. `server.ts`: pass `send` (the existing function) and `stillThereLine: STILL_THERE_LINE` from `@atwood/core`;
   call `session.dispose()` in the socket `close` handler.
5. Tests using `mock.timers` from `node:test` (fake clock, no real waiting):
   a. armed reply, no frames for estimate + 3 s -> one text frame with the still-there line (check 3);
   b. then 3 s + its estimate more -> an `end` frame, `session_end` reason `silence` (check 4);
   c. ordinary reply (`closing: 'none'`), advance 10 s -> nothing sent, call not ended (check 5);
   d. a `last: false` prompt inside the first window, and separately inside the second -> nothing sent (check 6);
   e. `endCall: true` reply -> no timer scheduled; `dispose()` -> nothing fires afterwards.
Do not touch: the greeting/TwiML, the barge-in logic, `maxTurns`, how `handle()` returns frames for normal turns.
Proof: relay test and typecheck green with the five new cases; core suite still green.

## T6: Full verification and push
Status: TODO
Spec: must-do 6; checks 7, 9
Depends on: T1 to T5
Blocked by: none
Context: The cloud session's last job. Nothing is deployed from here.
Files: none (git only)
Steps:
1. Run core and relay tests plus both typechecks. Report exact counts against the baseline (core 191, relay 44).
2. `git status` clean apart from the intended files; no change under `supabase/migrations/` or `supabase/tests/`.
3. Commit (one or more commits) and push to `restyle/glassmorphism`. Never `main`, never force-push.
4. Report: commit hashes, counts, the speech-rate estimate used, anything that could not be proven.
Do not touch: `main`, any deploy, any env file.
Proof: `git log origin/restyle/glassmorphism -3` shows the commits; suites green with counts.

## T7: Live proof on the box (SAM and Colin, not the cloud)
Status: TODO
Spec: must-do 3, 4, 1, 2, 7; checks 10, 11, 12
Depends on: T6
Blocked by: none
Context: Only a real call proves it. `atwood-relay` loads modules once: restart it after pulling, or the call runs old code.
Build and restart are a change to a running system, so SAM states them to Colin and waits for his go.
Files: none
Steps:
1. Pull `restyle/glassmorphism` in `/home/col/receptionist-platform`, run both suites locally, restart `atwood-relay`,
   confirm the new PID's start time is after the pull.
2. Colin rings, says "wrong number", goes quiet. Expect "are you still there?" then the line closes on its own.
   `journalctl --user -u atwood-relay` shows `silence_prompt` and `session_end` reason `silence` (check 10).
   If the still-there line cuts across Amy's goodbye, raise `SPEECH_CHARS_PER_SECOND`'s estimate (lower the rate) and repeat.
3. Colin rings, says "that's all, bye", then "no". Expect "anything else?", then the goodbye line, then `session_end`
   reason `domain` (check 11).
4. Newest voice row in `public.leads` reads `voice_call` (check 12).
Do not touch: `main`, the Twilio configuration, existing lead rows.
Proof: the log lines and the query result above, pasted into the daily note.

---

## Coverage

| Spec check | Ticket(s) |
|---|---|
| 1 caller goodbye -> clarifying question | T2, T3 |
| 2 after the question: no -> goodbye + end; new question -> carry on | T2, T3, T4 |
| 3 armed, 3 s silence -> still-there | T5 |
| 4 then 3 s -> end | T5 |
| 5 ordinary turn, 10 s silence -> nothing | T5 |
| 6 partial speech cancels the countdown | T5 |
| 7 full suites green, handover/capture unchanged | T3, T6 |
| 8 voice lead `voice_call`, SMS unchanged | T1 |
| 9 committed and pushed to the branch, not `main` | T6 |
| 10 live: wrong number, line closes itself | T7 |
| 11 live: "that's all, bye" then "no" | T7 |
| 12 live: newest voice lead `voice_call` | T7 |
