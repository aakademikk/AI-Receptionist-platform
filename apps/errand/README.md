# Atwood Errand

The errand path of the errand caller spec
([implementation/errand-caller-spec.md](../../implementation/errand-caller-spec.md)):
Colin asks SAM in chat for a phone errand, SAM reads the brief back, and only on Colin's Go
does Amy ring the business from the robot number, handle the call inside fixed limits, and
send the outcome to Colin's Telegram.

## Why it is its own package and process

The receptionist relay (`apps/relay`) fixes its reply function when the socket opens and
resolves a tenant from the dialled number. On an errand the dialled number is the business,
so the relay would find no tenant and decline the call (spec fact F4). Rather than teach the
relay a second job, errands get their own call instructions endpoint, their own socket,
their own process and their own turn logic. The receptionist stays byte-identical.

The boundary is a test (`src/boundary.test.ts`): this package may use `@atwood/core` only for
`./integrations/twilio` (signature check, TwiML builder) and `./ai` (the Gemini provider), and
imports nothing from `@supabase/*`, `@atwood/core/domain`, `apps/relay` or `apps/web`. Errand
calls write nothing to the tenant database: each errand is a folder on disk.

## Entry points

* **server** (`src/server.ts`): one Node process on 127.0.0.1:3003 serving the call
  instructions (`/errand/twiml`), the status callback (`/errand/status`), the socket
  (`/errand/ws`) and a local-only health check (`/errand/health`). Twilio-signed requests only.
* **CLI** (`src/cli.ts`): what SAM runs: `new`, `readback`, `dial [--check]`, `status`, `list`.
* **watch** (`errand watch <id>`): the 20-minute no-outcome alarm the dial step schedules.
* **prune** (`errand prune [--dry-run]`): removes errand folders older than 90 days, daily.

Every tunable is a named constant in `src/config.ts`; the values are the spec's locked decisions.

## Running

Node 22 with type stripping, from `~/.local/node/bin` (the system Node ignores
`--experimental-strip-types`).

```
pnpm --filter @atwood/errand test
pnpm --filter @atwood/errand typecheck
```

Every test runs against a temp folder and fakes: no Twilio request, no model call, no
Telegram message, no write under `~/.sam`.
