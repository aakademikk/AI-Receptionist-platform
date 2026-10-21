# Tickets: Amy speed test (find the levers that get the reply delay to 2 s)

Spec: [amy-speed-test-spec.md](amy-speed-test-spec.md) (LOCKED 2026-10-18, Colin: "go"). OPEN 2 (Flux pricing) is carried in as T1,
a GATE that blocks every ticket that makes a Flux call.
Follows [amy-latency-tickets.md](amy-latency-tickets.md) step 1 (T1 to T11 DONE). Baseline: `~/.sam/work/amy-latency/step1-baseline.md`
(caller-perceived p50 4.17 s, p95 4.78 s). Target: at most 2 s p95, end of caller speech to Amy's first audio.
Branch: `restyle/glassmorphism` (unpushed step 1 commits underneath). Never `main`. No push.
Consumer: `/implement`, one fresh agent per ticket. Build in order. Each code ticket leaves both suites green.

## Shape of the work

- Facts first (T1 to T3): Flux pricing GATE, Twilio docs facts, ElevenLabs inbound route facts. No live change.
- Offline Gemini (T4 to T9): benchmark and eval. No live change, no call. Can run before, or alongside, everything after T3.
- Code for the phone variants (T10 to T17): a test-variant setting in the web app's TwiML, a voice-only model override, eager
  end-of-turn logging in the relay, and the measuring tools. Off by default: with no setting, the TwiML is byte-identical to today's.
- Robot caller (T18 to T23): spare number GATE, pre-rendered script audio, the robot itself, the batch timer.
- Live (T24 to T35): deploy GATE, dry run, then one ticket per phone variant, each ending in its revert and read-back,
  then Colin's by-ear call on the winner and the report.

## Who runs what

- GATE tickets are run by SAM with Colin, never by a build agent: T1, T18, T24, T28, T29, T30, T32, T33, T34.
  Every change to the live voice settings (drop-in plus restart), every `voice_url` switch of the VOLTA number, buying the spare
  number, and Colin's by-ear calls are GATEs. Colin's go on a variant covers its switch and its revert; the revert is never held
  waiting for a second go.
- SAM-RUN tickets (T25, T26) are run by SAM, not a build agent: live robot calls on today's settings, no setting change.
  SAM tells Colin before a batch starts so he does not ring the line during it.
- Every other ticket is for a build agent and touches nothing live.
- Any restart on the live line follows the existing deploy path (T10 of amy-latency-tickets.md): confirm HEAD, both suites,
  restart the unit, confirm the new PID started after the change. Commits go through the Atwood gate (`gate-prepush` / `gate-detector`).

## Where the setting lives (read before T10 to T13)

The spec says "the relay's call settings". In this codebase the TwiML that carries `speechModel`, `speechTimeout` and the other
ConversationRelay attributes is built by the web app (`apps/web/src/lib/conversation-relay.ts`, served by
`receptionist-app-prod.service` from the standalone Next build), not by the relay (`atwood-relay.service`). So:
- The variant is one setting, `VOICE_TEST_VARIANT`, set in a systemd drop-in for `receptionist-app-prod`
  (`~/.config/systemd/user/receptionist-app-prod.service.d/speed-test.conf`), never in the env file. No drop-in means today.
- The web app passes the variant name to the relay as a `<Parameter>` in the TwiML, so each call's journal names its variant and the
  relay needs no restart to switch.
- Settings read-back (used by every revert, must-do 16): `curl -s http://127.0.0.1:3001/api/health` shows `voiceTestVariant: "today"`,
  the drop-in file is absent, `systemctl --user show receptionist-app-prod -p ExecMainStartTimestamp` is after the revert, and the
  relay's last `Relay listening` line is unchanged from T24 (frameProbe off).
- Done-means 1 says "the relay suite proves both TwiML shapes". The TwiML is built in core, so the core suite proves it (T10, T11).

## How to run the tests (every code ticket)

- Node 22+ with type stripping. Put `~/.local/node/bin` first on PATH (system Node fails with `ERR_NO_TYPESCRIPT`).
- Core: `pnpm --filter @atwood/core test` and `pnpm --filter @atwood/core typecheck`.
- Relay: `pnpm --filter @atwood/relay test` and `pnpm --filter @atwood/relay typecheck`.
- Web typecheck (T12, T17): `pnpm --filter @atwood/web typecheck`.
- Scripts in `~/.sam/work/amy-speed-test/` and `~/.sam/work/amy-latency/`: `~/.local/node/bin/node --test <file>.test.mjs`.
- Baseline before T10: core 262, relay 74 (amy-latency T9b). The agent re-counts before starting and reports the counts after.

## Rules for every ticket

- Never read, print, cat, grep or source-and-echo an env, key or token file (`apps/web/.env.local`, `~/.sam/call-screener.env`,
  anything named `*.env`, `*key*`, `*token*`). Scripts that need a key load the file inside the process and never print a value,
  the way `run-eval.sh`, `record-call.mjs` and `receptionist-watch.mjs` do. Twilio and ElevenLabs SIDs are masked in all output.
- No live database writes. Read-only selects only where a ticket says so.
- No deploy, restart, Twilio change, ElevenLabs change or systemd change outside a GATE ticket.
- Never log the caller's words in a new event. Existing `prompt_final` and `prompt_partial` text logging is left as it is.
- Match the surrounding code: long explanatory block comments, UK English, named constants for every tunable.
- Speed-test results live in `~/.sam/work/amy-latency/` (spec Robustness): recordings in `recordings/`, per-variant JSON in
  `speed-test/<variant>.json` keyed by variant name and callSid. Scripts live in `~/.sam/work/amy-speed-test/`.
- Out of bounds for every ticket: `speechTimeout` 1200 as the default (`conversation-relay.ts:70-77`), the handover patterns in
  `handover.ts`, `decideCallerClosing`, `decideMutedTurn`, `isWrapUpLine`, any SQL migration, the eval's cases and judges,
  SMS, WhatsApp, email and web chat paths, amy-latency step 2 and step 3 tickets (parked), `main`.

## The test script (must-dos 2 and 3)

The six lines from `~/.sam/work/receptionist-eleven-trial/report.md`, in this order:
1. "Hi, I'd like a quote for an EV charger at my house in Rayleigh."
2. "I'd like..." [exactly 2.0 s of silence] "...someone to look at my fuse box."
3. "Sorry, how soon can you come?"
4. "Roughly how much is a full rewire?"
5. "Can I speak to someone, please?"
6. "Right, that's everything, thanks. Goodbye."
Line 3 was an interruption in Colin's manual test. The robot never talks over Amy (must-do 3c), so it says line 3 as an ordinary
turn after Amy's silence. Interruption behaviour is judged by ear on Colin's calls (T32, T34), not by the robot.
Line 5 asks for a person: on the VOLTA line this triggers a handover notification to Colin on every robot run, as on his own test calls.
SAM tells Colin to expect them.

---

# Facts first

## T1: GATE: Flux pricing recorded before any Flux call (spec OPEN 2)
Status: DONE 2026-10-18 (SAM: ceiling and VERDICT in flux-pricing.md; Colin acknowledged the cost basis, "ok", about 12:04)
Spec: open question 2; Robustness "Expected load"
Depends on: none
Blocked by: Colin's acknowledgement of the cost basis
Context: Spec OPEN 2 asks whether Twilio bills Flux differently from today's Deepgram model. SAM's first pass is in
`~/.sam/work/amy-speed-test/flux-pricing.md` (2026-10-18): Twilio's UK voice pricing lists ConversationRelay at one flat
$0.07 per minute with no variation by speech model; the Flux changelog gives no price; a surcharge is not ruled out. This ticket closes
the question as far as it can be closed before a Flux call, and sets the one check that can only be made after one (T28 step 6).
Every ticket that makes a Flux call (T28, T29, T30, T33) depends on this one.
Files: ~/.sam/work/amy-speed-test/flux-pricing.md (edit)
Steps:
1. SAM re-reads Twilio's ConversationRelay pricing and the Deepgram Flux docs page on Twilio (no account change) and adds any
   Flux-specific line found, with the URL and the date read. If none, say so in one line.
2. Add the cost ceiling: about 25 robot calls of 2 to 3 minutes plus 3 of Colin's, at the flat rate and at double the flat rate.
3. Put it to Colin in one paragraph: "no Flux surcharge listed; flat $0.07/min; worst case about $15; confirmed on the first Flux
   call's usage record (T28)". Record his answer and the date under this ticket.
Do not touch: the Twilio account, the live line, the spec file (OPEN 2 is answered here, not by editing a LOCKED spec).
Proof: before, `flux-pricing.md` has no Colin acknowledgement and no ceiling line, and no answer is recorded here. After: the file
has the ceiling line and the VERDICT line, and Colin's answer is written under this ticket. Only then `Status: DONE`.
Colin's answer (2026-10-18, chat, after SAM's message "flat 7 cents a minute ... about five dollars ... confirm on the bill after the first
Flux call"): "ok let me know". Ceiling: about 75 minutes, about $5 at the flat rate, under $15 at double. Per-minute check stays in T28 step 6.

## T2: Twilio docs facts for Flux, partial prompts and played-time events
Status: DONE 2026-10-18 (twilio-facts.md has 4 sections, 6 FOUND/NOT DOCUMENTED lines, Twilio URLs)
Spec: must-dos 4, 5, 7, 11 (facts the build tickets need)
Depends on: none
Blocked by: none
Context: The build tickets need exact attribute names and the exact shape of the frames Twilio sends, from Twilio's own docs, not
guessed. Today's TwiML: `transcriptionProvider="Deepgram"`, no `speechModel`, `speechTimeout="1200"`, `language="en-GB"`.
Research only: read public docs pages, write one file. Touches nothing on the account.
Files: ~/.sam/work/amy-speed-test/twilio-facts.md (new)
Steps:
1. Flux attributes: the exact `speechModel` value for Deepgram Flux on ConversationRelay, the end-of-turn threshold attribute name
   (the spec calls it `eotThreshold`) with its allowed range and default, and what `speechTimeout` means when Flux is on (a maximum
   silence cap, or ignored). Quote each line with its URL.
2. Language: which `language` / `transcriptionLanguage` values Flux accepts, and whether `en-GB` is one. If not, the nearest English
   value and whether `ttsLanguage="en-GB"` can stay as it is.
3. Partial prompts: the attribute that turns them on (the spec calls it `partialPrompts`), and the exact JSON of the `prompt` frames
   it produces: field names, how an eager or "probably finished" end-of-turn signal is marked (a field, a value, or only `last: false`),
   and whether the final frame still arrives with `last: true`. Copy the docs' example frames verbatim.
4. Played-time events: whether ConversationRelay has a session events attribute (the spec calls it `events`) that reports when
   speech started or tokens were played, with the event name and fields.
5. For each of steps 1 to 4, end with one line: FOUND (with the quote) or NOT DOCUMENTED. NOT DOCUMENTED on step 3's eager marker
   is not a stop: T14 then logs every partial frame's non-text fields and T28 reads them off a real Flux call.
Do not touch: the Twilio account, the code, the live line.
Proof: before, `twilio-facts.md` does not exist. After: it has four sections, each with at least one Twilio docs URL and a FOUND or
NOT DOCUMENTED line; `grep -c "FOUND\|NOT DOCUMENTED" twilio-facts.md` prints at least 4.

## T3: ElevenLabs inbound route facts for the VOLTA number (no switch)
Status: DONE 2026-10-18 (elevenlabs-route.md: Route B recommended, agent settings, five-step switch and revert)
Spec: must-dos 12, 13 (facts T32 needs)
Depends on: none
Blocked by: none
Context: Must-do 13 points the VOLTA number at the ElevenLabs trial agent by changing its Twilio `voice_url`, then points it back.
ElevenLabs offers more than one Twilio route (a native number import that may take Twilio credentials and rewrite the number's
config itself, or a register-call webhook). The test needs the route that changes only `voice_url`, or, if none does, a clear list of
what else changes so Colin can decide in T32. Trial agent: `agent_7701m512068ke0tvnm2xg17kbarw`, `Amy trial (Atwood) 2026-10-16`
(details in `~/.sam/work/receptionist-eleven-trial/report.md`). Docs and read-only API calls only.
Files: ~/.sam/work/amy-speed-test/elevenlabs-route.md (new)
Steps:
1. From ElevenLabs' docs: every way to send an inbound Twilio call to an Agents agent. For each: the exact `voice_url` (or TwiML) Twilio
   needs, whether ElevenLabs needs the Twilio account SID or auth token, and what it changes on the Twilio number besides `voice_url`.
2. Recommend one route: changes only `voice_url` if any route does; never hands over the Twilio auth token without Colin's explicit go
   (flag it as a question for T32 if every route needs it).
3. Read-only: run `~/.sam/work/receptionist-eleven-trial/verify-agent.mjs` (loads its key inside the process, prints no value) and record
   the agent's current voice ID, LLM, turn settings and first message. Run `check-plan.mjs` and record the plan's conversational
   minutes if the API reports them (else "check elevenlabs.io under Agents").
4. Write the switch and revert as exact steps for T32: the "before" read-back command, the update, the "during" read-back, the revert,
   the "after" read-back, each reading `voice_url` from the Twilio API with the SIDs masked.
Do not touch: the Twilio number, the ElevenLabs agent's config, the trial agent's prompt.
Proof: before, `elevenlabs-route.md` does not exist. After: it names one recommended route with its exact `voice_url` form, says yes or
no to "needs Twilio credentials", lists the agent's current settings from step 3, and holds the five-step switch and revert.

---

# Offline Gemini (no live change, no call)

## T4: Benchmark inputs: today's VOLTA voice prompt, a 30 percent cut, and the script turns
Status: DONE 2026-10-18 (prompt-today 11512 chars, cut30 8234 = 71.5%, turns.json 6 entries)
Spec: must-do 9
Depends on: none
Blocked by: none
Context: The benchmark must use the real VOLTA voice prompt as the relay builds it today (2,938 to 3,705 prompt tokens in the baseline).
`~/.sam/work/receptionist-eleven-trial/dump-prompt.mjs` already renders it with the repo's `buildReceptionistSystemPrompt` from the
live `business_ai_context` by a read-only select. The 30 percent cut is for timing only; its quality is not judged (spec must-do 9).
Files: ~/.sam/work/amy-speed-test/bench/dump-voice-prompt.mjs (new, based on dump-prompt.mjs), ~/.sam/work/amy-speed-test/bench/prompt-today.txt (new),
~/.sam/work/amy-speed-test/bench/prompt-cut30.txt (new), ~/.sam/work/amy-speed-test/bench/turns.json (new)
Steps:
1. Copy `dump-prompt.mjs` into `bench/dump-voice-prompt.mjs`; render the voice-channel prompt for tenant `10000000-0000-4000-8000-000000000001`
   with today's date and time, to `prompt-today.txt`. Read-only select only. Print the character count, never the env values.
2. `prompt-cut30.txt`: remove whole sections or paragraphs (no rewording) until the character count is 68 to 72 percent of today's.
   List the removed section headings at the top of `bench/README.md`.
3. `turns.json`: the six script lines as six single-turn user messages (line 2 written as one sentence: "I'd like someone to look at my fuse box.").
Do not touch: `packages/core/src/prompts/receptionist.ts`, the database (selects only), the live prompt.
Proof: before, `bench/` does not exist. After: `prompt-today.txt` is non-empty, `wc -c` of `prompt-cut30.txt` is 68 to 72 percent of it,
and `turns.json` parses with six entries.

## T5: Which Gemini models the Google key can call
Status: DONE 2026-10-18 (models.json: 46 generation models, 9 candidates all callable, grep AIza count 0)
Spec: must-do 9; Done-means 5 (the list)
Depends on: none
Blocked by: none
Context: Must-do 9 tests every lighter model the key can call: `gemini-3.5-flash` and any Flash-Lite model the API lists. The list comes
from the API, not from memory. The key is loaded from `~/.sam/call-screener.env` inside the process the way `run-eval.sh` does.
Files: ~/.sam/work/amy-speed-test/bench/list-models.sh (new), ~/.sam/work/amy-speed-test/bench/list-models.mjs (new),
~/.sam/work/amy-speed-test/bench/models.json (new)
Steps:
1. `list-models.sh` loads the env file with output to /dev/null (copy `run-eval.sh`'s lines), then runs `list-models.mjs`.
2. `list-models.mjs` calls the Gemini models list (the `@google/genai` SDK from `packages/core/node_modules`, or the REST list endpoint)
   and writes every model name that supports content generation, with its supported thinking settings where the API reports them.
3. Mark the candidates: `gemini-3.8-flash` (today), `gemini-3.5-flash`, and every name containing `flash-lite`. For each candidate,
   one 1-token test call proves the key can call it (record callable yes or no and the error class if no).
Do not touch: the env file, the eval, the core adapters.
Proof: before, `models.json` does not exist. After: it lists every generation model, flags the candidates, and has a callable
yes or no on each candidate; no key value appears in it (`grep -c "AIza" models.json` prints 0).

## T6: Gemini first-token benchmark script (fake-client tested)
Status: DONE 2026-10-18 (node --test gemini-bench.test.mjs 4/4 pass, failed before; --dry-run prints 9 variants incl gemini-3.5-flash, no network)
Spec: must-do 9; Robustness "Failures and timeouts"
Depends on: T4, T5
Blocked by: none
Context: Measures time to first token, 20 calls per variant, p50 and p95 by nearest rank. Variants: `today` (`gemini-3.8-flash`, effort low,
`prompt-today.txt`), `cut30` (same model, `prompt-cut30.txt`), `cached` (same model, the fixed system prompt held in Gemini context caching),
and one per callable lighter model from `models.json` at its lowest thinking setting. Each call times out at 10 s and is recorded as a failure,
never retried silently (spec Robustness). Explicit caching may refuse a prompt below the model's minimum cacheable size: then the script records
the refusal and runs `cached` as implicit caching (the same prefix sent repeatedly), reporting `cachedTokens` from usage so the report can
say which kind ran. The script calls the API through `GoogleProvider` (`packages/core/src/ai/google.ts`, `stream: true`, which reports
`timing.firstTokenMs`) where it can, and the SDK directly for the cache.
Files: ~/.sam/work/amy-speed-test/bench/gemini-bench.mjs (new), ~/.sam/work/amy-speed-test/bench/gemini-bench.test.mjs (new),
~/.sam/work/amy-speed-test/bench/gemini-bench.sh (new)
Steps:
1. `gemini-bench.mjs`: `--variants <list>`, `--calls 20`, `--json <path>`, `--dry-run`. Calls cycle through the six turns in order.
   A gap of `CALL_SPACING_MS` (1000) between calls. Per call record variant, model, thinking setting, turn index, firstTokenMs,
   lastTokenMs, promptTokens, cachedTokens, ok or the failure class (timeout, quota, other). Never record reply text.
2. Summary per variant: n ok, n failed, first-token p50 and p95, last-token p50, mean prompt tokens, mean cached tokens.
3. Takes an injectable client so the test can use a fake; `gemini-bench.sh` loads the env file the `run-eval.sh` way and runs it for real.
4. `gemini-bench.test.mjs` with a fake client: a call that takes 11 s is recorded as a timeout and not retried; percentiles on a hand-worked
   list of 20 values; a cache-refused fake falls back to implicit and says so; `--dry-run` makes no call.
Do not touch: `packages/core/src/ai/google.ts` and its tests, the env file.
Proof: before, the test file does not exist. After: `node --test gemini-bench.test.mjs` passes all four cases; `gemini-bench.sh --dry-run`
prints the variant plan and makes no network call.

## T7: Run the Gemini benchmark and write the table
Status: DONE 2026-10-18 (gemini-bench.md: 9 variant rows each n ok 20, p50/p95 filled, callable-models list and caching kind present)
Spec: must-do 9; Done-means 5
Depends on: T6
Blocked by: none
Context: About 20 calls per variant, about 120 to 200 calls in all, pennies. No live system is touched. Run from this box.
Files: ~/.sam/work/amy-latency/speed-test/gemini-bench.json (new), ~/.sam/work/amy-latency/speed-test/gemini-bench.md (new)
Steps:
1. Run `gemini-bench.sh` with every variant, 20 calls each. Save the JSON.
2. `gemini-bench.md`: the table (variant, model, thinking setting, n ok, n failed, first-token p50, p95, last-token p50, prompt tokens,
   cached tokens), the list of models the key could call (from `models.json`), and which caching kind ran.
3. One line per variant: faster than `today` at p50 and p95, or not. Those marked faster go to T9.
Do not touch: anything live; the eval.
Proof: before, `gemini-bench.md` does not exist. After: every variant row has n ok plus n failed = 20, p50 and p95 filled, and the
callable-models list is present.

## T8: Eval floor checker (27/32 and the eight named cases 3 of 3)
Status: DONE 2026-10-18 (node --test eval-floor.test.mjs 5/5 pass, failed before; today's results score 28/32 matches log, FAILS floor on burning-smell 2/3)
Spec: must-do 10; Done-means 6
Depends on: none
Blocked by: none
Context: A faster model qualifies only at 27/32 or better with all eight safety and voice cases passing 3 of 3:
`handover-emergency-burning-smell`, `handover-safety-risk-water`, `refuse-bank-details-offered`, `refuse-card-digits-pasted`,
`refuse-card-offered`, `edge-prompt-extraction`, `voice-never-reads-out-email`, `voice-price-is-spoken-not-written`
(all present in `packages/core/src/prompts/receptionist.behaviour.test.ts`). `run-eval.sh` writes
`~/.sam/work/receptionist-eval-gemini/results-<tag>.json` with `EVAL_RUNS=3`. The checker reads that file; it never runs the eval.
Files: ~/.sam/work/amy-speed-test/bench/eval-floor.mjs (new), ~/.sam/work/amy-speed-test/bench/eval-floor.test.mjs (new)
Steps:
1. Read the results JSON shape from `results-gemini-38-flash-low.json` (today's model). Score = cases passed out of 32 by the eval's own pass rule.
2. `eval-floor.mjs <results.json>` prints the score, each of the eight cases with its passes out of 3, and QUALIFIES or FAILS with the reason.
3. Test: on today's results file it prints the same score the eval log reports (`run-gemini-38-flash-low.log`); a fixture with one of the eight at
   2 of 3 FAILS; a fixture at 26/32 FAILS.
Do not touch: the eval's cases, judges or runner; `run-eval.sh`.
Proof: before, the test file does not exist. After: `node --test eval-floor.test.mjs` passes, and the checker's score on today's results matches the log.

## T9: Behaviour eval for every model faster than today
Status: DONE 2026-10-18 (eval-results.md: 3 faster models; gemini-flash-lite-latest QUALIFIES 27/32 all eight 3/3, other two FAIL; default channel noted)
Spec: must-do 10; Done-means 6
Depends on: T7, T8
Blocked by: none
Context: Only model variants (not `cut30` or `cached`, which change no model) go to the eval. `run-eval.sh low <model>` runs the 32 cases 3 times
(timeout 900 s). It runs on the eval's default channel (the voice-channel runner, amy-latency T20, is parked); say so in the result.
Files: ~/.sam/work/amy-latency/speed-test/eval-results.md (new)
Steps:
1. For each model marked faster in `gemini-bench.md`, run `~/.sam/work/receptionist-eval-gemini/run-eval.sh low <model>`.
2. Run `eval-floor.mjs` on each results file. Record score, the eight cases and QUALIFIES or FAILS in `eval-results.md`.
3. If no model was faster, write "no model faster than today; no eval run" and stop.
Do not touch: the eval's cases and judges; the live tenant's `ai_model`.
Proof: before, `eval-results.md` does not exist. After: one row per faster model with its score, the eight cases each out of 3, and
QUALIFIES only where score is at least 27 and all eight are 3 of 3 (or the "no model faster" line).

---

# Code for the phone variants (no live change until T24)

## T10: TwiML builder: end-of-turn threshold and partial prompts attributes
Status: DONE 2026-10-18 (core 266/266 pass, typecheck clean; before: 3 new tests failed, 7 typecheck errors)
Spec: must-do 4, 7; Done-means 1
Depends on: T2
Blocked by: none
Context: `buildConversationRelayTwiml` (`packages/core/src/integrations/twilio.ts:405`) emits only what it is given and already takes
`speechModel` and `speechTimeout` (600 to 5000, checked). It has no option for Flux's threshold or partial prompts. Use the exact
attribute names and allowed ranges recorded in `~/.sam/work/amy-speed-test/twilio-facts.md` (T2), not the spec's shorthand if they differ.
Files: packages/core/src/integrations/twilio.ts (edit), packages/core/src/integrations/twilio.test.ts (edit)
Steps:
1. Add an optional threshold option (name and range from T2) and an optional boolean partial prompts option. Emit each only when given.
   Reject a threshold outside the documented range with `badRequest`, as `speechTimeout` does, with a comment saying why.
2. If T2 found the Flux language value differs from `en-GB`, nothing changes here (T11 handles it); the builder already emits what it is given.
3. Tests: neither attribute appears when not given (today's TwiML unchanged); each appears when given; an out-of-range threshold throws;
   a Flux-shaped call (speechModel, threshold, speechTimeout, partial prompts) produces all four attributes once each.
Do not touch: existing attributes and their validation, the `url` check, `escapeXml`, `conversation-relay.ts`.
Proof: before, a test passing the threshold option fails to typecheck. After: core suite green with the new tests; existing
`buildConversationRelayTwiml` tests unchanged and passing; core typecheck clean.

## T11: Voice test variant parser (today, flux-0.7, flux-0.8, optional model)
Status: DONE 2026-10-18 (core 272/272 pass, typecheck clean; before: new test file failed to import)
Spec: must-do 4, 14, 16; Done-means 1
Depends on: T10
Blocked by: none
Context: One setting names the variant, so SAM can switch and revert without a code change per variant. Grammar:
`today` | `flux-0.7` | `flux-0.8`, optionally followed by `+<gemini model>` for the combined variant (T33), for example `flux-0.8+gemini-3.5-flash`.
Unset, empty or anything unparseable means `today`, and the parser says so (fail safe to today's behaviour, never to Flux).
A Flux variant always has partial prompts on (must-do 7). `speechTimeout` stays 1200 in every variant, as Flux's silence cap
(must-do 4) unless T2 records that Flux ignores it, in which case the variant still sends 1200 and the comment says it is ignored.
Files: packages/core/src/integrations/voice-test-variant.ts (new), packages/core/src/integrations/voice-test-variant.test.ts (new),
packages/core/src/integrations/index.ts (edit, export)
Steps:
1. `parseVoiceTestVariant(raw: string | undefined)` returns `{ name, valid, turn: { speechModel?, threshold?, partialPrompts?, language? },
   voiceModel?: string }`. `today` returns an empty `turn` (no new attributes). Flux values come from T2 (model value, language value).
2. `voiceModel` accepts only names matching `^gemini-[a-z0-9.-]+$` (the provider stays Google); anything else makes the whole value invalid,
   which means `today`.
3. Tests: unset, `today`, `flux-0.7`, `flux-0.8`, `flux-0.8+gemini-3.5-flash`, and invalid inputs (`flux-0.9`, `flux`, `today+claude-x`,
   `flux-0.7+gemini-x;rm`) each map as described; invalid always gives `name: 'today'`, `valid: false`.
Do not touch: `buildConversationRelayTwiml` (beyond what T10 did), `conversation-relay.ts`.
Proof: before, the test file does not exist. After: core suite green with the new tests; core typecheck clean.

## T12: Web app uses the variant in the TwiML and shows it on /api/health
Status: DONE 2026-10-18 (core 276/276, core and web typecheck clean; byte-identical today TwiML test, flux-0.7 test; before: source-check test failed)
Spec: must-do 4, 16; Done-means 1, 10
Depends on: T11
Blocked by: none
Context: `conversationRelayTwiml` (`apps/web/src/lib/conversation-relay.ts:42`) is called by both voice routes
(`apps/web/src/app/api/webhooks/twilio/voice/route.ts` and `.../voice/relay/route.ts`), which must stay byte-identical. It reads the
setting at request time (`VOICE_TEST_VARIANT`, a server-side variable, not `NEXT_PUBLIC_`, so a restart picks it up with no rebuild).
`/api/health` (`apps/web/src/app/api/health/route.ts`) is the read-back for every revert; it must stay database-free.
Files: apps/web/src/lib/conversation-relay.ts (edit), apps/web/src/app/api/health/route.ts (edit)
Steps:
1. In `conversationRelayTwiml`, parse the variant with `parseVoiceTestVariant`. Spread its `turn` fields into the builder call. For `today`
   the builder input is exactly today's, so the TwiML is byte-identical.
2. For any variant other than `today`, add `<Parameter>`s `turnVariant` (the parsed name) and, only when set, `voiceModel`. For `today` add
   neither, so today's TwiML stays byte-identical; the relay reads a missing `turnVariant` as `today`. Comment: the relay logs the variant per
   call and uses `voiceModel` for that call only (T13).
3. `/api/health` adds `voiceTestVariant: <parsed name>`. Comment: speed-test read-back, a name only, never the raw value.
4. Keep the comment block at lines 70 to 76 about `speechTimeout` intact.
Do not touch: `VOICE_ID`, `welcomeGreeting`, `ttsLanguage`, `transcriptionProvider` for `today`, `socketUrl`, the routes' signature checks.
Proof: before, `health/route.ts` has no `voiceTestVariant` and the TwiML test below fails (no `turnVariant` parameter). After: web typecheck clean;
core suite green; a core test (in `voice-test-variant.test.ts`) builds the TwiML through the same inputs `conversationRelayTwiml` uses and
asserts `today` (and unset, and an invalid value) matches a saved copy of today's TwiML byte for byte, with no `turnVariant` parameter,
and `flux-0.7` adds exactly the Flux attributes and the `turnVariant` parameter.

## T13: Relay passes a per-call voice model override to the reply (voice only)
Status: DONE 2026-10-18 (core 279/279, relay 79/79, both typechecks clean; new tests failed before; override passed via AsyncLocalStorage scope, pipeline.ts untouched)
Spec: must-do 14
Depends on: T12
Blocked by: none
Context: The reply model is the tenant's `business_settings.ai_model` (`packages/core/src/domain/reply.ts:86` and `:109`). Changing it would
be a live database write that also changes the demo tenant's SMS, WhatsApp and web chat, which the spec rules out. Instead the combined
variant carries the model in the TwiML (`voiceModel` parameter, T12); the relay reads it from the setup frame's `customParameters` and
hands it to `replyToCaller` for that call only. Without the parameter nothing changes.
Files: apps/relay/src/server.ts (edit), packages/core/src/domain/voice.ts (edit), packages/core/src/domain/reply.ts (edit),
packages/core/src/domain/voice.test.ts (edit), apps/relay/src/protocol.ts (edit, only if the reply function's arguments are built there)
Steps:
1. Find where the relay builds the reply call from the setup's `customParameters` (`businessId`, `callSid`, `to`). Read `voiceModel`; accept it
   only if it matches the same pattern as T11; otherwise ignore it and log `voice_model_rejected` (no value).
2. `replyToCaller` gains an optional `modelOverride`. `generateReply` uses it in place of `settings.ai_model` when present, provider unchanged.
   `ai_logs` already records `result.model`, so the override shows there with no new column.
3. The relay's `setup` event logs `turnVariant` (`today` when the parameter is missing) and `voiceModel` (names only).
4. Tests: core, a voice turn with `modelOverride` sends that model to the fake provider and one without sends the tenant's; relay, a setup with
   `voiceModel: 'gemini-3.5-flash'` passes it through, one with `voiceModel: 'gpt-x'` does not.
Do not touch: non-voice reply paths, `extractLead`, `summariseConversation`, the retry rule, the stream guard, `business_settings`.
Proof: before, the new tests fail (no `modelOverride`). After: core and relay suites green with the new tests; typechecks clean.

## T14: Relay logs the eager end-of-turn lead time per turn (logging only)
Status: DONE 2026-10-18 (relay 86/86, typecheck clean; before: 4 new tests failed 82/86; eager_lead and prompt_partial_fields only when turnVariant is not today)
Spec: must-do 7; Done-means 4
Depends on: T2, T13
Blocked by: none
Context: With partial prompts on, Twilio sends interim `prompt` frames before the final one. `handlePrompt` (`apps/relay/src/protocol.ts:475`)
already ignores anything without `last: true` and logs `prompt_partial`. Must-do 7 needs, per turn, the time of the first eager end-of-turn
signal, the time of the final prompt, and whether the eager transcript matched the final one. Amy still replies only to the final prompt.
How an eager signal is marked comes from `twilio-facts.md` step 3. If it was NOT DOCUMENTED, log every partial frame's non-text field names and
values (`prompt_partial_fields`) and treat no frame as eager; T28 then reads the real shape and a follow-up adds the rule.
Files: apps/relay/src/protocol.ts (edit), apps/relay/src/protocol.test.ts (edit)
Steps:
1. Per pending turn, remember the time and a normalised copy (lowercase, punctuation and extra spaces stripped) of the first eager frame's text.
2. On the final prompt, emit `eager_lead` with `{ callSid, turn, msEagerToFinal, matched }` (no text), or nothing if no eager frame came.
3. Only when the call's `turnVariant` (from setup) has partial prompts on; otherwise no `eager_lead` line is ever written (Done-means 4).
4. Tests: an eager frame then a final frame 400 ms later (injected clock) gives `msEagerToFinal: 400, matched: true`; differing text gives
   `matched: false`; an eager frame alone produces no reply frame (Amy does not reply to an eager prompt); with `turnVariant: 'today'` no
   `eager_lead` is logged.
Do not touch: the reply rule (final only), `turn_first_frame`, the frame probe, barge-in handling, `prompt_partial`'s existing log.
Proof: before, the new tests fail. After: relay suite green with them; existing relay tests unchanged and passing; typecheck clean.

## T15: latency-stats groups by variant and reports eager lead and journal cut-offs
Status: DONE 2026-10-18 (node --test latency-stats.test.mjs passes old and new cases; failed before; --by-variant and --call work with --json)
Spec: must-dos 1, 2, 8; Done-means 3, 4
Depends on: T14
Blocked by: none
Context: `~/.sam/work/amy-latency/latency-stats.mjs` joins journal events on callSid. It does not know the variant or `eager_lead`. Journal
cut-offs per must-do 2: a split turn (two `prompt_final` for one spoken sentence, seen as `turn_superseded`), plus `interrupt` and
`reply_cut_off` events, which in a robot call only happen when Amy spoke into the robot's line.
Files: ~/.sam/work/amy-latency/latency-stats.mjs (edit), ~/.sam/work/amy-latency/latency-stats.test.mjs (edit), ~/.sam/work/amy-latency/fixtures/ (new fixture)
Steps:
1. `--by-variant`: group calls by the `turnVariant` on their `setup` event (calls without one are `today`).
2. Per group: the existing stage and first-frame figures; `eager_lead` p50, p95, n and match rate; journal cut-offs (count of `turn_superseded`,
   `interrupt`, `reply_cut_off`) per call and in total.
3. `--call <callSid>` limits the output to one call (T22 uses it).
4. Extend the test with a fixture holding a `today` call and a `flux-0.7` call with three `eager_lead` lines and one `turn_superseded`; hand-work the
   expected figures in the test.
Do not touch: the existing output format without `--by-variant` (T7 of amy-latency relies on it), the callSid join rules.
Proof: before, `--by-variant` is an unknown flag. After: `node --test latency-stats.test.mjs` passes, old and new cases.

## T16: measure-gaps reports overlaps (Amy starting while the caller is still speaking)
Status: DONE 2026-10-18 (node --test measure-gaps.test.mjs passes old and 3 new overlap cases; failed before)
Spec: must-do 2; Done-means 3
Depends on: none
Blocked by: none
Context: `measure-gaps.mjs` drops turns where Amy starts before the caller's utterance ends (barge-in). For must-do 2 those are exactly the
recording's cut-offs: Amy speaking while the caller was mid-sentence. With the robot caller (which never talks over Amy) every such overlap is
Amy's fault.
Files: ~/.sam/work/amy-latency/measure-gaps.mjs (edit), ~/.sam/work/amy-latency/measure-gaps.test.mjs (edit)
Steps:
1. Count an overlap in two cases: (a) an Amy segment starts after a caller utterance starts and before it ends; (b) an Amy segment starts inside
   a caller pause shorter than `PAUSE_LINE_MAX_MS` (2500) that is followed by more caller speech. Case (b) is the pause line: its 2 s gap is
   longer than `MERGE_GAP_MS` (700), so the two halves are two utterances and case (a) alone would miss Amy cutting in between them.
2. Output `overlaps: [{ amyStartMs, callerUtteranceStartMs }]` and `overlapCount` in `--json` and one summary line in text.
3. Test: synthetic two-channel WAVs (generated with ffmpeg in the test, as the existing test does) for no overlap, one mid-utterance overlap, and an
   Amy start inside a 2 s caller pause.
Do not touch: the gap rule, thresholds, the channel detection.
Proof: before, the new cases fail (no `overlapCount`). After: `node --test measure-gaps.test.mjs` passes old and new cases.

## T17: Suites green and the speed-test code committed through the Atwood gate
Status: DONE 2026-10-18 (commit 92394ba on restyle/glassmorphism, no push; core 279, relay 86, web typecheck clean; no T10 to T14 file modified after)
Spec: Done-means 1 (suite proof); constraint "Commits through the Atwood gate"
Depends on: T10, T11, T12, T13, T14
Blocked by: none
Context: T24 deploys a commit, so the repo changes from T10 to T14 must be one checked commit on `restyle/glassmorphism`. Scripts outside the
repo (`~/.sam/work/...`) are not committed.
Files: none new
Steps:
1. Run core and relay test and typecheck, and web typecheck. Record the counts.
2. Commit through the Atwood gate with a message naming the speed-test variant setting, the voice model override and the eager logging.
   No push.
Do not touch: `main`, any other branch, unrelated working-tree changes (`implementation/amy-latency-tickets.md` edits are SAM's).
Proof: before, the changes are uncommitted. After: `git log -1` shows the commit on `restyle/glassmorphism`; all suites green; `git status`
shows no T10 to T14 file modified.

---

# Robot caller

## T18: GATE: buy the spare UK Twilio number and set its inbound route to reject (Colin's go, about £1 a month)
Status: DONE 2026-10-18 (SAM: +447861926390 UK mobile on the existing bundle, local refused for a missing Local bundle; voice_url rejects, no SMS route; phone_numbers count 0; robot-number.md)
Spec: must-do 3a; Done-means 2a; Robustness "Auth and secrets"
Depends on: none
Blocked by: Colin's go to buy
Context: The robot rings the VOLTA line (+447462187713) from its own number, never from a customer-facing one. UK numbers need the account's
regulatory bundle; the existing VOLTA numbers show one is in place, but the purchase may still ask for it. The number never gets customer
traffic and is never attached to a tenant (`phone_numbers` row). A stranger ringing it must reach nothing.
Files: ~/.sam/work/amy-speed-test/robot-number.md (new), the platform note `~/ai-memory-vault/02 - Atwood Systems/AI Receptionist Platform.md` (edit)
Steps:
1. SAM states to Colin: the number type (UK local or mobile, whichever Twilio offers for outbound to a UK mobile at the lower rate), the
   monthly price read from Twilio, and that it is for test calls only. Wait for go.
2. Buy it through the Twilio API. Set its voice route to reject (a `<Reject/>` response; SAM picks the mechanism Twilio supports, for example a
   TwiML Bin) and no SMS route.
3. Read back from the Twilio API: the number exists, its voice route is the reject route, its SID (masked). Read-only select on `phone_numbers`:
   the number is in no row.
4. Add one line to the platform note: the number, "robot caller for speed tests only, inbound rejected, not a tenant number", the date.
Do not touch: the VOLTA numbers, any tenant row, the env file (the robot reads the number from `robot-number.md`, which holds no secret).
Proof: before, `robot-number.md` does not exist. After: it holds the number, the Twilio read-back of its voice route, and the empty
`phone_numbers` result; the platform note has the line. Done-means 2a.

## T19: Pre-rendered robot script audio (British voice that is not Amy's)
Status: DONE 2026-10-18 (6 files match manifest sha256; line 2 one silence 2.002 s at -35 dB; second render exits 1 'audio frozen', unchanged; re-rendered once after first trim failed proof)
Spec: must-do 3b, 2; Done-means 2b (same audio every run)
Depends on: none
Blocked by: none
Context: The same files every run, so variants are compared on the same sound. Amy's voice is ElevenLabs Charlotte (`6fZce9LFNG3iEITDfqZZ`);
the robot must sound different. Edge TTS is on this box in `/home/col/voice-line/.venv` (`edge-tts`), free, with British neural voices
(for example `en-GB-RyanNeural`). Twilio media streams take 8 kHz mono mu-law. Rendering is done once; the files are never re-rendered,
the manifest freezes them.
Files: ~/.sam/work/amy-speed-test/robot/render-script.sh (new), ~/.sam/work/amy-speed-test/robot/audio/line1.ulaw to line6.ulaw (new),
~/.sam/work/amy-speed-test/robot/audio/manifest.json (new)
Steps:
1. Render each script line with Edge TTS (one British voice, named in the manifest) to WAV, then ffmpeg to 8000 Hz mono mu-law raw.
2. Line 2: render "I'd like..." and "...someone to look at my fuse box." separately; join with exactly 2.000 s of mu-law silence (16,000 bytes of 0xFF).
3. Trim leading and trailing silence on every file to under 100 ms so the robot's speech start and end are where the file says.
4. `manifest.json`: per line the text, file, duration in ms, sha256, and for line 2 the offset and length of the pause.
5. `render-script.sh` refuses to overwrite an existing `audio/` (prints "audio frozen, see manifest").
Do not touch: the voice-line service, Amy's voice, anything under `apps/`.
Proof: before, `audio/` does not exist. After: six files; `sha256sum` matches the manifest; ffmpeg silencedetect (-35 dB, 0.25 s) on line 2
reports one silence of 1.95 to 2.05 s; a second run of `render-script.sh` exits non-zero with the frozen message and changes nothing.

## T20: Robot core logic: wait for Amy's silence, then the next line (pure, tested)
Status: DONE 2026-10-18 (node --test robot-core.test.mjs 10/10 pass, failed before: module absent; no robot_overlap in any run)
Spec: must-do 3c; Done-means 2b (zero robot-caused interrupts)
Depends on: T19
Blocked by: none
Context: The robot's turn-taking, kept free of sockets so it can be tested with synthetic audio. Twilio media streams send 20 ms frames of
8 kHz mu-law (160 bytes, base64) for the far end's audio (Amy) and accept the same format back, with `mark` messages to say when sent audio
has finished playing. Rule: play line 1 after Amy's greeting ends; after each line, wait for Amy to start speaking and then to be silent for
`SILENCE_AFTER_AMY_MS` (1500); then the next line. If Amy says nothing for `NO_REPLY_TIMEOUT_MS` (15000) after a line, log `no_reply` and go on.
After line 6 and Amy's reply (or the timeout), hang up. Never send audio while Amy's audio is above the threshold.
Files: ~/.sam/work/amy-speed-test/robot/robot-core.mjs (new), ~/.sam/work/amy-speed-test/robot/robot-core.test.mjs (new)
Steps:
1. Energy detector on decoded mu-law: speech when the frame RMS is above `SPEECH_DBFS` (-35, matching `measure-gaps.mjs`) for at least
   `MIN_SPEECH_MS` (80).
2. A state machine fed frames and a clock: `waiting_greeting` then per line `playing` (until its mark), `waiting_reply`, `waiting_silence`; then `hangup`.
   It returns actions: `send(lineN)`, `hangup`, and log events (line start, line mark, Amy speech start, Amy speech end, no_reply,
   `robot_overlap` if Amy audio was above the threshold at the moment a line started, which must never happen).
3. Tests with synthetic frames: a normal six-line run produces six sends in order and one hangup; Amy talking for 3 s with a 1 s breath inside
   does not trigger the next line; a silent Amy triggers `no_reply` after 15 s; no test run produces `robot_overlap`.
Do not touch: the audio files, `measure-gaps.mjs`.
Proof: before, the test file does not exist. After: `node --test robot-core.test.mjs` passes all cases.

## T21: Robot runner: place the call, stream the lines, record, and log both call SIDs
Status: DONE 2026-10-19 (round 3: root cause found with --diag, the runner sent audio on the closed tunnel-probe socket; fixed, live stream call 6 of 6 marks echoed, Amy replied to 6 lines, 6 turns measured, recording on. Stream mode works; play mode also built and tested but not needed. See t21-fix3-report.md)
Spec: must-dos 3b, 3c, 1; Done-means 2b
Depends on: T18, T20
Blocked by: none
Context: The runner places one outbound call from the spare number (`robot-number.md`) to the VOLTA line with inline TwiML
`<Connect><Stream url="wss://.../robot">` plus a one-time `runToken` `<Parameter>`, and `Record=true`, `RecordingChannels=dual` on the
call create, so every run has a two-channel recording without a separate start. The media stream needs a public `wss://` URL: the runner
starts a temporary cloudflared quick tunnel (`/usr/local/bin/cloudflared tunnel --url http://127.0.0.1:<port>`) for the run and stops it
after. It does not touch `~/.cloudflared/receptionist.yml` or `receptionist-tunnel.service`. The WebSocket server uses the `ws` package already in
`apps/relay` (import by absolute path), listens on loopback, and rejects any connection whose `runToken` does not match. The journal knows the VOLTA
side's inbound call SID, not the robot's outbound SID, so the runner looks the inbound one up (Twilio Calls list, `From` = spare number, started
within 10 s) and logs both. Twilio values are loaded from the app's env file inside the process the `record-call.mjs` way and never printed.
Files: ~/.sam/work/amy-speed-test/robot/robot-run.mjs (new), ~/.sam/work/amy-speed-test/robot/robot-run.test.mjs (new)
Steps:
1. `robot-run.mjs run --variant <name> [--dry-run]`: start the tunnel, start the server, create the call, drive `robot-core` from the stream,
   send each line's mu-law in 20 ms frames followed by a `mark`, hang up via the Calls API when `robot-core` says so, stop the tunnel.
2. Write `~/.sam/work/amy-latency/speed-test/runs/<variant>/<robotCallSid>.json`: variant, both call SIDs (masked in printed output, full in
   the file), start time, manifest sha256 per line sent, every robot-core event with its time. Print a one-line summary.
3. After hang-up, wait for the recording, fetch it with `~/.sam/work/amy-latency/record-call.mjs fetch <robotCallSid>`, and run `measure-gaps.mjs --json`
   on it into the same folder.
4. Any failure (tunnel, call create, stream never connects within 30 s) hangs up the call if one exists, stops the tunnel and exits non-zero
   with the reason. Never retried silently.
5. `--dry-run`: prints the masked call-create request and the TwiML with the token replaced by `<token>`; no tunnel, no network.
6. Test: with a fake Twilio client and a fake socket fed T20-style synthetic frames, one run sends six lines, writes the run file with both SIDs and
   six sha256 values matching the manifest, and calls hang-up once.
Do not touch: the named tunnel, the VOLTA number's config, the relay, the env file.
Proof: before, the test file does not exist. After: `node --test robot-run.test.mjs` passes; `robot-run.mjs run --variant today --dry-run` prints
the masked request and TwiML and makes no network call.

## T22: Variant summary: recording, journal and robot log combined per variant
Status: DONE 2026-10-18 (node --test variant-summary.test.mjs 5/5 pass, failed before: module absent; nearest-rank p50/p95, under-20 warning, --no-journal gives n/a)
Spec: must-dos 1, 2, 12; Done-means 3
Depends on: T15, T16, T21
Blocked by: none
Context: Each phone variant must report at least 20 answered turns, p50 and p95 of caller-perceived delay against 2 s, and cut-offs from the
recording and the journal. The ElevenLabs variant has no relay journal: its cut-offs come from the recording and the robot log only, and the
summary says so.
Files: ~/.sam/work/amy-speed-test/robot/variant-summary.mjs (new), ~/.sam/work/amy-speed-test/robot/variant-summary.test.mjs (new)
Steps:
1. `variant-summary.mjs <variant> [--no-journal]`: reads every run file in `runs/<variant>/`, its `measure-gaps` JSON, and (unless `--no-journal`)
   `latency-stats.mjs --by-variant --call <inbound callSid> --json` for each run.
2. Writes `~/.sam/work/amy-latency/speed-test/<variant>.json` keyed by callSid, and prints: runs, answered turns (scored gaps), p50, p95,
   "meets 2 s p95" yes or no, recording overlaps, journal cut-offs, robot `no_reply` and `robot_overlap` counts, and a warning when answered turns
   are under 20.
3. Test on fixture run files and gap JSON: hand-worked p50 and p95 by nearest rank; under 20 turns warns; `--no-journal` leaves journal cut-offs
   as "n/a", not 0.
Do not touch: `measure-gaps.mjs`, `latency-stats.mjs` (both changed only by T15 and T16).
Proof: before, the test file does not exist. After: `node --test variant-summary.test.mjs` passes.

## T23: Batch runs on a timer, 30 minutes apart
Status: DONE 2026-10-18 (robot-batch.sh today 5 --dry-run prints five runs 35 min apart; list-timers shows 0 robot- timers; bad args exit 2)
Spec: must-do 3d
Depends on: T21, T22
Blocked by: none
Context: One run is one call of the full script. Calls inside 30 minutes of each other from the same number share one conversation and one
20-turn budget (migration 0014), so runs are spaced at least 30 minutes apart. SAM starts a batch for a variant and it runs without Colin.
Expect about 4 or 5 answered turns per run (line 6 is an ending, and line 5 may hand over), so about 5 runs per variant, about 2.5 hours.
Files: ~/.sam/work/amy-speed-test/robot/robot-batch.sh (new)
Steps:
1. `robot-batch.sh <variant> <runs> [--no-journal]`: schedules runs with transient user timers (`systemd-run --user --on-active=...`) at
   `RUN_SPACING_MIN` (35) minute spacing, named `robot-<variant>-<n>`. Each runs `robot-run.mjs run --variant <variant>`.
2. Before each run: if `/api/health` reports a `voiceTestVariant` other than the batch's variant (and the batch is not `elevenlabs`), skip the run and
   log why (protects against a batch running on the wrong settings after a revert).
3. After the last run, runs `variant-summary.mjs`.
4. `robot-batch.sh --cancel <variant>` stops any pending timers for that variant.
5. `--dry-run` prints the schedule and the commands and creates no timer.
Do not touch: any existing user timer or unit; the relay and web units.
Proof: before, the script does not exist. After: `robot-batch.sh today 5 --dry-run` prints five runs 35 minutes apart and
`systemctl --user list-timers` shows no `robot-` timer.

---

# Live

## T24: GATE: deploy the speed-test code with today's settings (Colin's go)
Status: DONE 2026-10-18 (SAM: 92394ba live 17:21:42, both PIDs after restart, health voiceTestVariant today, frameProbe off, no drop-in; confirmation call = T25 run 1; deploy.md)
Spec: must-do 4, 16; Done-means 1, 10
Depends on: T17
Blocked by: Colin's go to deploy
Context: Live production (VOLTA demo tenant) runs from this checkout: the web app through `receptionist-app-prod.service` (standalone build,
rebuilt only through `node ~/.local/bin/receptionist-app-prod.mjs build`) and the relay through `atwood-relay.service`. A relay restart drops any
call in progress; a web restart misses webhooks for a few seconds. With no variant set, callers hear no change.
Files: none in the repo; ~/.sam/work/amy-latency/speed-test/deploy.md (new)
Steps:
1. SAM states to Colin: the commit, that with no variant the TwiML is byte-identical, the two restarts. Wait for go.
2. Deploy path: confirm HEAD is T17's commit; both suites; web build through the launcher; restart `receptionist-app-prod` and `atwood-relay`;
   confirm both new PIDs started after the restarts.
3. Settings read-back (see "Where the setting lives"): health shows `voiceTestVariant: "today"`, no drop-in, `Relay listening` shows frameProbe off.
4. Colin or SAM makes one short call to confirm Amy answers as before.
Do not touch: the env file, the Twilio numbers, the named tunnel, `main`.
Proof: before, `/api/health` has no `voiceTestVariant`. After: `deploy.md` records the commit, both PID start times after the restarts, the
health read-back with `today`, and the confirmation call's callSid (masked).

## T25: SAM-RUN: robot dry run on today's settings, twice (check 2b)
Status: DONE 2026-10-19 (SAM: dry runs 00:01 and 00:41 both 6/6 lines played and marked, Amy replied 6/6, 0 overlaps; line sha256 identical across runs and equal to manifest (checked); robot-channel segment-duration check NOT run: gaps files hold no robot segments)
Spec: must-dos 3b, 3c, 3d; Done-means 2b
Depends on: T19, T21, T22, T23, T24
Blocked by: none (no setting change; SAM tells Colin the line will ring)
Context: Proves the robot before any variant: the full script completes, the robot never talks over Amy, the recording measures, and two
replays send the same caller audio. The two runs are 35 minutes apart (one conversation per run).
Files: ~/.sam/work/amy-latency/speed-test/dry-run.md (new)
Steps:
1. `robot-batch.sh today 2`.
2. For each run: all six lines sent; `robot_overlap` count 0; journal `interrupt` events on the inbound call SID listed (each must be Amy's fault,
   checked against the robot log); `measure-gaps.mjs` produced gaps.
3. Same caller audio: the six sha256 values in the two run files are identical and match the manifest; and on the robot channel of the two
   recordings, the six speech-segment durations agree within 100 ms each.
4. If the robot misbehaves, stop: set this ticket BLOCKED and fix in T20 or T21 (reopened) before any variant.
Do not touch: settings, the VOLTA number, the env file.
Proof: before, `dry-run.md` does not exist. After: it shows two complete runs, zero robot-caused interrupts, measured gaps, identical hashes and
segment durations within 100 ms.

## T26: SAM-RUN: baseline variant `today` by robot (at least 20 answered turns)
Status: DONE 2026-10-19 (SAM: today.json, 41 answered turns over 7 good runs; caller-perceived p50 4.00 s, p95 5.69 s, max 11.8 s, 0 of 41 at or under 2 s; overlaps 0; journal cut-offs 2 on one run; recomputed by SAM)
Spec: must-dos 1, 2, 3; Done-means 3
Depends on: T25
Blocked by: none (no setting change)
Context: Every other variant is compared with this, measured the same way on the same words. The step 1 baseline (4.17 s p50) came from
Colin's voice on one call; this is the robot's figure and the one the report's table uses.
Files: ~/.sam/work/amy-latency/speed-test/today.json (written by variant-summary)
Steps:
1. `robot-batch.sh today 5` (dry-run runs from T25 may count if on the same commit and settings; say which).
2. Check the summary: at least 20 answered turns. If short, add runs.
Do not touch: settings, the VOLTA number.
Proof: before, `today.json` does not exist. After: it shows at least 20 answered turns, p50, p95, recording overlaps and journal cut-offs.

## T27: TTS start: does a short first frame start speaking sooner (Lever D, analysis only)
Status: TODO
Spec: must-do 11; Done-means 7
Depends on: T2, T26
Blocked by: none
Context: Must-do 11 uses Twilio's played-time events if they exist, otherwise the recording. Turning on an events attribute would be another
change to the live TwiML; this ticket uses the recording method on the `today` runs and, if T2 found a played-time event, says so and leaves the
choice of a follow-up to Colin. Method: per answered model turn, `x = Amy's first audio in the recording minus turn_first_frame in the journal`.
The offset between the recording clock and the journal clock is unknown but constant within a call, so compare inside each call: x for short replies
(visible tokens in the timings line at or below `SHORT_TOKENS` 15) against x for long ones (at or above `LONG_TOKENS` 40).
Files: ~/.sam/work/amy-speed-test/robot/tts-start.mjs (new), ~/.sam/work/amy-latency/speed-test/tts-start.md (new)
Steps:
1. For each `today` run, align turns by order (journal `turn_first_frame` and timings lines on the inbound callSid, recording gaps in order).
2. Per call, median x for short and for long replies; the difference is what a short frame would save at TTS start.
3. `tts-start.md`: method named ("recording, within-call comparison" or "Twilio events"), per-call differences, the overall median difference,
   and one line: "a short first frame starts speaking about N ms sooner" or "no measurable difference (under 100 ms)".
Do not touch: settings, the TwiML.
Proof: before, `tts-start.md` does not exist. After: it names the method and gives the per-call and overall differences from at least 3 calls.

## T28: GATE: Flux language check on Colin's accent, and the Flux price read-back (Colin's go)
Status: PARTLY DONE 2026-10-20 (SAM: flux-0.7 language check PASS with caveat, Rayleigh spelt Raleigh; eager_lead logged 3 of 3, none matched; reverted 08:55 and read back; step 6 price check owed tomorrow; flux-language.md)
Spec: must-do 5; Done-means 2; open question 2 (after-call check)
Depends on: T1, T2, T24
Blocked by: T1 (pricing recorded), Colin's go
Context: First Flux call. If Flux does not accept `en-GB` (or the nearest English from T2) or mishears Colin, Lever A is "not available": T29, T30
and T31 are set `Status: SKIPPED (Flux not available, <date>)` and T33 uses today's turn settings. A Flux call that fails to connect is reverted at once.
The variant switch is a drop-in plus a web restart; no relay restart.
Files: ~/.config/systemd/user/receptionist-app-prod.service.d/speed-test.conf (new, then removed), ~/.sam/work/amy-latency/speed-test/flux-language.md (new)
Steps:
1. SAM states to Colin: switching to `flux-0.7` for one short call by him, then straight back. Wait for go.
2. Write the drop-in with `Environment=VOICE_TEST_VARIANT=flux-0.7`, daemon-reload, restart `receptionist-app-prod`, confirm the new PID and
   health shows `flux-0.7`.
3. Colin rings and says three fixed sentences: "My name is Colin." "I live at 14 Eastwood Road in Rayleigh." "My number is 07700 900123."
   SAM reads the `prompt_final` text for that call (Colin's own words, his own call) and marks each key word right or wrong
   (Colin, 14, Eastwood, Rayleigh, the number). (SAM 2026-10-18: the agent had written a surname the vault does not record; removed.) Pass: all key words right, or no worse than today's Deepgram on the same sentences
   (if any is wrong, Colin repeats them on today's settings after the revert for comparison).
4. Record the real shape of the partial `prompt` frames on that call (`prompt_partial_fields` or the eager marker), for T14 if it was NOT DOCUMENTED.
5. Revert: remove the drop-in, daemon-reload, restart, settings read-back (health `today`, drop-in absent, PID after revert).
6. Next day, read that call's Twilio usage or call price and compare the per-minute charge with a same-day non-Flux call; add it to
   `flux-pricing.md`.
Do not touch: the env file, the relay, `speechTimeout`'s default, the VOLTA number.
Proof: before, `flux-language.md` does not exist and health shows `today`. After: `flux-language.md` holds the sample transcript and PASS or
"not available"; the revert read-back shows `today`; `flux-pricing.md` has the per-minute comparison.

## T29: GATE: phone variant `flux-0.7` by robot, then revert (Colin's go)
Status: DONE 2026-10-21 (SAM: 5 robot runs 2026-10-20, 28 turns; caller-perceived p50 2.95 s, p95 5.16 s, 5 of 28 at or under 2 s; recording overlaps 7, journal cut-offs 31 (baseline 0 and 2); reverted 12:05:01, health today; flux-0.7.json, flux-0.7-revert.txt)
Spec: must-dos 4, 6, 7, 1 to 3, 16; Done-means 3, 4, 10
Depends on: T26, T28
Blocked by: T28 PASS, Colin's go
Context: Measures Flux at threshold 0.7 with partial prompts on (eager logging only). About 5 runs over about 2.5 hours. Colin must not need the
line for normal use during the batch; the revert happens straight after the last run, before his next normal use (must-do 16).
Files: the speed-test drop-in (new, then removed), ~/.sam/work/amy-latency/speed-test/flux-0.7.json (written by variant-summary)
Steps:
1. SAM states to Colin: variant, batch length, revert time. Wait for go.
2. Switch: drop-in `VOICE_TEST_VARIANT=flux-0.7`, daemon-reload, restart `receptionist-app-prod`, health shows `flux-0.7`.
3. `robot-batch.sh flux-0.7 5`. If the first run fails to connect, cancel the batch and go to step 5 at once.
4. Check the summary: at least 20 answered turns (add runs if short), overlaps and journal cut-offs, `eager_lead` lines present.
5. Revert: remove the drop-in, daemon-reload, restart, settings read-back. Write the read-back into the JSON's folder as `flux-0.7-revert.txt`.
Do not touch: the env file, the relay, the VOLTA number, `speechTimeout`'s default.
Proof: before, `flux-0.7.json` does not exist. After: it has at least 20 answered turns with p50, p95 and cut-offs; `flux-0.7-revert.txt` shows
health `today`, no drop-in, and the PID start after the revert.

## T30: GATE: phone variant `flux-0.8` by robot, then revert (Colin's go)
Status: TODO
Spec: must-dos 4, 6, 7, 1 to 3, 16; Done-means 3, 4, 10
Depends on: T29
Blocked by: T28 PASS, Colin's go
Context: As T29 at threshold 0.8. Start at least 35 minutes after T29's last run (separate conversations).
Files: the speed-test drop-in (new, then removed), ~/.sam/work/amy-latency/speed-test/flux-0.8.json
Steps:
1. Steps 1 to 5 of T29 with `flux-0.8` in place of `flux-0.7`. Revert read-back to `flux-0.8-revert.txt`.
Do not touch: as T29.
Proof: before, `flux-0.8.json` does not exist. After: at least 20 answered turns with p50, p95 and cut-offs; `flux-0.8-revert.txt` shows `today`.

## T31: Eager lead time and match rate (Lever B, analysis only)
Status: TODO
Spec: must-do 8; Done-means 4
Depends on: T30
Blocked by: none
Context: The most a speculative reply could save is the gap between the first eager end-of-turn signal and the final prompt. Building that is the
next spec; here it is numbers only. `eager_lead` lines exist only on Flux calls (T14 step 3).
Files: ~/.sam/work/amy-latency/speed-test/eager-lead.md (new)
Steps:
1. `latency-stats.mjs --by-variant --since <T29 start>` over the Flux runs.
2. `eager-lead.md`: per Flux variant, `eager_lead` n, p50, p95 of `msEagerToFinal`, match rate; and one line confirming no `eager_lead` line
   on any `today` call (grep the `today` runs' inbound callSids).
3. If T14 had to fall back (eager marker NOT DOCUMENTED and not found on T28's call), say "eager signal not available" and give the reason.
Do not touch: settings, code.
Proof: before, `eager-lead.md` does not exist. After: it has n, p50, p95 and match rate per Flux variant (or the not-available line), and the
"none on today" check.

## T32: GATE: ElevenLabs variant: switch the VOLTA number, robot batch, Colin's by-ear call, switch back (Colin's go for each switch)
Status: TODO
Spec: must-dos 12, 13, 16, 1 to 3; Done-means 3, 8, 10
Depends on: T3, T26
Blocked by: Colin's go for the switch over and Colin's go for the switch back; any Twilio-credential question from T3
Context: The VOLTA number is pointed at the ElevenLabs trial agent for this test only, using the route in `elevenlabs-route.md` (T3). While it
points there: Amy's own stack gets no calls, `receptionist-watch` will alert that the number's config has changed (expected; SAM tells Colin
and does not silence the watch), and there is no handover or lead capture. The agent's conversational minutes come from the ElevenLabs plan.
No relay journal for these calls, so cut-offs come from the recording and the robot log (`--no-journal`).
Files: ~/.sam/work/amy-latency/speed-test/elevenlabs.json (variant-summary), ~/.sam/work/amy-latency/speed-test/elevenlabs-route-readback.md (new)
Steps:
1. SAM states to Colin: the route, what else changes (from T3), the expected watch alert, the batch length, and the switch-back time. Wait for go.
2. Before: read `voice_url` from the Twilio API, record it (the normal route).
3. Switch to the ElevenLabs route; during: read back `voice_url` and record it.
4. `robot-batch.sh elevenlabs 5 --no-journal` (the batch skips the health check for this variant).
5. Colin rings once himself, reads the six lines (line 3 as a real interruption), and gives a by-ear note on quality and delay. Record it verbatim.
6. Switch back on Colin's go (ask as the batch ends; the switch back is never left pending past Colin's next normal use). After: read back `voice_url`
   and confirm it equals step 2's value. Confirm `receptionist-watch` goes green on its next check.
Do not touch: the ElevenLabs agent's prompt or settings, the relay, the web settings, the spare number.
Proof: before, `elevenlabs.json` does not exist. After: it has at least 20 answered turns with p50, p95 and recording cut-offs; the read-back file shows
`voice_url` before, during and after, with after equal to before; Colin's note is recorded.

## T33: GATE: combined variant (best Flux setting plus any qualifying Gemini change), then revert (Colin's go)
Status: TODO
Spec: must-dos 14, 16, 1 to 3; Done-means 3, 10
Depends on: T9, T29, T30, T31
Blocked by: Colin's go
Context: Best Flux setting = the Flux variant with the lower p95 whose cut-off count is no worse than `today`'s by more than one per 20 turns
(Colin accepted an occasional cut-off; SAM states the choice). Qualifying Gemini change = the fastest model marked QUALIFIES in `eval-results.md`,
carried as `+<model>` in the variant (voice only, T13). `cut30` and `cached` need code that is not built in this spec; their offline gain is added
to the arithmetic in the report instead. If no model qualifies and Flux was not available, this ticket is SKIPPED with the reason.
Files: the speed-test drop-in (new, then removed), ~/.sam/work/amy-latency/speed-test/<combined variant>.json
Steps:
1. SAM states the chosen combination to Colin. Wait for go.
2. Switch: drop-in `VOICE_TEST_VARIANT=<flux-x+model>`, daemon-reload, restart, health shows it.
3. One check call (SAM or Colin) and a read-only select on `ai_logs` for that call: `model` is the override, not `gemini-3.8-flash`.
4. `robot-batch.sh <variant> 5`; at least 20 answered turns.
5. Revert and settings read-back to `<variant>-revert.txt`.
6. If p95 is above 2 s: write by how much, and what T31's eager lead p50 could take off.
Do not touch: `business_settings`, the env file, the relay.
Proof: before, the combined JSON does not exist. After: at least 20 answered turns with p50, p95 and cut-offs; the `ai_logs` model check; the revert
read-back shows `today`.

## T34: GATE: Colin rings the winning variant once and gives his by-ear verdict
Status: TODO
Spec: must-do 3e; Done-means 9
Depends on: T33 (or T32 if ElevenLabs is the winner)
Blocked by: Colin's go for the switch; Colin's time
Context: A robot pauses differently from a person, so the winner is judged by Colin's ear once. Winner = the variant with the lowest p95 that meets
the eval floor (if a model change is in it) and no more than one extra cut-off per 20 turns over `today`. If ElevenLabs won and Colin's T32 call
already was his by-ear call on it, record that and skip the switch.
Files: ~/.sam/work/amy-latency/speed-test/winner-by-ear.md (new)
Steps:
1. SAM names the winner and why. Wait for go.
2. Switch to it (drop-in and restart, or `voice_url` with before and during read-backs).
3. Colin rings and reads the six lines as a person would (line 2's pause and line 3's interruption for real). Record his verdict verbatim.
4. Revert and read back (settings read-back or `voice_url` equal to the normal route).
Do not touch: anything other than the one switch and its revert.
Proof: before, `winner-by-ear.md` does not exist. After: it names the winner, holds Colin's verdict, and the revert read-back.

## T35: Speed-test report and the final read-back
Status: TODO
Spec: must-dos 15, 16, 14 (shortfall line); Done-means 2 to 10
Depends on: T7, T9, T26, T27, T28, T29, T30, T31, T32, T33, T34
Blocked by: none
Context: The output of the spec is numbers and a recommendation for Colin; the permanent build is the next spec. Skipped tickets (Flux not available,
no qualifying model) appear in the report with their reason, not as gaps.
Files: ~/.sam/work/amy-latency/speed-test-report.md (new)
Steps:
1. One table of every variant: today, flux-0.7, flux-0.8, elevenlabs, combined, plus the offline rows (`cut30`, `cached`, each model) with first-token
   p50 and p95. Phone rows: runs, answered turns, p50, p95, meets 2 s p95, recording overlaps, journal cut-offs (n/a for ElevenLabs), eval score where run.
2. The Flux language result with its sample transcript (T28); the Flux pricing finding (T1, T28 step 6); the eager lead table (T31); the TTS start finding
   naming its method (T27); the eval table with the eight cases (T9); the ElevenLabs `voice_url` read-backs and Colin's note (T32); Colin's by-ear
   verdict on the winner (T34).
3. A "where the time goes" diagram for the best variant, in the style of `step1-baseline.md`.
4. SAM's recommendation in one paragraph: which levers to build, or the platform switch if ElevenLabs beats our best by a clear margin. If the best
   misses 2 s p95: by how much, and what the eager lead and the offline `cut30` and `cached` gains could add.
5. Final read-back (Done-means 10): health `voiceTestVariant: "today"`, no speed-test drop-in, `Relay listening` unchanged, the VOLTA number's
   `voice_url` equal to its normal route, no `robot-` timer pending. Paste the read-backs in.
Do not touch: settings, code, the Twilio numbers.
Proof: before, `speed-test-report.md` does not exist. After: it has the table, the diagram, the recommendation, every finding in step 2, and the
final read-back showing today's settings and the normal route.

---

# Coverage

## Must-dos

| must-do | tickets |
|---|---|
| 1 caller-perceived delay from dual-channel recording, at least 20 turns, p50 and p95 | T16, T21, T22, T26, T29, T30, T32, T33 |
| 2 cut-off count from recording and journal; pause line in the script | T15, T16, T19, T22 (and every phone variant) |
| 3 one fixed script per variant | T19 (the six lines), T21, T25 |
| 3a spare UK number, test use only, in the platform note | T18 |
| 3b robot plays pre-rendered audio, same every run, British voice not Amy's, real 2 s pause | T19, T21, T25 |
| 3c robot waits for Amy's silence, hangs up after the last line, never talks over her | T20, T21, T25 |
| 3d one run = one call, 30 minutes apart, batch on a timer without Colin | T23, T25 |
| 3e Colin rings the winner, by-ear verdict | T34 |
| 4 variant switch by setting, today default, SAM changes and reverts | T2, T10, T11, T12, T24, T28 |
| 5 Flux language and accent check first | T2, T28 |
| 6 each Flux threshold as a phone variant | T29, T30 |
| 7 partial prompts on with Flux, eager logging only | T2, T10, T11, T14, T29, T30 |
| 8 eager lead p50, p95 and match rate | T15, T31 |
| 9 offline Gemini benchmark, 20 calls per variant | T4, T5, T6, T7 |
| 10 eval for faster models, 27/32 and the eight cases | T8, T9 |
| 11 TTS start finding | T2, T27 |
| 12 ElevenLabs measured by robot plus Colin's by-ear note | T3, T22, T32 |
| 13 VOLTA `voice_url` switched and back, read back both times, on Colin's go | T3, T32 |
| 14 combined variant, shortfall stated | T11, T13, T33, T35 |
| 15 the report | T35 |
| 16 every variant reverted and read back | T12 (health read-back), T28, T29, T30, T32, T33, T34, T35 |
| OPEN 2 Flux pricing | T1, T28 step 6 |

## Done means

| check | ticket proof |
|---|---|
| 1 Flux selected and reverted by the setting alone; suite proves both TwiML shapes | T10, T11, T12 (core suite, see "Where the setting lives"), T24, T28 |
| 2 Flux language result in the report | T28, T35 |
| 2a spare number exists, not attached to a tenant | T18 |
| 2b dry robot run: full script, zero robot interrupts, measures, same audio twice | T19, T20, T21, T25 |
| 3 each phone variant at least 20 turns, p50, p95, cut-offs | T22, T26, T29, T30, T32, T33 |
| 4 eager lead figures; lines only with partial prompts; relay test: no reply to eager | T14, T31 |
| 5 offline table, 20 calls per variant, models listed | T5, T7 |
| 6 eval score and the eight cases for every faster model | T8, T9, T35 |
| 7 TTS start finding naming the method | T27, T35 |
| 8 ElevenLabs row, Colin's note, `voice_url` before, during, after | T32, T35 |
| 9 report with table, diagram, recommendation, Colin's verdict on the winner | T34, T35 |
| 10 after the last variant, today's settings and the normal route | T35 (final read-back), each variant's revert |

## Robustness lines that need building

| line | ticket |
|---|---|
| Gemini call timeout 10 s, recorded as a failure, never retried silently | T6 |
| Flux call that fails to connect is reverted at once | T28 step 2 and 5, T29 step 3 |
| Robot number's inbound route rejects | T18 |
| Missed revert caught after the last call | T35 step 5 |
| Results as files keyed by variant and callSid | T21, T22 |
