Status: LOCKED 2026-10-17 11:48 (Colin: "yes except 6. cut that to 3seconds"). Decisions at lock: see "Decisions at lock" below; they override the matching OPEN lines.

# Voice agent: halve Amy's reply delay on our own stack

Branch: `restyle/glassmorphism`, built on top of the two unpushed local commits
(`5a95538` relay loopback bind, `13da8b4` supabase-start guard).
Grilled 2026-10-16 08:40 (Colin's answers in the vault daily note
`01 - Daily Notes/10 - October 2026/2026-10-16.md`, 8:40 AM line):
1 yes (stage timing first), 2 option A (stream ordinary turns only),
3 yes (trim the voice prompt only, eval gate 28/32), 4 leave `speechTimeout` at 1200.

## Goal

A caller who stops talking hears Amy start her answer much sooner.
Voice channel only. Same voice, same turn-taking, same words; less waiting.

## Baseline and the target (read this first)

What we have measured, and what we have only estimated:

- Relay-side delay, measured. Source: `/home/col/.sam/work/receptionist-eleven-trial/report.md`.
  Time from the relay logging `prompt_final` to it logging `turn_answered`
  (the single `text` frame, `last: true`, sent at `apps/relay/src/protocol.ts:452`).
  43 real turns, 16 to 25 Sep 2026: p50 1.56 s, p95 2.92 s.
  7 of the 43 were canned closing lines under 0.2 s; without them p50 is about 1.65 s.
- Model time, measured (read-only select on `ai_logs`, 2026-10-16). Voice `reply` rows, all
  `google / gemini-3.8-flash / low`: 46 replies, p50 1.59 s, p95 4.88 s; the 6 since 26 Sep have p50 1.67 s.
  Average 3,037 prompt tokens and 39 completion tokens, thinking tokens included.
  So the Gemini call is nearly all of the relay-side delay, and voice replies already spend
  almost nothing on thinking.
- Before the relay-side delay: the fixed 1.2 s `speechTimeout`. After it: TTS start, estimated
  at 0.3 to 0.5 s, never measured. Caller-perceived p50 is therefore estimated at
  1.2 + 1.56 + 0.3 to 0.5 = about 3.1 to 3.3 s. Colin hears about 2 s, so some of the 1.2 s may overlap
  Deepgram's own endpointing. Nobody has measured it.

The arithmetic that matters:

- Half of a 3.1 to 3.3 s caller-perceived delay is 1.55 to 1.65 s. The 1.2 s speech wait stays (decided),
  which leaves 0.35 to 0.45 s for the model call and TTS start together. TTS start alone is estimated
  at 0.3 s or more, and the model call is 1.6 s today. Halving the full caller-perceived delay is
  not reachable while `speechTimeout` stays at 1200. This is open question 1.
- The target this spec is written against, until Colin answers question 1, is halving the part we
  control and can measure:
  relay-side delay = time from the relay's `prompt_final` log line for a turn to the first `text`
  frame it sends for that turn.
  Target: p50 at most 0.78 s and p95 at most 1.46 s across all answered turns, and p50 at most 0.83 s
  across model-generated turns only (half of the 1.65 s figure that leaves canned lines out).
  If that is hit, the caller-perceived p50 falls by about 0.8 s: roughly a quarter, not a half.
- Even this target depends on Gemini's time to first token, which nobody has measured yet. Streaming
  saves the time Gemini spends writing after the first sentence. It does not save the time before
  the first token. With replies of about 39 tokens, most of the 1.6 s may be time to first token.
  Step 1 measures that, and its numbers decide what happens next (see "How step 1 decides" below).

## Must do

Step 1: stage timing (logged only, no behaviour change)

1. Every voice turn writes one timings log line to the relay journal, keyed by `callSid` and turn number.
   It holds milliseconds for each stage of the turn: `resolve_inbound`, the inbound `append_message`,
   context and memory load, the confusion-count update and the callback lookup (when they run),
   prompt build, Gemini time to first token, Gemini time to last token, `recordAiLog`,
   `recordAssistantTurn`, and the total inside `replyToCaller`. It also holds Gemini prompt tokens,
   visible output tokens and thinking tokens, and whether the turn was canned, handed over, muted or model-generated.
2. The relay logs a new event when the first `text` frame for a turn leaves the socket. That event carries
   the time since that turn's `prompt_final`. This is the measurement the target is defined on.
   Today the first frame and `turn_answered` are the same moment; after step 2 they are not.
3. The timings line holds no caller words, reply text or phone numbers.
4. To measure time to first token, the Google reply call may stream internally, but in step 1 it must
   still hand back the same whole reply. What callers hear, the transcript and the `ai_logs` row are all unchanged,
   including `stop_reason`, token counts and the refusal and truncation outcomes.
5. A fresh baseline is taken from step 1's logs on real test calls (at least 30 answered turns across at least 5 calls)
   and written up with a per-stage p50/p95 table before step 2 or 3 is built. Colin reads it, and it decides
   which of steps 2 and 3 goes first or is dropped (see "How step 1 decides").

Step 2: stream the first sentence on ordinary turns only (option A)

6. An "ordinary" turn is a voice turn that reaches the model call: no canned closing line, no handover,
   not muted, not a duplicate. From the code, every other kind of turn is decided before the model is called,
   from the caller's words and the stored conversation, so a turn is known to be ordinary before
   any reply text exists:
   - closing lines (`decideCallerClosing`, `packages/core/src/domain/voice.ts:119`) replace the model call;
   - handovers (`detectHandover`, `packages/core/src/domain/handover.ts:118`) are pattern rules on the caller's words
     and turn count, run at `pipeline.ts` before `generateReply`;
   - muted and capture turns return without a model reply (`pipeline.ts`, `!result.reply` in `voice.ts:190`);
   - duplicates return before anything else (`isNewMessage`).
   Only ordinary turns stream. Every other turn is spoken whole, as one `text` frame with `last: true`, exactly as now.
7. On an ordinary turn, the relay sends the reply's first complete sentence as soon as Gemini has produced it,
   as a `text` frame with `last: false`. The rest follows in further `last: false` frames, and the turn ends
   with one frame carrying `last: true`.
8. The frame carrying `last: true` always has text in it. The final sentence is held back until the model has
   finished, so the closing frame is never empty. No frame of any kind goes out with an empty token,
   because Twilio rejects one and drops the call.
9. Every streamed frame goes through the same cleaning as a whole reply today: `cleanModelReply`
   (wrapping quotes, "Reply:" labels, leaked `<thinking>` tags), `cleanForSpeech` and the relay's
   `sanitiseForSpeech`. Spaces between chunks are kept, so the words do not run together. Twilio's docs say
   "Don't trim LLM tokens; the tokens should have appropriate spaces between them", and `sanitiseForSpeech`
   trims today.
10. Across all its frames, a streamed turn says the same words a whole turn would have said for the same model output:
    `limitForSpeech(cleanModelReply(full text))`, including the 400-character `MAX_SPOKEN_CHARS` cap, cut at a sentence end.
11. A streamed turn never ends the call by itself and never asks "anything else?". From the code, an ordinary turn
    always returns `endCall: false` (`voice.ts:256`). `closing: 'wrapped_up'` (`isWrapUpLine`) is decided from the
    whole reply once it is finished, and the silence backstop is armed only after the `last: true` frame,
    timed from the whole reply's length as now.
12. If the model run fails after the caller has already heard part of the reply, the part already spoken stands.
    The relay then sends the same line the turn would have produced whole, as the closing `last: true` frame:
    - Gemini stops with SAFETY or PROHIBITED_CONTENT: the `ai_error` handover line (`renderHandoverMessage`),
      the handover is requested and the owner notified as today, then `end`;
    - truncation (MAX_TOKENS), an empty reply, a provider error or a stream that stalls: the
      `CANNOT_TAKE_CALL` line, then `end`, as `voice.ts:153` does today.
    So the caller hears, for example: "Yes, we cover Rayleigh. I'm sorry, I can't help with this one over the phone.
    I'll make sure a colleague picks it up with you." Then the line closes, as it would have closed today.
    If the run fails before anything has been sent, the turn behaves exactly as today.
13. A failed model call is retried (the existing single retry after 750 ms) only if nothing has been sent to the caller yet.
14. A stream that has sent its first sentence and then produces nothing more for a set time counts as stalled
    (point 12). The time is a named setting, not a literal: 3 s (decided at lock, open question 6).
15. Barge-in during a streamed turn. When an `interrupt` frame or a newer final prompt arrives, the relay sends
    no further frames for that turn, including no `last: true` frame. It stops reading the Gemini stream and
    stops the Gemini request. The existing take-back logic (`takeBackUnheard`) measures what was heard against everything
    sent for that turn so far, and `recordInterruptedTurn` marks the transcript as now.
16. The transcript row for a streamed turn (`recordAssistantTurn`) holds the full text that was sent,
    including any failure line from point 12. For a turn stopped by barge-in, it holds the text sent up to that point.
    The `ai_logs` row holds the model's full output, as now.
17. The next turn never starts loading memory before the previous turn's transcript row is written.
    Today the reply is only returned after `recordAssistantTurn` has finished. With streaming, the caller hears
    the reply before that write, so the order has to be kept on purpose.
18. One setting turns streaming off. With it off, every turn is spoken whole and behaves exactly as today.
    Default on, once Done-means 7 to 12 pass.

Step 3: cut time to first word (voice only)

19. The thinking budget for voice replies changes only if step 1 shows voice replies spending thinking tokens.
    The `ai_logs` figure above (about 39 completion tokens, thinking included) suggests `gemini-3.8-flash` at low
    already spends nothing, as the `THINKING_BUDGET` comment in `packages/core/src/ai/google.ts` says.
    If step 1 confirms that, the budget is left alone and the spec's write-up records "no gain available".
    Any change never sends a budget of 0 (a hard 400 on `gemini-pro-latest`) and never changes SMS, WhatsApp or web replies.
20. The voice prompt (`buildReceptionistSystemPrompt` with `memory.channel === 'voice'`,
    `packages/core/src/prompts/receptionist.ts`) is made leaner. The facts, rules and safety lines that the
    behaviour eval checks stay. The target size is proposed at 30% fewer prompt tokens (open question 4).
21. The SMS, WhatsApp, email and web chat prompts come out byte for byte the same as before.

## How step 1 decides

Colin reads the step 1 table before step 2 or 3 is built. The rule:

- If Gemini time to first token p50 is above about 0.6 s, the relay-side target (0.78 s) cannot be reached
  by streaming alone. Step 3's prompt trim goes first, and Colin decides whether the target still stands
  (open question 1).
- If time to last token minus time to first token is the bigger share, step 2 (streaming) goes first.
- If the Supabase calls together (resolve, append, context and memory load, `recordAiLog`, `recordAssistantTurn`)
  come to more than about 0.3 s p50, that is reported as a third lever. It is not in this spec's scope,
  and Colin decides whether to add it.
- If thinking tokens are zero on every voice turn, point 19 makes no change.

## Won't do

- `speechTimeout` stays 1200 (`apps/web/src/lib/conversation-relay.ts:77`, the 2026-09-25 split-turn fix).
- No platform switch (ElevenLabs Agents or otherwise), and no change of model, TTS provider or voice.
- No streaming on SMS, WhatsApp, email or web chat, and no change to their prompts.
- No streaming of canned closing lines, handover lines, capture lines, the muted-turn lines or the
  "are you still there?" line. They are short, fixed text, and they are spoken whole.
- No streaming for Anthropic or OpenAI tenants. Their adapters keep the whole-reply path. Every live tenant is on Google.
- No filler lines ("one moment...") to cover the wait.
- No change to how handovers, closings or the silence backstop decide anything.
- No Gemini context caching, and no change to how context or memory is loaded (unless Colin adds it after step 1).
- No change to the eval's cases or scoring without Colin's say (see open question 5).
- No deploy, no relay restart and no live database change without Colin's go. Nothing on `main`.

## Constraints and locked decisions

- Option A: stream ordinary turns only; hold back anything that may hand over or end. Colin, 2026-10-16 08:40, daily note.
- Stage timing first; its numbers decide step 2 against step 3. Colin, same line.
- Voice prompt only; the Gemini eval must stay at or above 28/32 (`~/.sam/work/receptionist-eval-gemini/run-eval.sh low`,
  latest `results-gemini-38-flash-low.json`). Colin, same line; score from [[AI Receptionist Platform]], behaviour eval 2026-10-14/15.
- `speechTimeout: 1200` stays. Colin, same line; the reason is in `conversation-relay.ts:70-77`.
- Never send an empty `text` token; silence is the safe failure. `apps/relay/src/protocol.ts:447-450` and its file header.
- `endCall` must never be true while `capturePending` is true. `packages/core/src/domain/voice.ts:281`; voice end-of-call spec (LOCKED 2026-09-24).
- Buying signals ("talk to someone", "rough price") must not end or escalate the call. Commit `404a834`,
  [[AI Receptionist Platform - Outbound Voice]]. Streaming changes nothing about this, because it changes no decisions.
- A truncated reply is never spoken as if complete; it goes to a person. `packages/core/src/domain/reply.ts`, truncation guard;
  [[AI Receptionist Platform]] (the 2026-09-14 adapter fix). Point 12 keeps this, with the one exception that the
  first sentence may already have been heard.
- Never send `thinkingBudget: 0`. `packages/core/src/ai/google.ts`, `THINKING_BUDGET` comment.
- Tests run with `~/.local/node/bin` Node first. [[AI Receptionist Platform]] gotcha 4.
- Live production (the VOLTA demo tenant) runs from this checkout. Ships through the Atwood gate and Colin's go to deploy.
- Never read or print env, key or token files. The eval runner loads its env file without printing values.

## Done means

Step 1

1. Unit test: a voice turn through `replyToCaller` with a fake provider writes one timings line with every stage named
   in Must do 1, all numbers, and no caller text, reply text or phone number in it. (Must do 1, 3)
2. Relay test: a final prompt answered with one frame logs the first-frame event, with a time since `prompt_final`. (Must do 2)
3. Unit test: with the internal streaming call, `generateReply` returns the same body, `stop_reason`, token counts,
   refusal and truncation outcomes as before, for fixtures covering STOP, SAFETY, MAX_TOKENS and empty output.
   Existing core and relay suites pass unchanged. (Must do 4)
4. After deploy (Colin's go), on real test calls: at least 30 answered turns across at least 5 calls. A script in
   `~/.sam/work/amy-latency/` prints the per-stage p50/p95 table and the relay-side first-frame p50/p95 from
   `journalctl --user -u atwood-relay`. The write-up goes to Colin before step 2 or 3 starts. (Must do 5)

Step 2

5. Unit test: each non-ordinary kind of turn (goodbye, "anything else?", each handover reason, capture, muted,
   duplicate) produces exactly one `text` frame with `last: true`, as today. (Must do 6)
6. Relay test with a fake streaming reply: the first `text` frame (`last: false`) goes out as soon as the first sentence
   is complete, before the fake has finished. (Must do 7)
7. Relay test: for every streamed turn the last frame has `last: true` and text in it, and no frame anywhere has an
   empty or whitespace-only token. Fixtures include a reply that is one sentence, a reply whose last chunk cleans to nothing,
   and a reply of only markup. (Must do 8)
8. Unit test over a fixed set of model outputs (quotes, a "Reply:" label, a split `<thinking>` tag, markdown, emoji, a URL,
   over 400 characters): the streamed chunks joined together equal `limitForSpeech(cleanModelReply(text))` up to
   whitespace, and adjacent chunks never run two words together. (Must do 9, 10)
9. Relay test: a streamed ordinary reply never sends `end`, a wrap-up reply arms the silence backstop only after the
   `last: true` frame, and an "anything else?" turn is never streamed. (Must do 11)
10. Relay tests on a fake stream that, after the first sentence: (a) finishes with SAFETY, (b) finishes with MAX_TOKENS,
    (c) throws, (d) goes silent past the stall setting (fake clock). Each sends the expected line from Must do 12 as
    the `last: true` frame, then `end`. In (a) a handover is requested. A throw before the first sentence is retried once;
    a throw after it is not. (Must do 12, 13, 14)
11. Relay test: an `interrupt` (and separately a newer final prompt) during a streamed turn means no further frames
    for that turn, the fake stream is aborted, and `reply_cut_off` reflects everything sent so far. (Must do 15)
12. Unit test: the transcript row for a streamed turn holds the text sent, and for an interrupted one the text up to the
    interrupt. A test with a slow transcript write shows the next turn's memory load waits for it. (Must do 16, 17)
13. Relay test: with the streaming setting off, every turn is one `last: true` frame and the existing relay tests pass unchanged. (Must do 18)

Step 3

14. Step 1's write-up states the thinking-token count for voice turns. If it is zero, `THINKING_BUDGET` is unchanged in the diff.
    If it changes, a unit test shows SMS and web replies still get today's budget and no request sends 0. (Must do 19)
15. The voice prompt for the VOLTA fixture is at least the agreed share smaller (open question 4), counted in prompt tokens
    from `ai_logs` or the model's count. (Must do 20)
16. Snapshot test: `buildReceptionistSystemPrompt` output for SMS, WhatsApp, email and web, on the existing test fixtures,
    is identical before and after. (Must do 21)
17. `~/.sam/work/receptionist-eval-gemini/run-eval.sh low` scores at least 28/32, and both voice cases
    (`voice-price-is-spoken-not-written`, `voice-never-reads-out-email`) pass 3 of 3 runs. (Must do 20)

Whole build

18. Core and relay suites green with counts reported, typecheck clean for core, relay and web. (all)
19. After deploy (Colin's go), on real test calls, at least 30 answered turns across at least 5 calls, measured with the same script
    as check 4: relay-side first-frame p50 at most 0.78 s and p95 at most 1.46 s over all answered turns, and p50 at most
    0.83 s over model-generated turns. Or whichever target Colin sets under open question 1. Superseded, interrupted and
    call-ending turns are left out, as in the baseline. (Goal)
20. Colin rings 07462 187713 and reads the 6-line script from the trial report. He confirms by ear that Amy starts sooner,
    that line 3 (barge-in) still stops her quickly, that line 5 hands over as before, and that line 6 gets "anything else?"
    then a goodbye, as before. (Goal, Must do 6, 11, 15)
21. The work is committed on `restyle/glassmorphism` on top of `5a95538` and `13da8b4`, through the Atwood gate. Nothing on `main`. (Constraints)

## Robustness

- Data model: no new tables or columns. The timings are journal lines keyed by `callSid` and turn. The transcript row (`messages`, outbound,
  `metadata.callSid` and `metadata.turn`) and the `ai_logs` row keep their shapes; only the moment the transcript row is written moves.
- Backups and restore: N/A: this build adds no stored data. Note the gap anyway: the only receptionist database dump on record is
  `~/.sam/backups/receptionist-db-20260914-081544.sql`, and the nightly `sam-backup` and `parkfords-backup` jobs do not cover it. Not this spec's to fix.
- Rollback: one setting turns streaming off with no deploy (Must do 18). Full rollback is reverting this build's commits, rebuilding,
  and restarting `atwood-relay`. Step 1 is logging only, so leaving it in place is safe.
- Failures and timeouts: Gemini keeps the 45 s whole-request timeout and the single retry, but only before anything is spoken (Must do 13).
  A stalled stream after the first sentence ends with the fallback line after the stall setting (Must do 14). SAFETY, truncation, an empty reply
  or an error mid-stream follow Must do 12. Barge-in aborts the Gemini request (Must do 15). Nothing retries more than once, and nothing loops.
  Supabase write failures are logged and swallowed, as now.
- Monitoring and alerts: the timings lines and first-frame events go to the relay journal. `receptionist-watch` raises nothing on latency today;
  a latency alert is open question 7. The fallback lines in Must do 12 are logged at warn or error, with the reason, as today's failure paths are.
- Auth and secrets: no new keys or services. Gemini uses the existing Google API key from the relay's environment file; this spec never reads it.
  The relay stays bound to loopback (`5a95538`), behind the Cloudflare tunnel's `/relay` route and Twilio signature checks.
- Expected load: today a handful of test calls a day on one demo tenant (46 voice model replies since 16 Sep). In a year, perhaps tens of
  tenants and hundreds of calls a day. One open stream per live call is well within one relay process; no scaling work.

## Open questions

1. OPEN: Which target? Halving the full caller-perceived delay cannot be reached while `speechTimeout` stays 1200 (see "Baseline and the target").
   Options: (a) halve the relay-side delay (p50 at most 0.78 s), which cuts what the caller hears by about a quarter; this spec is written against (a).
   (b) Halve the full delay, which means reopening `speechTimeout`. (c) Another number. Colin decides.
2. OPEN: Does ConversationRelay start speaking on the first `last: false` frame, or wait for more? Twilio's WebSocket messages page shows the field
   ("Whether this is the final token in the current message. Defaults to `false`.") and recommends "streaming text tokens as soon as they are available,
   rather than waiting for the entire message to be ready". Twilio's token-streaming tutorial sends each token with `last: false` and then one `last: true`.
   Neither says when playback starts or whether ElevenLabs buffers. Done-means 4 and 19 prove it on real calls; until then it is assumed.
3. OPEN: After an `interrupt`, does Twilio need a closing `last: true` frame for the cut-off message, and does it speak `last: false` frames that
   arrive after the interrupt? The docs say neither. Must do 15 sends nothing more, which is the safe reading of the existing "silence is the safe
   failure" rule. Prove it on Colin's line 3 (Done-means 20).
4. OPEN: How much smaller should the voice prompt be? Proposed: at least 30% fewer prompt tokens (from about 3,037). Colin sets the number,
   or drops the size target and keeps only the eval gate.
5. OPEN: The eval gate barely tests the voice prompt. Only 2 of the 32 cases run on the voice channel; the other 30 build the SMS prompt, which
   Must do 21 leaves unchanged. Recommended: also run the 32 cases on the voice channel, before and after the trim, and require no case to get worse.
   That changes the eval runner, so it needs Colin's yes.
6. OPEN: Stall time after the first sentence before the fallback line. Proposed 5 s.
7. OPEN: Should `receptionist-watch` alert when the relay-side p50 over the last N turns goes above a threshold? Not built here unless Colin says so.
8. OPEN: Does `@google/genai` 2.14.0's `generateContentStream` report `finishReason` and `usageMetadata` (including `thoughtsTokenCount`) on its
   final chunk, so that refusal, truncation, token counts and cost still work? The SDK has `generateContentStream`, which returns
   `AsyncGenerator<GenerateContentResponse>` (`packages/core/node_modules/@google/genai/dist`), and the reply call is plain text with no
   `jsonSchema` (`packages/core/src/domain/reply.ts`, `generateWithRetry` call), so streaming fits the reply. Lead extraction uses structured
   output and stays non-streaming. Whether the final-chunk fields arrive is proven by Done-means 3 against fixtures and by step 1's live
   `ai_logs` rows. If they do not arrive, step 1 stops and reports.
9. OPEN: The caller-perceived figure is still an estimate (1.2 s plus TTS start). Nothing here measures the TTS start or the real end of the
   caller's speech. Measuring it needs a recording of a call, or Twilio's own timings. Colin decides whether that is worth doing, or whether
   his ear (Done-means 20) is the measure.

## Decisions at lock (Colin, 2026-10-17 11:48)

1. Target (a): halve the relay-side delay. p50 at most 0.78 s and p95 at most 1.46 s, prompt_final to first text frame. `speechTimeout` stays 1200.
2. Prove on a real test call in step 1, before step 2 is built on it, that ConversationRelay starts speaking on the first `last: false` frame.
3. Prove in step 1 how Twilio treats frames after an `interrupt` (closing `last: true` needed or not; late `last: false` spoken or not). Must do 15 stands until then.
4. Voice prompt: aim for about 30% fewer prompt tokens (from about 3,037), but the eval gate rules. No token is cut that costs eval score.
5. Yes: run all 32 eval cases on the voice channel before and after the trim; no case may get worse, and the total stays at or above 28/32. The eval runner change is in scope.
6. Stall setting: 3 s after the first sentence, then the fallback line (Must do 14).
7. Yes: `receptionist-watch` alerts Colin when the relay-side p50 over the recent turns goes above the target. In scope; tickets set N and the threshold from the target.
8. Prove in step 1 that `generateContentStream` gives `finishReason` and `usageMetadata` on its final chunk. If it does not, step 1 stops and reports.
9. Yes: measure the true caller-perceived delay (end of caller speech to TTS start) from a call recording or Twilio's own timings, before and after. In scope.
After step 1, SAM puts the stage timings to Colin before step 2 tickets are built: if Gemini's time to first token dominates, the levers may shift
(prompt size, Gemini prompt caching, model tier) and Colin decides.

