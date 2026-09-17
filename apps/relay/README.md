# Atwood Relay

The WebSocket half of the conversational voice path. Twilio's
`<Connect><ConversationRelay>` opens a socket here when a call is answered, and this
process exchanges **text** turns with it.

Everything telephony-shaped is Twilio's: speech recognition, speech synthesis, the 8kHz
audio format, and barge-in. What arrives here is JSON, which is why this is a small
process rather than a media pipeline.

## Why it is a separate process

It holds a socket open for the length of a call, which a Next.js route handler cannot
promise — the platform's own voice route says it best, that it "must respond fast and
synchronously". A route that returned TwiML and then tried to hold a socket open would be
fighting its runtime.

It follows the `sam-voice.service` precedent: a plain Node process on its own port under
its own systemd user unit, reachable only through the cloudflared tunnel.

## What it does today

**It holds the call.** Each caller turn goes to `replyToCaller` in `@atwood/core/domain` —
the same pipeline the SMS channel runs, so the same prompt, the same handover ladder, the
same lead extraction — and the answer comes back as words to speak.

This process knows nothing about customers. It parses frames, decides which turn is still
worth speaking, and owns the socket. That split is what lets the turn logic be tested
without a phone call, and the pipeline be tested without a socket.

Two things it does that are not obvious from the outside:

* **A failed turn is not silence.** If the tenant cannot be resolved or the database is
  unreachable, the caller hears a line we chose in advance and the line closes. A socket
  that emits nothing reads as a dropped call, and they ring back.
* **The assistant writes its own turn down.** Nothing else does it — on SMS a messaging
  workflow sends the reply and appends it, and a spoken turn has no such sender. Without
  it the transcript keeps only the caller's half, `ai_turn_count` never advances, and the
  turn budget that ends a runaway call never fires.

The greeting is the tenant's own, rendered from `business_ai_context` into the TwiML
rather than sent down the socket, so it plays even if this process never connects.

**Barge-in is handled at the session level, deliberately.** Twilio stops the audio and
sends `interrupt`; the reply being composed for the abandoned turn is then discarded
instead of being spoken over the caller. It is *not* a cancellation of the model call —
the provider interface takes no caller-supplied abort signal, so a turn already in flight
runs to completion and is thrown away. On a call that costs a fraction of a penny, and
buys the right behaviour, that is the trade.

## Layout

| File | What it is |
|---|---|
| `src/server.ts` | HTTP upgrade handling, signature gate, socket lifecycle, shutdown |
| `src/protocol.ts` | The message protocol and the turn logic. No socket, no clock, no network — the reply function is injected, so tests drive it with a fake |
| `src/signature.ts` | Which URL string Twilio signed, and the check against it |
| `atwood-relay.service` | The systemd user unit |

## Running it

```bash
# Tests — protocol, signature, and an end-to-end turn over a real socket.
~/.local/node/bin/node --test --experimental-strip-types "src/**/*.test.ts"

# Typecheck
~/.local/node/bin/node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json

# By hand
~/.local/node/bin/node --experimental-strip-types --env-file=../web/.env.local src/server.ts
```

**Use the tarball Node at `~/.local/node/bin/node`.** `/usr/bin/node` has no TypeScript
support and *accepts* `--experimental-strip-types` while silently doing nothing, so the
failure reads as a syntax error in our code rather than as the wrong runtime. It is also
not on the default PATH.

### Service management

```bash
systemctl --user status  atwood-relay
systemctl --user restart atwood-relay
journalctl --user -u atwood-relay -f          # every call event lands here
```

Install or update the unit after editing `atwood-relay.service`:

```bash
cp atwood-relay.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user restart atwood-relay
```

## Configuration

| Variable | Where | Purpose |
|---|---|---|
| `TWILIO_AUTH_TOKEN` | `apps/web/.env.local` | Validates the handshake. The process **refuses to start** without it |
| `RELAY_PORT` | unit file | Default `3002` |
| `RELAY_MAX_TURNS` | unset | Backstop on caller turns before hanging up. Default `40` — see below |
| `RELAY_PUBLIC_URL` | unset | Overrides the origin derived from the upgrade request. Only needed if the derived one is wrong |

One env file, read by both the web app and this service. That is deliberate: the token that
validates a handshake must be the same one Twilio signed with, and two copies is a drift
waiting to happen.

**`RELAY_MAX_TURNS` is a backstop, not the product's limit.** The limit a tenant sets is
`ai_max_turns`, and it is enforced in the domain layer, which ends the call by asking for
it — the assistant winding the conversation up in words rather than the socket cutting the
line. This exists so a bug in that logic cannot bill somebody for an hour-long call, and it
is set far above any real limit for that reason. Set it low and every call ends early.

## The `/relay` path is a contract

Three things must agree on `/relay` and `3002`:

1. the `url` attribute emitted by `apps/web/src/lib/conversation-relay.ts` (constant
   `RELAY_PATH`), used by both `/api/webhooks/twilio/voice` when the number's `answer_mode`
   is `conversational` and `/api/webhooks/twilio/voice/relay` when a number is pointed at
   it directly
2. the tunnel ingress rule in `~/.cloudflared/receptionist.yml`
3. `RELAY_PORT` in `atwood-relay.service`

Change one, change all three. A mismatch produces a WebSocket that 404s, which Twilio
reports as a failed call with no useful reason attached.

## Signature validation, and the one thing we do not know

Twilio states the handshake carries `X-Twilio-Signature` and that it uses "the same
verification mechanism used for standard Twilio webhooks" — but it does not publish the
string it signs, and a WebSocket upgrade has no form body to concatenate.

`src/signature.ts` therefore tries both `wss://host/path` and `https://host/path` and
**logs which one matched**. That is not a widening of the check: both are the same
authority and path, and the HMAC still requires the account's auth token either way. The
reason to accept both rather than guess is that guessing wrong fails closed and silently.

Once the first real call has been made, read the answer out of the log —

```
"message":"Relay handshake accepted","signedUrlForm":"wss"
```

— and the losing candidate can then be deleted.

## Prerequisite: the AI/ML addendum

ConversationRelay will not work until the **Predictive and Generative AI/ML Features
Addendum** is accepted on the account. It is free and self-serve, in the Twilio console
under **Products & Services → Voice → Settings → Privacy & Security** (the legacy console
path, Voice → Settings → General, is where it used to live).

## Testing it

The relay is inert until a number's Voice URL points at the relay TwiML route. To test:

1. Confirm the addendum is accepted.
2. Either set the number's `answer_mode` to `conversational` — the supported way — or, to
   force it on for one number without touching its row, set its **Voice URL** to
   `https://receptionist.atwoodsystems.co.uk/api/webhooks/twilio/voice/relay` (POST).
3. Check the tenant's `greeting_template` is a greeting. It is *not* the place for
   "we're sorry we missed your call" — that wording belongs to
   `business_settings.missed_call_template`, and a caller on the line has not been missed.
4. Call the number.
5. Expect, in order: the tenant's greeting, then a real answer to what you said. Interrupt
   it mid-sentence and it should stop and listen. Ask for a human and it should take
   details, say a colleague will be in touch, and close the line.
6. Read the call back: `journalctl --user -u atwood-relay -f` logs every turn, and the
   conversation appears in the dashboard with both halves of the transcript.

**Warm the route before the first real call.** The app runs under `next dev`, which
compiles a route on first request — and the caller is listening to silence while it does.
Hit the route once with a request that fails signature validation (a plain `curl` will do)
so the compile happens before Twilio is waiting on it.

## Costs

ConversationRelay is **$0.07/min** on top of the voice leg (UK inbound $0.0100/min). A
three-minute test call is single-digit pence. Nothing here bills while idle.
