Status: LOCKED 2026-10-26, Colin's decisions applied; OPEN 14 changed by Colin 2026-10-27 (after-hours override, T34)

# Errand caller: Amy places a call for Colin and reports back

Grilled 2026-10-22 (Colin: "Yeah, let's do it", then the grill answers).
Record: vault `02 - Atwood Systems/AI Receptionist Platform - Outbound Voice.md`,
section "Errand caller (grilled 2026-10-22, not yet specced)".
Branch: `restyle/glassmorphism`. Never `main`.

## Goal

Colin asks SAM in chat to make a phone errand for him (first case: book a restaurant table).
SAM writes a brief, reads it back, and only on Colin's go does Amy ring the business
from the robot number, handle the call (menus and voicemail included) inside fixed limits,
and send the outcome to Colin's Telegram.
The receptionist, its tenants, VOLTA and the Amy speed test keep working exactly as today.

## Must do

The brief and the go

1. Colin asks SAM in chat for an errand call. SAM writes a per-call brief with:
   who (business name), the number, the goal in plain words, the window
   (date, earliest and latest acceptable time), details the goal needs (for a table: party size),
   the name and mobile Amy may give (Colin's), and the limits (the fixed guardrails below plus any Colin adds).
2. SAM reads the whole brief back to Colin in one message, with the number exactly as it will be dialled.
3. Nothing dials without Colin's explicit go for that exact read-back.
   The dial step itself refuses unless a go record exists that
   (a) matches the brief as read back (any edit after the read-back voids it),
   (b) is younger than the go expiry (value: OPEN 2), and
   (c) has not been used before.
   A refused dial says why and places no call. How the go record is written is OPEN 1.
4. The dial step refuses any number that is not an allowed UK kind:
   refused are 999, 112, premium and chargeable numbers (09, 118), personal numbers (070),
   076 pagers, and anything outside +44.
   Allowed are 01, 02, 03, 07 mobiles and 080 freephone. 084 and 087 are OPEN 13.
5. The dial step refuses while a robot speed-test batch is scheduled or running:
   any `robot-*` user unit loaded (a pending timer or a running service),
   or a live `robot-run.mjs` process. It names what blocked it.
6. One errand call at a time. The dial step refuses while another errand call is live.
7. Calls are placed from the robot number +447861926390 through the account's own API base
   (`TWILIO_API_BASE_URL`, the Dublin edge), never the default host, with answering-machine
   detection on, a ring timeout and a hard maximum call length (values: OPEN 3).

On the call

8. Amy waits for the person who answers to speak first, then says up front that she is
   an automated assistant calling on behalf of Colin (wording: OPEN 17).
   If asked whether she is a person, she says she is an automated assistant.
9. She works towards the goal and may agree any time inside the window.
   She never agrees a time outside it. If only outside times are offered,
   she thanks them, ends the call and reports the times offered.
10. She gives only Colin's name and mobile from the brief. Asked for anything else
    (address, email, date of birth), she says Colin will give it directly.
    Asked for a callback number, she gives Colin's mobile, never the robot number.
11. She rings off politely if asked for payment, card details, a deposit or bank details.
    This is enforced by a check in code on what the other side says, not by the prompt alone.
12. She rings off politely when confused (two turns in a row she cannot place),
    when the turn cap is reached, or at the maximum call length (values: OPEN 3).
    The outcome says which.
13. She works phone menus: she hears the menu as text and sends keypad digits
    (0 to 9, star, hash) to reach a person or the booking option.
    Menu steps count towards the turn cap.
14. If answering-machine detection reports a machine at the end of the greeting,
    Amy leaves one short message (automated assistant for Colin, the request, Colin's mobile
    to call back) and hangs up. No back-and-forth with a machine.
    A detection result of "unknown" is treated as a person.
15. She agrees nothing beyond the goal: no deposits, no extras, no sign-ups, no changes to
    other bookings.

After the call

16. Within 2 minutes of the call ending, Colin gets one Telegram message with the outcome:
    booked (date, time, name booked under, any reference),
    not booked (why, plus any times offered),
    voicemail left,
    not reached (no answer, busy or failed),
    or ended early (which limit: payment asked, confused, turn cap, maximum length).
17. A record of each errand is kept where SAM can read it:
    the brief, the read-back, the go, every call status change, the machine-detection result,
    digits sent, each turn (who spoke, the words, the time) and the outcome.
18. Never an automatic redial. Trying again needs a new go from Colin.
19. An errand that was dialled but has no outcome 20 minutes later raises a Telegram alert.

Kept apart from the receptionist

20. Errand calls run on their own path: their own call instructions (TwiML) endpoint,
    their own socket, their own process and their own turn logic.
    Not changed: the receptionist relay (`atwood-relay`, `apps/relay/src`),
    `replyToCaller` and the pipeline in `@atwood/core/domain`, the web app,
    tenant data, VOLTA's number and settings, and the speed-test scripts.
    Errand calls write nothing to the tenant database.
21. The errand endpoints accept only requests signed by Twilio and fail closed,
    the same way the relay does today.
22. The errand path needs one new tunnel rule placed before the host-wide rule.
    It is added at build time only on Colin's go, and read back afterwards.

## Won't do

- No calls Colin has not confirmed, and no scheduled or batch errand calls.
- No payments, card details, deposits or bank details, ever.
- No inbound calls to the robot number, and no change to how it handles them in this build (see OPEN 8).
- No change to the receptionist path, tenants, VOLTA, the speed test or `robot-batch.sh`
  (see OPEN 9 for the one possible exception).
- No marketing or sales calls. Errands for Colin only, never for a client or tenant.
- No calls outside the UK.
- No second attempt inside one call at a goal Colin did not give (for example "any other night").
- No dashboard or web page. Chat in, Telegram out, files on disk.
- No change to Amy's VOLTA voice, prompt or model.

## Constraints and locked decisions

Locked by Colin in the grill, 2026-10-22 (source: vault note, "Errand caller" section):

- Caller number is the robot number +447861926390. Its "speed tests only" rule was changed by
  Colin that day for errands, never during a robot batch. Source also:
  `~/.sam/work/amy-speed-test/robot-number.md`.
- Callbacks go to Colin's mobile, which Amy gives. The robot number is not given out.
- Authority: any time inside the window; may give Colin's name and mobile;
  rings off if asked for payment or card details.
- Machines: work phone menus; leave a message on voicemail.
- Every call is confirmed by Colin before it dials: SAM reads the brief back, Colin says go.
- Errands need their own path, not the receptionist one (checked in the grill, re-checked below).

Standing rules this build must respect:

- Twilio scripts use `TWILIO_API_BASE_URL` (the Dublin edge), never `api.twilio.com`:
  auth is region-scoped and the global host gives false answers.
  Source: [[AI Receptionist Platform]] gotcha 13 and line 250.
- AI disclosure up front. Source: Outbound Voice note, "Compliance".
  The TPS screening rule there is written for marketing calls to individuals;
  an errand call on Colin's own behalf to a business is not one.
- Amy's voice on VOLTA is ElevenLabs `6fZce9LFNG3iEITDfqZZ`, en-GB, Colin's pick by ear.
  Errand calls use the same voice so "Amy" sounds like Amy.
  Source: Outbound Voice note, "Round two, the voice".
- Never `supabase db reset` on this box; the local stack is the live demo data.
  Source: Outbound Voice note, STATE 2026-09-16 18:44.
- Run Node from `~/.local/node/bin`; the system Node silently breaks TypeScript tests.
  Source: Outbound Voice note, "Environment trap".

Facts checked for this spec (read-only, 2026-10-22):

- F1. DTMF mid-call: CHECKED, yes. The app sends a `sendDigits` message on the
  ConversationRelay socket with a `digits` field that "Must only contain the characters 0-9, w, #, and *".
  No TwiML attribute is needed to send. `dtmfDetection` only governs keypresses coming in.
  The relay's own frame types already declare `sendDigits` (`apps/relay/src/protocol.ts`), unused today.
  Source: https://www.twilio.com/docs/voice/conversationrelay/websocket-messages
- F2. Answering-machine detection: PARTLY CHECKED.
  On an outbound Calls create, `MachineDetection=DetectMessageEnd` returns `machine_end_beep`,
  `machine_end_silence`, `machine_end_other`, `human`, `fax` or `unknown`, and for a machine
  waits for the end of the greeting, so a message can be left.
  Synchronous detection (the default) "blocks the call" until detection completes, then sends
  `AnsweredBy` on the request to the `Url`. With inline `Twiml` it just runs the TwiML,
  so the errand call must use a `Url`. The `Url` handler can then hand the result to Amy as a
  ConversationRelay parameter, or play the message itself.
  Asynchronous detection lets the call run and posts the result to a callback,
  and acting on it means updating the live call.
  Cost of synchronous detection: "several seconds in silence for the callee". Average result about 4 seconds.
  The `setup` socket message carries no `AnsweredBy` field.
  NOT documented: whether detection works with a ConversationRelay TwiML (OPEN 5), and the price (OPEN 16).
  Sources: https://www.twilio.com/docs/voice/answering-machine-detection ,
  https://www.twilio.com/docs/voice/answering-machine-detection-faq-best-practices ,
  https://www.twilio.com/docs/voice/api/call-resource
- F3. Robot number to any UK number: PARTLY CHECKED. Account active, type Full.
  Number +447861926390 status in-use, voice capable.
  21 of the last 50 account call records are outbound from it to a UK mobile (VOLTA), all completed.
  The account has also rung an outside UK mobile (Colin's, 2026-09-10, from the VOLTA number).
  UK geo permissions could not be read: the Dublin edge answers "Endpoint is not supported in realm 'ie1'",
  and the global host refuses the regional token. Landlines are unproven (OPEN 7).
  Found on the way: the Dublin edge shows the robot number with no voice URL today,
  where the purchase read-back recorded the reject twimlet (OPEN 8).
  Method: `robot-number.mjs whoami` and `calls`, and `~/.sam/work/errand-caller/research/check-robot-*.mjs`
  (GET only, values never printed).
- F4. Where errands can branch: CHECKED. `atwood-relay` builds one `RelaySession` per socket and
  injects `replyToCaller` (`apps/relay/src/server.ts`). `replyToCaller` resolves the tenant from the
  dialled number (`toNumber`, `packages/core/src/domain/voice.ts`) and runs `handleInboundMessage`.
  On an errand call the dialled number is the business, so it would resolve no tenant and say
  "I can't help with this one over the phone". The reply function is fixed when the socket opens,
  before the setup message, and the tunnel sends only `^/relay/?$` to port 3002.
  So the clean branch is a separate errand socket path, process and reply logic,
  with one new tunnel rule (`~/.cloudflared/receptionist.yml`), and no edit to the relay.
- F5. Batch guard: CHECKED. `robot-batch.sh` schedules each run as a transient user unit named
  `robot-<variant>-<n>` (`systemd-run --user --on-active=...`), runs 35 minutes apart, and
  `--cancel` stops them by that name. Manual runs use `robot-run.mjs` directly.
  The speed-test variant drop-in lives in `~/.config/systemd/user/receptionist-app-prod.service.d/`
  (empty today) and `/api/health` reports `voiceTestVariant` (`today` at 18:12 BST).
  At the time of checking no `robot-*` unit was loaded and no robot run was live.
  So a guard in the dial step can list `robot-*` units and robot processes before dialling.

## Done means

1. (Must-do 1, 2) Colin asks SAM for a test errand to his own mobile. The read-back shows every brief field
   and the number as dialled. Colin confirms on his phone that it is complete.
2. (3) Automated tests, each against a fake Twilio that counts call creates: dial with no go, a go for a
   brief edited after read-back, an expired go and a used go are each refused with zero creates;
   a valid go gives exactly one. Removing the guard makes the tests fail (mutation check).
3. (4) Automated test over a table of numbers: 999, 112, 09xx, 118xxx, 070, 076, a +33 number refused;
   01, 02, 03, 07 mobile, 080 allowed.
4. (5) With a harmless transient unit named `robot-guardtest-1` loaded, a dial is refused and names it;
   once stopped, the same dial passes the guard. Plus an automated test with a fake unit list.
5. (6) Automated test: a second dial while one errand is live is refused.
6. (7) First live test call, read back from the Dublin edge: From is the robot number, machine detection
   was on, and the record holds the `AnsweredBy` value.
7. (8, 9, 10) Live test: Colin plays a restaurant on his mobile, speaks first, offers a time outside the
   window, then one inside, asks "are you a real person?", and asks for a callback number.
   The transcript shows Amy waited, disclosed she is automated, declined then accepted, and gave only
   Colin's name and mobile. Colin confirms by ear.
8. (11, 15) Automated tests on the payment check (card, deposit, "long card number", bank details) end the
   call; one live test where Colin asks for a card number ends the call with outcome "payment asked".
9. (12) Automated tests: the turn cap ends the call, two confused turns end the call,
   and the maximum length is set on every call create.
10. (13) SKIPPED for the first release (Colin, 2026-10-26, OPEN 15). No live menu test;
    menus are handled per must-do 13 and fact F1, and the test is deferred to a later release.
11. (14) Live test: Colin declines the call so it goes to his voicemail. A message is left and he hears it.
    Outcome "voicemail left", `AnsweredBy` a `machine_end_*` value.
12. (16) Every live test above produces one Telegram within 2 minutes of the call ending
    (call end time from Twilio against the message time).
13. (17) The folder for a test errand holds every part listed in must-do 17, and SAM answers
    "what did they say about the time?" from it alone.
14. (18) Automated test: a no-answer outcome leads to no second call create.
15. (19) Automated test with a fake clock: a dialled errand with no outcome after 20 minutes raises one alert.
16. (20) `git diff` from the base commit shows no change under `apps/relay/src`, `packages/core/src/domain`,
    `apps/web`, `supabase`, or `~/.sam/work/amy-speed-test`. After the live tests, the tenant database holds
    no `calls` or `messages` row from those tests, and VOLTA's number routing reads back unchanged from the
    Dublin edge. `atwood-relay` keeps its PID across the build.
17. (21) Unsigned and wrongly signed requests to the errand endpoints through the public hostname are refused.
18. (22) The tunnel rule is read back after the change; `/relay` still answers 426 and `/api/health` 200.
19. (Robustness: backups) One errand folder is restored from the nightly backup into a scratch folder and
    matches the original by checksum.
20. (Robustness: rollback) Rollback rehearsed once: errand service stopped and tunnel rule removed;
    `/relay` 426 and `/api/health` 200 still; a dial then refuses cleanly with "errand service down"; then restored.

## Robustness

- Data model: one folder per errand under `~/.sam/work/errand-caller/calls/<errand id>/`, the id being the date, time and a short slug; it holds the brief, the read-back, the go, a call-event log, a transcript (one line per turn: speaker, words, time) and the outcome; the Twilio CallSid ties the folder to Twilio's own record. No tenant database rows.
- Backups and restore: `~/.sam` is in the nightly encrypted `sam-backup` (04:16, "sam state" block, only `jobs/` and caches excluded), so errand folders are covered with no change; a restore is proven by Done-means 19. Retention is OPEN 12.
- Rollback: stop and disable the errand service and remove its one tunnel rule, then restart the tunnel; nothing else changed, so the receptionist needs no rollback (Done-means 20).
- Failures and timeouts: Twilio call create times out at 15 seconds and is never retried; ring timeout and maximum call length are set on every call (OPEN 3); each model turn times out (proposed 8 seconds) and on timeout or error Amy says a fixed line, rings off and the outcome says "failed"; a socket drop is caught by Twilio's status callback; detection "unknown" means treat as a person; a failed Telegram falls back to the phone push inside `notify-colin.sh`, and the outcome stays on disk; no loop can redial (must-do 18).
- Monitoring and alerts: every errand ends in a Telegram, failures included (must-do 16); a dialled errand with no outcome after 20 minutes alerts (must-do 19); refused dials are said in chat at once.
- Auth and secrets: Twilio and model keys stay in the app env file (`apps/web/.env.local`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_BASE_URL`, `GOOGLE_API_KEY`) and Telegram in the store `notify-colin.sh` already reads; never printed. Errand endpoints accept only Twilio-signed requests (must-do 21); the dial step runs only on this box as `col`; only Colin's go releases a call (must-do 3).
- Expected load: now a few calls a month, in a year perhaps a few a week; one at a time; about 3 minutes each, roughly 30p a call at the Twilio prices recorded 2026-09-15 (UK landline $0.0158/min, mobile $0.0305/min, ConversationRelay $0.07/min) plus detection (price OPEN 16). No scaling work.

## Locked decisions (Colin, 2026-10-26)

- OPEN 1. The go record is a Go button on Telegram or phone-push, written by the bridge; SAM cannot write it.
- OPEN 2. Go expiry: 30 minutes.
- OPEN 3. Turn cap 20, ring timeout 30 seconds, maximum call length 8 minutes.
- OPEN 4. Machine detection: synchronous.
- OPEN 5. Machine detection with a ConversationRelay call is undocumented; proceed, proven by Done-means 6 and 11.
- OPEN 6. No-welcome-greeting silence is undocumented; proceed, proven by Done-means 7.
- OPEN 7. UK geo and landline: the first live landline call is the proof; no console check first.
- OPEN 8. Robot number voice URL: leave it as-is, no Twilio write.
- OPEN 9. Batch guard: one-way is accepted; no change to robot-batch.sh.
- OPEN 10. Model: the same Gemini flash as Amy.
- OPEN 11. Audio: transcript only, no recording.
- OPEN 12. Retention: 90 days.
- OPEN 13. 084 and 087 numbers refused in the first release.
- OPEN 14. Calling-hours guard: refuse to dial outside 08:00 to 21:00 UK time, unless the brief says `afterHours: true`. Then the read-back shows an "After hours" line and Colin's Go on that read-back is his consent to dial outside the hours. (Changed by Colin 2026-10-27, option A: a fixed clock wrongly blocks a business open late, such as a 2 am pizza order.)
- OPEN 15. Menu test (Done-means 10) skipped for the first release.
- OPEN 16. Detection price: AMD $0.0075 a call; ConversationRelay about $0.07 a minute.
- OPEN 17. Opening words: "Hi, this is Amy, an automated assistant calling on behalf of Colin Wood."
