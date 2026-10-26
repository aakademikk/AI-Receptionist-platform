# Voice end-of-call build report, 2026-10-25

Branch `cloud/voice-end-of-call`, cut from `origin/restyle/glassmorphism` at `7ccb1b0`.
Push proven first (commit `b669d5d`, the opening line of this file).

## Baseline (branch as found, `7ccb1b0`, Node v22.22.0; no `~/.local/node/bin` in this container)

| Suite | Result |
|---|---|
| `pnpm --filter @atwood/core test` | 279 tests, 279 pass, 0 fail |
| `pnpm --filter @atwood/core typecheck` | exit 0, clean |
| `pnpm --filter @atwood/relay test` | 86 tests, 86 pass, 0 fail |
| `pnpm --filter @atwood/relay typecheck` | exit 0, clean |

The ticket file's "core 191 / relay 44" is stale, as expected.

## Headline: T1 to T5 were already built. Nothing was rebuilt.

The ticket file says `Status: TODO` for every ticket, but the code is already on `restyle/glassmorphism`.
It was built in a cloud session on 2026-09-24, one commit per ticket, and Colin made three follow-up fixes on 2026-09-25:

| Commit | Date | Author | Subject |
|---|---|---|---|
| `e4e3c92` | 2026-09-24 | Claude | Tag voice conversations, and so their leads, as voice_call (T1) |
| `e912cc4` | 2026-09-24 | Claude | Pure closing-phrase rules and closing lines (T2) |
| `56d6c40` | 2026-09-24 | Claude | Voice turns use the closing rules (T3) |
| `3717774` | 2026-09-24 | Claude | Relay remembers that "anything else?" was asked (T4) |
| `cabac33` | 2026-09-24 | Claude | Silence backstop in the relay (T5) |
| `bd1796f` | 2026-09-25 | Colin Wood | A bare "no" ends the call only as the answer to "anything else?" |
| `b520639` | 2026-09-25 | Colin Wood | A handover mutes the call it happened on, not the caller's next call |
| `a157b0b` | 2026-09-25 | Colin Wood | A reply the caller talked over asked nothing, and the transcript says so |

`git branch -r --contains cabac33` and `--contains a157b0b` both list `origin/restyle/glassmorphism`
(plus `origin/claude/voice-end-of-call-0sup41`, which looks like the original session's branch). The only thing never done was updating the `Status:` lines.

This is a conflict between the tickets ("new file", "edit") and the code I found. Per the session rules I did not guess or rebuild.
Writing the files again would have overwritten Colin's 09-25 fixes or duplicated them.
Instead, for each ticket I checked its steps and its proof against the current code and re-ran the proof.
**No source file was changed in this session.** The only changes are this report and the six `Status:` lines in
`implementation/voice-end-of-call-tickets.md`. Each Status line names the original commit and says it was re-verified, not built, today.
If SAM would rather the Status lines stayed TODO until T7, restoring those six lines (`git checkout 7ccb1b0 -- implementation/voice-end-of-call-tickets.md`) is safe.

Test counts before and after are the same for every ticket below (core 279/279, relay 86/86, both typechecks clean),
because no code changed.

---

## T1: Voice conversations get source `voice_call`: DONE (built `e4e3c92`, re-verified)

What changed (in `e4e3c92`):
- `packages/core/src/domain/source.ts` (new, 23 lines): `sourceForChannel(channel)` maps `whatsapp`→`'whatsapp'`, `voice`→`'voice_call'`, default→`'inbound_sms'`.
- `packages/core/src/domain/pipeline.ts`: import at line 16, and the `resolve_inbound` call now passes `p_source: sourceForChannel(channel)` (line 269).
- `packages/core/src/domain/source.test.ts` (new): three assertions, one per channel.
- No file under `supabase/` was touched by any of the eight commits (`git diff --stat e4e3c92~1 a157b0b -- supabase/` is empty). `record_missed_call` and `missed_call` are unchanged.

Raw proof:
```
▶ sourceForChannel
  ✔ tags a voice conversation as a voice call
  ✔ keeps SMS as inbound_sms
  ✔ keeps WhatsApp as whatsapp
✔ sourceForChannel
```
Before / after: core 279 / 279, typecheck clean / clean.

## T2: Pure closing-phrase rules and closing lines: DONE (built `e912cc4`, re-verified)

What changed (in `e912cc4`, refined by `bd1796f` and `b520639`):
- `packages/core/src/domain/closing.ts` (new): `ANYTHING_ELSE_LINE`, `GOODBYE_LINE`, `STILL_THERE_LINE` (lines 31–37);
  `isCallerClosing` (174) only matches when the utterance is made up entirely of closing words and filler, and never when it contains `?`;
  `isDecliningMore` (188); `decideCallerClosing` (211); `isWrapUpLine` (268), which is false when the line ends in `?`.
- `packages/core/src/domain/closing.test.ts` (new); `index.ts` exports the module.
- **Drift from the ticket text (deliberate, Colin `bd1796f`):** `decideCallerClosing` takes a third input, `anythingElseJustAsked`.
  A bare "no" means `goodbye` only on the turn straight after "anything else?". Later in the call it is an ordinary turn,
  because it answers whatever Amy asked last. A real goodbye later in the call still gets `goodbye`, and never a second ask.
  `b520639` also added `PASSED_ON_LINE`, `PASSED_ON_GOODBYE_LINE` and `decideMutedTurn` for turns after a handover.
- `handover.ts` was not touched by T2. `b520639` later edited it for the mute scope; that is outside these tickets.

Raw proof:
```
▶ isCallerClosing
  ✔ matches goodbye-type utterances
  ✔ does not match when the utterance also carries a request or a question
  ✔ does not treat an acknowledgement on its own as a goodbye
▶ isDecliningMore
  ✔ matches a no to "anything else?"
  ✔ does not match "no, but..." or anything with a question
▶ decideCallerClosing
  ✔ asks "anything else?" when the caller first says goodbye (check 1)
  ✔ says goodbye when the caller answers "no thanks" after the ask (check 2)
  ✔ says goodbye, never a second ask, on a second "bye" (check 2)
  ✔ carries on normally when the caller raises something new after the ask (check 2)
  ✔ treats a later bare "no" as an answer to her last question, not to "anything else?"
  ✔ says goodbye, never a second ask, on a real goodbye later in the call
  ✔ is an ordinary turn when nobody is closing
▶ isWrapUpLine
  ✔ matches the assistant signing off
  ✔ does not match a sign-off that ends in a question
  ✔ does not match an ordinary reply
```
Before / after: core 279 / 279, typecheck clean / clean.

## T3: Voice turns use the closing rules: DONE (built `56d6c40`, re-verified)

What changed (in `56d6c40`, refined by `bd1796f`, `b520639`, `a157b0b`):
- `pipeline.ts`: `HandleInboundMessageInput.cannedReply?: string` (line 196). When it is set, it is used as the reply body and the model is skipped (lines 566–567). Record, idempotency and escalation run first, unchanged.
- `voice.ts`: `VoiceTurnInput.anythingElseAsked?` (80), and `anythingElseJustAsked?` (85, added by `bd1796f`). `VoiceTurnResult.closing` (116).
  `answerCaller` calls `decideCallerClosing` before the pipeline (165–175) and passes `cannedReply`.
  When no handover happened: goodbye → `endCall: true, closing: 'none'` (308–310); ask → `endCall: false, closing: 'asked_anything_else'` (312–313);
  otherwise `closing` comes from `isWrapUpLine` (315–320). The handover branch keeps `endCall: base.handover !== null && !result.capturePending` (340),
  so `endCall` is never true while `capturePending` is true. The error and duplicate branches return `closing: 'none'`.
- **Drift (deliberate, Colin `b520639`):** the muted branch now uses `decideMutedTurn`. The first answer after a handover gets
  `PASSED_ON_LINE` with `closing: 'asked_anything_else'`, which arms the backstop. The next answer gets `PASSED_ON_GOODBYE_LINE` with `endCall: true`.
  The ticket said muted → `closing: 'none'`. The spec's must-do 6 ("detail capture after a handover: line stays open for the answer, closes the turn after") matches the newer behaviour.
- `apps/relay/src/protocol.ts`: optional `anythingElseAsked?` / `anythingElseJustAsked?` on `RelayReplyRequest` (114–116), and `closing?` on `RelayReply` (135).
- `voice.ts` **is** unit-testable without a database: `voice.test.ts` uses a fake database and a fake model, including "marks a canned goodbye as canned, with no Gemini stages".

Raw proof: full suites below, all green. Existing handover and capture tests pass (`handover.test.ts`, `voice.test.ts`: 0 fail).
Before / after: core 279 / 279, relay 86 / 86, both typechecks clean / clean.

## T4: The relay remembers "anything else?" was asked: DONE (built `3717774`, re-verified)

What changed: `RelaySession` has private `anythingElseAsked` (`protocol.ts:330`) and `anythingElseJustAsked` (335, `bd1796f`). Both are sent on every request (593–594),
and set only after a reply passes the stale-turn check (605–608). `a157b0b` added a rollback (746–757): if the caller spoke over the question before hearing it, it is taken back.
Tests are in `protocol.test.ts`.

Raw proof:
```
▶ remembering "anything else?"
  ✔ is false on the first turn
  ✔ is true on the turn after the question was asked, and stays true
  ✔ marks "just asked" only on the turn straight after the ask, so a later "no" is just a no
  ✔ stays false when the asking reply was interrupted, because the caller never heard it
  ✔ takes the question back when the caller spoke over it before hearing it (live 2026-09-25)
  ✔ keeps the question when the caller only spoke over it after hearing it out
  ✔ reports a cut-off ordinary reply with what was heard, and changes no closing state
  ✔ stays false when the asking reply was superseded by a newer turn
```
Before / after: relay 86 / 86, typecheck clean / clean.

## T5: Silence backstop in the relay: DONE for checks 3–6 in code (built `cabac33`, re-verified); the live timing is owed to T7

What changed: `protocol.ts` exports `SPEECH_CHARS_PER_SECOND = 15` (154), `SILENCE_PROMPT_MS = 3000` (157), `SILENCE_HANGUP_MS = 3000` (160) and `estimatedSpeechMs` (163).
The backstop is armed only by `closing` of `asked_anything_else` or `wrapped_up` with `endCall: false` (`ARMS_SILENCE_BACKSTOP`, 220; 641).
`send?` / `stillThereLine?` options (247, 253): the backstop is off unless both are given. `dispose()` is at 396.
Timers send the still-there line and log `silence_prompt` (725–731), then end the call with `session_end` reason `silence` (735–739).
`server.ts` passes `send` and `STILL_THERE_LINE` from `@atwood/core/domain` (lines 3, 143–144) and calls `session.dispose()` on close (191).
The open question is answered in the ticket file: ConversationRelay has no playback-finished event, so the countdown starts from an estimate of when her audio ends. The rate used is **15 characters per second**.

Raw proof (fake clock, `t.mock.timers`):
```
▶ silence backstop
  ✔ asks "are you still there?" after a sign-off and 3 s of silence (check 3)
  ✔ is armed by "anything else?" too
  ✔ ends the call after 3 s more of silence (check 4)
  ✔ never runs after an ordinary turn, however long the caller pauses (check 5)
  ✔ is cancelled by partial speech inside the first window (check 6)
  ✔ is cancelled by partial speech inside the second window (check 6)
  ✔ is cancelled by a barge-in and by a keypress
  ✔ schedules nothing when the reply already ends the call
  ✔ fires nothing after dispose()
  ✔ stays off when no send function or still-there line was given
```
All five required cases (a–e) are present, plus three extra.
Before / after: relay 86 / 86, core 279 / 279, typechecks clean / clean.

## T6: Full verification and push: DONE (re-verified; pushed to `cloud/voice-end-of-call` per this session's rules)

- Step 1, raw output of the final run on this branch:
```
=== @atwood/core test (exit 0)
# tests 279
# suites 53
# pass 279
# fail 0
# cancelled 0
# skipped 0
# todo 0
=== @atwood/core typecheck (exit 0)
=== @atwood/relay test (exit 0)
# tests 86
# suites 14
# pass 86
# fail 0
# cancelled 0
# skipped 0
# todo 0
=== @atwood/relay typecheck (exit 0)
```
- Step 2: `git status` was clean before the docs commit. No change under `supabase/migrations/` or `supabase/tests/` from this work or this session.
- Step 3: **The instruction conflicts with this session's rules.** The ticket says push to `restyle/glassmorphism`; this session pushes only to `cloud/voice-end-of-call`.
  The T1–T5 code commits are already on `origin/restyle/glassmorphism`, positions 21–25 in `git log origin/restyle/glassmorphism`.
  Because later commits sit on top, the ticket's literal proof (`git log origin/restyle/glassmorphism -3`) no longer shows them.
- Step 4: the commit hashes, counts and speech rate (15 chars/s) are above.

T7 was not started.

---

## For SAM to check

None of these can be proven in the cloud container:

1. **Spec check 10, live silence close:** "wrong number", then silence, then `silence_prompt`, then `session_end` reason `silence` in `journalctl --user -u atwood-relay`. This needs Twilio and the live relay. Owed to T7.
2. **Spec check 11, live goodbye flow:** "that's all, bye", then "anything else?", then "no", then the goodbye line, then `session_end` reason `domain`. Owed to T7.
3. **Spec check 12:** the newest voice row in `public.leads` reads `voice_call`. T1 is only unit-proven: the mapping and the `p_source` argument. The SQL path, where `upsert_lead` copies `conversations.source`, was not exercised here (no database).
   Note: `resolve_inbound` sets the source only when it opens a conversation, so a caller whose existing thread was opened by SMS will keep `inbound_sms`.
4. **`SPEECH_CHARS_PER_SECOND = 15` is an estimate that has not been tuned.** Whether "are you still there?" cuts across Amy's own line can only be heard on a real call.
5. **Whether the relay running on the box has this code.** It was built 09-24 and 09-25. Whether `atwood-relay` was restarted after those commits, and whether checks 10–12 were already proven live, is not recorded in the repo. If they were, T7 may only need its daily-note evidence found.
6. **Colin's three 09-25 commits changed behaviour beyond the ticket text:** the bare-"no" rule, the muted-turn lines that arm the backstop, and the question taken back when spoken over. The spec still reads LOCKED 2026-09-24 and doesn't mention them. SAM may want the spec or tickets annotated.
7. **The `Status:` lines I set** credit the 09-24 commits and today's re-run, not a new build. Restore them with `git checkout 7ccb1b0 -- implementation/voice-end-of-call-tickets.md` if they should stay TODO until T7.
