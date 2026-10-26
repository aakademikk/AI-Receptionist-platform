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

## T5: errand folder store — DONE

Files (new):
- `apps/errand/src/brief.ts`: `Brief` type (business, number, goal, `goalKind` `table`|`other`, window date/earliest/latest,
  details, contact name/mobile, limits fixed/added); `FIXED_LIMITS` (the guardrails by name); `validateBrief()` returns the stored shape or
  `{field, error}` naming the field (a table needs `details.partySize`; fixed limits filled in when absent, refused if any is dropped);
  `canonicalJson()` (keys sorted at every level) and `briefHash()` (sha256 hex).
- `apps/errand/src/store.ts`: id regex check before any path (`assertErrandId`, `errandDir`); `makeErrandId` (UK local date/time + slug);
  `newErrand` (folder mode 700, non-recursive create so a clash takes `-2`; `brief.json` exclusive; `created` event); `writeBrief` (atomic
  replace + `brief_edited` event); `writeReadback`/`readReadback` (atomic replace); `writeGoUsed` (exclusive `wx`); `appendEvent`
  (`events.jsonl`: time, kind, fields); `appendTranscript` (`transcript.jsonl`: time, speaker `amy`|`them`, words); `writeOutcome` and
  `writeAlert` (exclusive, return false on a second write); readers for each; `listErrands`, `dialledAt`. Files mode 600. Types `Readback`,
  `GoUsed`, `Outcome` (kinds booked / not_booked / voicemail_left / not_reached / ended_early / failed; `limit` payment asked / confused /
  turn cap / maximum length), `Alert`.
- `apps/errand/src/testing/fixtures.ts`: sample brief (Ofcom drama-range numbers only) and temp-folder helper. Test-only.
- `apps/errand/src/brief.test.ts`, `apps/errand/src/store.test.ts`.

Proof:
```
# before (store.ts and brief.ts moved aside):
# tests 9  # pass 7  # fail 2
Cannot find module '/home/user/AI-Receptionist-platform/apps/errand/src/brief.ts'
# after:
# tests 23  # pass 23  # fail 0      typecheck exit 0
```
Tests cover: bad ids refused before any path is built (and nothing created); a table brief without party size fails naming
`details.partySize`; every other field named; the hash is key-order independent and changes on each of ten single-field edits;
`go-used.json`, `outcome.json`, `alert.json` cannot be written twice; a scripted sequence leaves brief, read-back, go, events (status
changes, `answered` with `AnsweredBy`, digits), transcript and outcome in the folder, all mode 600.

Counts: before core 284 / relay 86 / errand 7; after core 284 / relay 86 / errand 23. All typechecks clean.
