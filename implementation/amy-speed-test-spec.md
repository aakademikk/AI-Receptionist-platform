Status: LOCKED 2026-10-18 (Colin: "go"). OPEN 2 (Flux pricing) is carried into the tickets as a blocker before any Flux call.

# Amy speed test: find the levers that get the reply delay to 2 s

Follows [amy-latency-spec.md](amy-latency-spec.md) step 1 (T1 to T11 DONE). T11 answer and grill: vault daily note
`01 - Daily Notes/10 - October 2026/2026-10-18.md`, 11:45 to 11:58 lines. Baseline: `~/.sam/work/amy-latency/step1-baseline.md`.
Branch: `restyle/glassmorphism` (unpushed step 1 commits underneath). Never `main`.

## Goal

Measure every candidate lever on Amy's reply delay and say which combination gets a caller from "stopped talking"
to "hears Amy" in at most 2 s at p95 (today p50 4.17 s, p95 4.78 s), without losing her quality.
The output is numbers and a recommendation for Colin. The permanent build of the winning levers is the next spec.

## Where the time goes today (baseline, 2026-10-18)

```
1.2 s  fixed pause before the turn is final (speechTimeout 1200)
1.9 s  relay: 1.60 Gemini first token, 0.26 rest of reply, 0.07 Supabase
1.1 s  remainder: Twilio speech-to-text finishing plus TTS start (not split)
= 4.17 s p50 caller-perceived
```

## Must do

Measurement method (shared by every phone test)

1. Caller-perceived delay is measured the decision 9 way: a dual-channel Twilio recording, end of caller speech to Amy's
   first audio, per answered turn (`~/.sam/work/amy-latency/measure-gaps.mjs`). Each phone variant gets at least 20 answered turns,
   and its p50 and p95 are reported against the 2 s target.
2. Every phone variant also reports its cut-off count: turns where Amy started speaking while the caller was still mid-sentence,
   counted from the recording and the journal (a split turn: two `prompt_final` frames for one spoken sentence).
   Every test call script includes the trial report's mid-sentence pause line ("I'd like... [two second pause] ...someone to look at my fuse box").
3. Test calls follow one fixed script per variant (the 6-line script from `~/.sam/work/receptionist-eleven-trial/report.md`
   plus the pause line), so variants are compared on the same words.

The robot caller (Colin, 2026-10-18: "robot caller")

3a. A spare UK Twilio number (about £1 a month) is bought and used only to ring the VOLTA line for tests. It never receives
    customer traffic and is listed in the platform note.
3b. The robot caller rings the VOLTA line from that number and plays the script as pre-rendered audio files, the same files on
    every run, in a natural-sounding British voice that is not Amy's. The pause line holds a real two-second gap mid-sentence.
3c. The robot waits for Amy to finish speaking (a silence after her audio) before it says its next line, and it hangs up after
    the last line. It never talks over Amy on purpose, so every interrupt in a robot call is a fault to report.
3d. One run is one call of the full script; runs are spaced at least 30 minutes apart (one conversation, 20-turn budget).
    SAM can start a batch of runs for a variant on a timer without Colin.
3e. Colin rings the winning variant himself once and gives a by-ear verdict, because a robot voice pauses differently from a person.

Lever A: smarter end of turn (Deepgram Flux)

4. The relay's call settings can switch, without a code change per variant, between today's settings and Flux:
   `speechModel` flux, `eotThreshold` (tested at 0.7 and 0.8), with `speechTimeout` as Flux's maximum silence cap.
   Today's settings stay the default; a variant is chosen by a setting SAM changes and reverts.
5. First check before any Flux call: Flux accepts `en-GB` (or the nearest supported English) and transcribes Colin's
   accent correctly on a short test call. If it does not, Lever A is reported as not available and its other tests are skipped.
6. Each Flux threshold is measured as a phone variant (must-dos 1 to 3).

Lever B: early "probably finished" signal (partialPrompts)

7. With Flux on, `partialPrompts` is turned on and the relay logs, per turn, the time of the first eager end-of-turn signal
   and the time of the final prompt, and whether the eager transcript matched the final one. Logging only:
   Amy still replies only to the final prompt.
8. The report gives the eager lead time (final minus eager) p50 and p95, and the match rate. That is the most a speculative
   reply (start Gemini on the eager signal) could save; building it is the next spec.

Lever C: Gemini speed (offline, no calls)

9. An offline script, run from this box, sends the real VOLTA voice prompt to Gemini 20 times per variant and records time to
   first token p50 and p95. Variants: today (`gemini-3.8-flash`, low); the same prompt cut by about 30 percent
   (timing only, quality is not judged on this cut); Gemini context caching of the fixed part of the prompt; and each lighter
   model the Google key can call (`gemini-3.5-flash` and any Flash-Lite model the API lists), at its lowest thinking setting.
10. Any model variant that is faster than today is run through the behaviour eval (`run-eval.sh low <model>`).
    It qualifies only at 27/32 or better with all eight safety and voice cases passing 3 of 3:
    `handover-emergency-burning-smell`, `handover-safety-risk-water`, `refuse-bank-details-offered`, `refuse-card-digits-pasted`,
    `refuse-card-offered`, `edge-prompt-extraction`, `voice-never-reads-out-email`, `voice-price-is-spoken-not-written`.

Lever D: TTS start

11. The report says whether a short first frame starts speaking sooner than a whole reply. Method: Twilio's session events
    (`events` attribute, speaker or tokens-played events) if they give a played time; otherwise the recording, comparing
    turns whose model time is logged, short frame against whole reply, inside the same calls.

Lever E: ElevenLabs Agents as a real candidate

12. The ElevenLabs trial agent (Amy's VOLTA prompt, same voice) is rung by the robot caller with the same script and
    measured the same way (must-dos 1 to 3), plus a by-ear quality note from Colin on one call of his own.
13. To do that the VOLTA number is pointed at the ElevenLabs agent for the test only, and pointed back afterwards
    (Twilio `voice_url` read back from the Twilio API both times), each switch on Colin's go.

The answer

14. A combined variant: the best Flux setting plus any qualifying Gemini change, measured as a phone variant.
    If it still misses 2 s p95, the report says by how much and what the eager lead time could add.
15. Report `~/.sam/work/amy-latency/speed-test-report.md`: one table of every variant (p50, p95, cut-offs, eval score where run),
    a "where the time goes" diagram for the best variant, and SAM's recommendation in one paragraph: which levers to build,
    or the platform switch if ElevenLabs beats our best by a clear margin.
16. After every phone variant the live settings return to today's (or the number to its normal route), confirmed by
    `Relay listening` settings or the Twilio API, before Colin's next normal use of the line.

## Won't do

- No speculative replies: Amy never answers an eager or interim prompt in this spec. Logging only (must-do 7).
- No streaming build (step 2 tickets stay parked) and no permanent prompt trim (step 3 tickets stay parked).
- No permanent change to the live settings: every variant is reverted (must-do 16). Keeping a winner is the next spec.
- No change to SMS, WhatsApp, email or web chat.
- No Anthropic or OpenAI model tests: the Anthropic key is still not located. If it is found, adding Haiku is a new decision.
- No change to the eval's cases or judges.
- No second Twilio number beyond the robot caller's one (must-do 3a).
- No push, no merge to `main`.

## Constraints and locked decisions

- Target: caller-perceived at most 2 s p95, "2 seconds absolute max", read as p95. Colin, 2026-10-18, daily note 11:45 and 11:55 lines.
- Pause: try the smarter end-of-turn check first; if not possible, an occasional cut-off is acceptable. Colin, grill Q1.
  `speechTimeout` 1200 stays the live default until Colin keeps a winner; the reason is at `apps/web/src/lib/conversation-relay.ts:70-76`.
- Robot caller on a spare Twilio number, Colin rings the winner. Colin, 2026-10-18 ("robot caller").
- Tests run on the live VOLTA demo line (+447462187713); only Colin rings it. Colin, grill Q2. The number is disposable
  ([[AI Receptionist Platform]] Phase 2 note).
- ElevenLabs Agents is a real candidate if it outperforms. Colin, grill Q3. This lifts amy-latency-spec's "no platform switch"
  for measurement only.
- Eval floor for a faster model: 27/32 with the eight safety and voice cases passing (must-do 10). Colin, "yes", 2026-10-18 about 11:56.
  The list of eight is SAM's reading of "safety and voice cases".
- Test calls inside 30 minutes of each other share one conversation and one 20-turn budget (migration 0014): space variants
  30 minutes apart or expect Amy to hand over. Banked trap, handoff 2026-10-18.
- Any relay restart or settings change on the live line follows the existing deploy path (both suites, restart `atwood-relay`,
  confirm the new PID) and only on Colin's go. Commits through the Atwood gate.
- Secrets: the Gemini key is loaded from `~/.sam/call-screener.env` without printing (as `run-eval.sh` does); ElevenLabs and Twilio
  keys from their existing env files. Never printed.

## Done means

1. A Flux variant can be selected and reverted by the setting alone; the relay suite proves both TwiML shapes (today's and Flux).
   (Must-do 4, 16)
2. The Flux language check result is in the report: pass with a sample transcript, or "not available" and Lever A skipped. (Must-do 5)
2a. The spare number exists on the Twilio account (read from the Twilio API) and is not attached to any tenant. (Must-do 3a)
2b. A dry robot run against the VOLTA line on today's settings completes the full script with zero robot-caused interrupts, and its
    recording measures with `measure-gaps.mjs`; replaying it twice gives the same caller audio. (Must-dos 3b to 3d)
3. Each phone variant has at least 20 answered turns in the report, with p50, p95 and cut-off count from the recording and journal. (Must-dos 1 to 3, 6, 12, 14)
4. Eager lead time p50, p95 and match rate are in the report, from journal lines written only when partialPrompts is on;
   a relay test proves Amy does not reply to an eager prompt. (Must-dos 7, 8)
5. The offline Gemini table has 20 calls per variant, first-token p50 and p95, and lists which models the key could call. (Must-do 9)
6. Every model faster than today has its eval score and the eight named cases in the report; none is recommended below the floor. (Must-do 10)
7. The TTS start finding is in the report, naming the method used. (Must-do 11)
8. The ElevenLabs variant is in the table with Colin's by-ear note; the Twilio API read-back of `voice_url` before, during and after is in the report. (Must-dos 12, 13)
9. The report exists with the table, the diagram and the recommendation, and Colin's by-ear verdict on the winner. (Must-dos 3e, 15)
10. After the last variant, `Relay listening` shows today's settings and the Twilio API shows the VOLTA number on its normal route. (Must-do 16)

## Robustness

- Data model: no new tables. Results are files in `~/.sam/work/amy-latency/` (recordings, journal extracts, JSON per variant keyed by variant name and callSid).
- Backups and restore: N/A: measurement files only; the recordings are also held by Twilio until Colin deletes them. No live data changes.
- Rollback: every variant reverts by one setting change plus restart (relay) or one `voice_url` update (ElevenLabs), read back after (must-do 16).
- Failures and timeouts: the offline script times out each Gemini call at 10 s and records it as a failure, never retried silently; a Flux call that fails to connect is reverted at once.
- Monitoring and alerts: `receptionist-watch` keeps watching the line during tests; a missed revert is caught by Done-means 10, checked by SAM after the last call.
- Auth and secrets: no new access; keys stay in their existing env files and are never printed. The robot number's outbound
  calls are started only by SAM's script; its own inbound route is set to reject so a stranger ringing it reaches nothing.
- Expected load: about 6 to 8 phone variants of 3 robot calls each (about 25 short calls, pence each, plus the £1 number),
  2 to 3 calls from Colin, and about 200 offline Gemini calls (pennies).

## Open questions

1. Answered 2026-10-18: robot caller on a spare number (must-dos 3a to 3e).
2. Answered by SAM 2026-10-18 (`~/.sam/work/amy-speed-test/flux-pricing.md`): Twilio lists ConversationRelay at a flat $0.07/min with no
   Flux line; confirmed against the first Flux call's usage record. Not a cost blocker.
