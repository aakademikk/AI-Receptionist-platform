# Errand caller: how SAM runs an errand

Colin asks in chat for a phone errand ("book me a table at Luigi's for two on Wednesday,
between seven and half eight"). Amy rings the business from the robot number and Colin hears
the outcome on Telegram. SAM's part is the brief, the read-back, the dial and the questions
afterwards. Chat in, Telegram out, files on disk: there is no other interface.

The command is `errand` (installed as `~/.local/bin/errand`; it runs through
`with-secrets --as errand-caller`, so SAM never handles a key).

## 1. Write the brief

Every field below is required. **Ask Colin for any that is missing. Never guess the number or
the window** — a wrong number rings a stranger, a wrong window books the wrong night.

```json
{
  "business": "Luigi's",
  "number": "020 7946 0123",
  "goal": "book a table for two",
  "goalKind": "table",
  "window": { "date": "2026-10-28", "earliest": "19:00", "latest": "20:30" },
  "details": { "partySize": 2 },
  "contact": { "name": "Colin Wood", "mobile": "<Colin's mobile>" },
  "limits": { "added": [] }
}
```

- `goalKind` is `table` or `other`. A table needs `details.partySize`.
- `window` is UK local time; Amy may agree any time from `earliest` to `latest`, both included, and nothing outside.
- `contact` is Colin's own name and mobile: the only details Amy may give, and the callback number she gives.
- `limits.added` holds anything extra Colin asks for, as plain text. The fixed guardrails are filled in for you
  (inside the window only, only Colin's name and mobile, ring off on any payment ask, nothing beyond the goal,
  turn cap 20, 8 minutes at most).

Save it to a file and run:

```
errand new brief.json          # prints the errand id, e.g. 2026-10-27-1412-luigi-s-table
```

A refusal names the field (`refused: brief details.partySize: ...`): ask Colin for it.

## 2. Read it back and wait for Go

```
errand readback <id>
```

This sends Colin one message with every line of the brief and the number **exactly as it will be
dialled**, and a Go button (phone push and the SAM tab; Telegram carries the text only). The Go
question is gated: Colin answers it in the SAM tab with his biometric step-up.

**SAM never writes the Go.** Only the bridge (`closer_answer.py`, run when Colin taps) can, and
the dial step reads only the bridge's record. Do not edit `~/.sam/jobs/*/closer.json`, and do not
answer the question for Colin. If the brief changes after the read-back, the Go is void: run
`readback` again.

A refused number (premium, 070, 076, 084/087, 999, outside the UK, ...) stops here with its
reason. Tell Colin.

## 3. Dial, once

When Colin says he has tapped Go:

```
errand dial <id>
```

- `placed: CA12...cdef` — the call is under way. The outcome reaches Colin on Telegram within
  2 minutes of the call ending. Nothing more for SAM to do.
- `refused: <guard>: <reason>` — **tell Colin in chat at once**, with the reason. The guards are:
  errand service down, the Go (missing, Cancel, expired after 30 minutes, brief edited, already used),
  the number, calling hours (08:00 to 21:00 UK), a robot speed-test batch running, another errand live.
- `failed: could not place the call (...)` — Colin is told by Telegram too. It is not retried.

**Never run `dial` twice for one Go.** A Go is single use; a second dial is refused anyway. Never
an automatic redial: trying again needs a new read-back and a new Go from Colin.

`errand dial <id> --check` runs every guard, prints one line each and never dials. Use it to see
which guard would refuse.

## 4. Answer questions from the record

```
errand status <id>
```

prints everything the folder holds: the brief, the read-back, the Go, every call status change,
the machine-detection result (`answered answeredBy=...`), digits sent, each turn with who spoke,
the words and the time, and the outcome. Answer Colin's questions ("what did they say about the
time?") from the transcript lines in it, quoting them; do not guess beyond it.

`errand list` shows every errand and its state. If an errand was dialled and has no outcome after
20 minutes, Colin gets an alert automatically (`errand watch`); check `status` and tell him what it shows.

## What SAM never does

- Dial without Colin's Go for that exact read-back, or write the Go record itself.
- Dial for anyone but Colin, outside the UK, or for marketing or sales.
- Give out the robot number, or any detail of Colin's beyond his name and mobile.
- Change the receptionist, VOLTA, the speed test or any tenant data.
