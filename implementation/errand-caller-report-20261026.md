# Errand caller build report (T4-T21), 2026-10-26

Branch `cloud/errand-caller`, cut from `origin/restyle/glassmorphism`.

## Baseline (branch as found, before T4)

Node v22.22.0 (`/opt/node22/bin`; `~/.local/node/bin` does not exist in this container), pnpm 10.33.0, `pnpm install --frozen-lockfile`.
HEAD at cut: `90bb6db` (facts commit) on top of the spec base `2ea20b8`.

| suite | tests | pass | fail | typecheck |
|---|---|---|---|---|
| core | 284 | 284 | 0 | clean |
| relay | 86 | 86 | 0 | clean |

These match the last recorded counts (core 284, relay 86).

Pre-existing flake found during T4 (not caused by this build; `apps/relay` is never touched): relay's
`frame probe > probe one sends the first part at once and the last part at 4,000 ms`
(`apps/relay/src/protocol.test.ts:813`) fails about 1 run in 6 with `msSincePromptFinal: 1` against an expected `0`
(a real-clock millisecond tick). The count stays 86; every recorded relay run below is a passing run, and any flaky
run is noted where it happened.

## Conflicts between the tickets file and this session's instructions

- The tickets file says "Branch: `restyle/glassmorphism` ... No push" and T21 says "Commit on `restyle/glassmorphism` ... No push".
  This session's instructions override that: work is on `cloud/errand-caller` (cut from `origin/restyle/glassmorphism`) and is pushed after every ticket.
- The tickets' commits "go through the Atwood gate (`gate-prepush` / `gate-detector`)". Neither tool exists in this container; commits are plain `git commit`. SAM should run the gate over the branch before it is merged.

## T4: package scaffold, locked values, boundary test — DONE

Files (all new):
- `apps/errand/package.json`: `@atwood/errand`, ESM, scripts `start`/`test`/`typecheck` as the relay; deps `@atwood/core` (workspace), `ws`.
- `apps/errand/tsconfig.json`: copy of the relay's, comment adjusted.
- `apps/errand/src/config.ts`: every locked value as a named, commented constant (`ROBOT_NUMBER`, `GO_EXPIRY_MS`, `TURN_CAP`,
  `RING_TIMEOUT_S`, `MAX_CALL_S`, `CONFUSED_LIMIT`, `MODEL_TIMEOUT_MS`, `CALL_CREATE_TIMEOUT_MS`, `OUTCOME_REPORT_MS`, `NO_OUTCOME_ALERT_MS`,
  `RETENTION_DAYS`, `CALLING_HOURS`, `OPENING_LINE`, `VOICE_ID`, `ERRAND_MODEL` = `gemini-3.8-flash` / `ERRAND_EFFORT` = `low` (facts B6),
  `MACHINE_DETECTION`, `ERRAND_PORT`, plus the VOLTA voice attributes from facts B5 and the endpoint paths). Paths are functions read at call
  time with env overrides: `errandHome()` (`ERRAND_HOME`), `jobStore()` (`SAM_JOB_STORE`), `notifyBin()` (`ERRAND_NOTIFY_BIN`),
  `pushLog()` (`ERRAND_PUSH_LOG`). `requireTwilioBase()` throws when `TWILIO_API_BASE_URL` is unset, blank, not a URL, or names the global host.
  `maskSid()` (first 4, last 4).
- `apps/errand/src/boundary.test.ts`: walks `src`; imports are an allow-list (`node:*`, `ws`, `@atwood/core/integrations/twilio`,
  `@atwood/core/ai`, relative paths that stay inside `apps/errand`); refuses the core root, every other core subpath, `@supabase/*`, relay and web.
  Non-test source may name the global Twilio host only in `config.ts`, and may never set a `Record` parameter. Plus `requireTwilioBase` tests.
- `apps/errand/README.md`: what the package is and the four entry points.
- `pnpm-lock.yaml`: +19 lines from `pnpm install` (the new importer only).

Proof:
```
$ pnpm --filter @atwood/errand test        # tests 7, pass 7, fail 0
$ pnpm --filter @atwood/errand typecheck   # exit 0
# mutation: sed -i "1i import '@atwood/core/domain';" apps/errand/src/config.ts
        0: 'config.ts: core subpath not allowed: @atwood/core/domain'
# tests 7
# pass 6
# fail 1
# reverted (cp from backup): pass 7, fail 0
```
Counts: before core 284 / relay 86 / errand (none); after core 284 / relay 86 / errand 7. Typechecks clean.
