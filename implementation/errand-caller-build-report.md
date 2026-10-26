# Errand caller: build report (T21)

Written 2026-10-26 by the cloud build session, on branch `cloud/errand-caller` (cut from `origin/restyle/glassmorphism`).
The per-ticket detail, raw proof output and the list of claims owed to SAM are in
[errand-caller-report-20261026.md](errand-caller-report-20261026.md).

## 1. Suites (Node v22.22.0, pnpm 10.33.0)

| suite | tests | pass | fail | typecheck | T4 baseline |
|---|---|---|---|---|---|
| core (`@atwood/core`) | 284 | 284 | 0 | clean | 284 |
| relay (`@atwood/relay`) | 86 | 86 | 0 | clean | 86 |
| errand (`@atwood/errand`) | 243 | 243 | 0 | clean | (new) |
| web (`@atwood/web`) | typecheck only | | | clean (exit 0) | |

Core and relay equal the T4 baseline. The relay suite has a pre-existing real-clock flake (`frame probe > probe one sends the first part at once
and the last part at 4,000 ms`, about 1 run in 6, `msSincePromptFinal` 1 against 0); it is not caused by this build (`apps/relay` is unchanged)
and was not touched (out of bounds).

## 2. Boundary diff (code half of Done-means 16)

```
$ git diff --stat 2ea20b869167128f9623a8f3733cdc79e6354292..HEAD -- apps/relay/src packages/core/src/domain apps/web supabase
(no output)
```
Everything outside `apps/errand` that changed since the base commit: `implementation/errand-caller-facts.md` (SAM's T1-T3 commit, before this build),
`implementation/errand-caller-report-20261026.md` (new), `implementation/errand-caller-tickets.md` (only the `Status:` lines of T4 to T21) and
`pnpm-lock.yaml` (+19 lines: the new `apps/errand` importer). `packages/core` and `apps/relay` as a whole are unchanged.

## 3. Mutation check (Done-means 2, T11 step 5 re-run)

`checkGo` replaced by one that returns ok, errand suite run, `go.ts` restored from a copy:
```
--- mutated run:  # tests 243  # pass 220  # fail 23
    not ok 1 - no go: zero creates and the reason
    not ok 2 - a go for a brief edited after read-back: zero creates
    not ok 3 - an expired go: zero creates
    not ok 4 - a used go: the second dial on the same errand gives zero creates (must-do 18)
    (+ 2 CLI dial tests, 1 dial --check test, 16 go.test.ts tests)
--- restored: git diff --stat src/go.ts -> empty (identical to the committed code)
# tests 243  # pass 243  # fail 0
```

## 4. Commits

On `cloud/errand-caller`, pushed after every ticket (this session's instructions replace the tickets file's "commit on `restyle/glassmorphism`,
no push"). The Atwood gate (`gate-prepush` / `gate-detector`) is not in the cloud container and was not run; SAM runs it before any merge.

| ticket | commit |
|---|---|
| T4 | `8df8930` |
| T5 | `e8c3424` |
| T6 | `fcaa710` |
| T7 | `0d09722` |
| T8 | `4528745` |
| T9 | `3fcf77f` |
| T10 | `13aa262` |
| T11 | `acfd40b` |
| T12 | `f23d294` |
| T13 | `510e51f` |
| T14 | `95c5965` |
| T15 | `7f13e87` |
| T16 | `05bf6a8` |
| T17 | `0d9fb3f` |
| T18 | `f587692` |
| T19 | `758b4c3` |
| T20 | `075e1d9` (last code commit; the deploy GATE T22 deploys this tree or a later one SAM confirms) |
| T21 | the commit that adds this file (reports and status lines only) |

Nothing was deployed, restarted, merged or opened as a PR. No Twilio request, model call, Telegram, push, systemd, tunnel, keystore or database change.
