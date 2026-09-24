Status: LOCKED 2026-09-24

# Voice agent: end-of-call and lead source

Branch: `restyle/glassmorphism`. Built in a Claude Code cloud session (the $100 credit).
Grilled 2026-09-24 (seat 1 session, Colin's answers recorded in the vault daily note 2026-09-24).

## Goal

Amy stops leaving the line open. When a call is over, she closes it herself,
so no caller has to hang up on dead air. Voice leads are tagged as voice, not SMS.

## Must do

1. When the caller says goodbye (or equivalent: "that's all", "cheers, bye", "no thanks, bye"),
   Amy does not hang up straight away. She asks once whether there is anything else she can help with.
2. She asks that clarifying question at most once per call.
   If the caller answers no (or says goodbye again), Amy says one short goodbye and ends the call
   straight away, with no silence wait. If the caller raises something new, the call carries on as normal.
3. Silence backstop, armed only after Amy has wrapped up (a closing line such as "have a good evening")
   or has asked "anything else I can help with?". Once armed, if the caller says nothing for 3 seconds
   after she finishes speaking, Amy says "Are you still there?" (or close wording).
   At any other point in the call there is no silence timer; a caller can pause as long as they like.
4. If the caller then says nothing for a further 3 seconds, Amy ends the call.
5. Any caller speech, including partial speech still being recognised, cancels the running
   silence countdown. A caller who is mid-sentence is never asked "are you still there?".
6. The existing ways a call ends keep working exactly as today: handover, detail capture
   after a handover (line stays open for the answer, closes the turn after), the turn limit,
   and the pipeline-failure line.
7. A lead created from a voice call has `leads.source = 'voice_call'`.
8. SMS and WhatsApp leads keep their current source values (`inbound_sms`, `whatsapp`).

## Won't do

- No change to SMS or WhatsApp replies. Goodbye handling and silence timers are voice only.
- No backfill of old `leads.source` values. The 10 existing rows are Colin's test calls.
- No change to `record_missed_call` or the `missed_call` source (unanswered calls stay `missed_call`).
- No fix to `supabase/tests/functional.sql` (dropped at grill-me; CI runs it on a fresh DB where it passes).
- No multi-language, no outbound scheduler, no latency work, no prompt rewrite beyond what Must do 1 needs.
- No deploy, no relay restart, no Twilio or live database changes from the cloud session.
- No merge to `main`.

## Constraints and locked decisions

- Buying signals ("talk to someone", "rough price") must not end or escalate the call.
  The 09-17 fix, commit `404a834`. Source: [[AI Receptionist Platform - Outbound Voice]] §FIXED.
- `endCall` must never be true while `capturePending` is true. Source: `packages/core/src/domain/pipeline.ts` (capturePending comment).
- The deliberate trade stays: a bare "I want to talk to someone" is not escalated. Source: same note.
- Twilio ConversationRelay has no native silence event that we know of. The backstop is our own timer.
  Confirm against the ConversationRelay event set before building on that assumption.
- Silence is the safe failure: never send an empty `text` token (Twilio drops the call on it).
  Source: `apps/relay/src/protocol.ts` header.
- Tests run with `~/.local/node/bin` Node first (system Node fails with `ERR_NO_TYPESCRIPT`).
  Source: [[AI Receptionist Platform]] gotcha 4. In the cloud sandbox, use Node 22+ with type stripping.
- Backstop scope is Colin's call (2026-09-24): only after a wrap-up or the "anything else?" question.
  Arming it needs Amy's closing line recognised. A false positive only costs one "are you still there?";
  nothing hangs up without 6 s of caller silence.
- After "anything else?" is answered no: quick goodbye, hang up at once. Colin's call, 2026-09-24.
- Timings (3 s, then 3 s) are Colin's call from grill-me. Keep them as named settings, not literals scattered in code.

## Done means

1. Unit tests: caller goodbye produces the clarifying question and does not end the call. (Must do 1)
2. Unit test: after the clarifying question, "no thanks" (and a second goodbye) gets one short goodbye
   with `endCall: true`, never a second clarifying question. A new question instead gets a normal reply
   with `endCall: false`. (Must do 2)
3. Relay test on a fake clock: Amy's turn, 3 s of no caller frames, then the relay sends the
   "are you still there?" text frame. (Must do 3)
4. Relay test on a fake clock: 3 s more with no caller frames, then the relay sends an `end` frame. (Must do 4)
5. Relay test on a fake clock: after an ordinary (not wrap-up) Amy turn, 10 s of caller silence
   sends nothing and does not end the call. (Must do 3)
6. Relay test: an interim (`last: false`) prompt frame inside either window cancels the countdown;
   no prompt or `end` frame goes out. (Must do 5)
7. Full suites green, with counts reported: core (was 191/191), relay (was 44/44), typecheck clean.
   The existing handover and capture tests pass unchanged. (Must do 6)
8. Unit or SQL test: a voice-channel inbound creates a lead with source `voice_call`;
   an SMS one still gets `inbound_sms`. (Must do 7, 8)
9. The work is committed and pushed to `restyle/glassmorphism` as one or more commits, nothing on `main`. (Won't do)
10. Local, after pull, build and `atwood-relay` restart: Colin rings Amy, says "wrong number" and goes quiet.
   The line closes by itself within about 10 seconds of her last word. Proven in `journalctl --user -u atwood-relay`
   by a `session_end` the relay initiated, not a Twilio close. (Must do 3, 4)
11. Same local build: Colin rings, says "that's all, bye". Amy asks if there is anything else;
   Colin says "no". She says goodbye and the relay ends the call (`session_end` reason `domain`). (Must do 1, 2)
12. The newest voice lead in `public.leads` reads `voice_call`. (Must do 7)

Checks 1 to 9 are provable in the cloud session. Checks 10 to 12 need the live box and a real call.

## Open questions

- OPEN (technical, the build answers it): can the relay tell when Amy has finished speaking?
  If the 3 s starts when the text is sent rather than when the audio ends, a long reply
  would trip "are you still there?" over her own voice. The builder must find out and say which it is.
