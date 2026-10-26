# Errand caller: deploy, tunnel, rollback and restore runbook

Everything here is **staged**. Nothing in this folder has been installed, and no build agent
installs it. Each live step is a GATE run by SAM with Colin, on Colin's go
(`implementation/errand-caller-tickets.md`, T22 to T33).

- Base commit (facts C1): `2ea20b869167128f9623a8f3733cdc79e6354292` on `restyle/glassmorphism`.
- Before figures (facts C2 to C5): `atwood-relay` MainPID 2994863, `/relay` 426, `/api/health` 200,
  `/errand/twiml` on the host-wide rule (port 3001), robot number with no voice URL (OPEN 8: leave it so).
- Never restarted by this build: `atwood-relay`, `receptionist-app-prod`. Restarted once: `receptionist-tunnel` (T23).

## Files

| file | installed as | by |
|---|---|---|
| `atwood-errand.service` | `~/.config/systemd/user/atwood-errand.service` | T22 |
| `errand-prune.service`, `errand-prune.timer` | `~/.config/systemd/user/` | T22 |
| `errand` | `~/.local/bin/errand` (mode 755) | T22 |
| `keystore-rows.tsv` | rows added to `~/.sam/consumer-map.tsv` | T22 |
| `tunnel-rule.yml` | one rule inserted into `~/.cloudflared/receptionist.yml` | T23 |

## T22: GATE: deploy the errand service

1. State to Colin: the commit, the four things installed (unit, prune timer, CLI wrapper, keystore rows),
   and that no existing service restarts. Wait for go.
2. `git rev-parse HEAD` is the T21 commit; core, relay and errand tests and typechecks are green.
3. Back up `~/.sam/consumer-map.tsv` the house way. Add the `keystore-rows.tsv` rows, **matching the live
   map's column layout** (the map is not in the repo; the staged file says so). Run
   `with-secrets --check-wiring` and confirm it is clean for `errand-caller`. The live `with-secrets` is
   `/home/col/.sam/bin/with-secrets` (checked 2026-10-26; the unit and the wrapper use it).
4. Install the unit, the prune service and timer, and `~/.local/bin/errand`.
   `systemctl --user daemon-reload`; `systemctl --user enable --now atwood-errand errand-prune.timer`.
5. Read back: `curl -s -w ' %{http_code}\n' http://127.0.0.1:3003/errand/health` → `{"ok":true} 200`;
   the unit's `ExecMainStartTimestamp`; `atwood-relay` and `receptionist-app-prod` MainPIDs equal facts C2;
   `errand list` runs; `systemctl --user list-timers errand-prune.timer` shows the next run.

## T23: GATE: the errand tunnel rule

Restarting `receptionist-tunnel` drops any live call for a few seconds: do it with no VOLTA call in progress
(check the relay journal for an open session) and no robot batch scheduled.

1. State the rule (`tunnel-rule.yml`) and the restart. Wait for go.
2. Back up `~/.cloudflared/receptionist.yml` (never print it). Insert the rule **before** the host-wide rule.
   `cloudflared tunnel --config ~/.cloudflared/receptionist.yml ingress validate`.
   `systemctl --user restart receptionist-tunnel`.
3. Read back with `cloudflared tunnel --config ~/.cloudflared/receptionist.yml ingress rule <url>`:
   `/errand/twiml`, `/errand/status`, `/errand/ws` → `http://localhost:3003`; `/relay` → 3002;
   `/api/health` and `/errand/health` → the host-wide rule.
4. `curl -s -o /dev/null -w '%{http_code}'`: `/relay` 426, `/api/health` 200 (Done-means 18).
5. Done-means 17 through the public hostname: an unsigned and a wrongly signed POST to `/errand/twiml` and
   `/errand/status`, and an unsigned and a wrongly signed WebSocket upgrade to `/errand/ws`, each 403;
   `/errand/health` from outside is not 200.

## T24 to T33: the live GATEs

- **T24** batch guard live: `systemd-run --user --unit=robot-guardtest-1 sleep 600`; `errand dial <id> --check`
  shows `batch: refused: robot batch: unit robot-guardtest-1.service loaded`; stop it; `--check` shows `batch: pass`.
  No call is created (Dublin GET of calls since step 1).
- **T25** first test errand to Colin's mobile: `errand new`, `errand readback`, Colin confirms the read-back and taps Go,
  `errand dial`. Dublin GET of the call (masked): `from` the robot number, `answered_by` set and equal to the folder's
  `answered` event. Telegram within 2 minutes of Twilio's end time.
- **T26** Colin plays a restaurant (waits, discloses, holds the window, only Colin's details). **T27** a card ask ends
  "payment asked". **T28** voicemail: `answered_by` `machine_end_*`, outcome "voicemail left", Colin hears the message.
- **T29** the record: four end-to-Telegram gaps, every must-do 17 part in T26's folder, SAM answers from `errand status`.
- **T30** isolation: `git diff --stat <base>..HEAD -- apps/relay/src packages/core/src/domain apps/web supabase` empty;
  no tenant `calls`/`messages` rows from the tests (count only); VOLTA and robot numbers read back unchanged; relay PID unchanged.
- **T31** restore one errand folder from the nightly backup (below). **T32** rollback rehearsal (below). **T33** the final report.

## Rollback (T32 rehearses it)

Nothing else changed, so the receptionist needs no rollback.

1. Check no VOLTA call is live. `systemctl --user disable --now atwood-errand errand-prune.timer`.
2. Remove the one errand rule from `~/.cloudflared/receptionist.yml` (restore the T23 backup);
   `ingress validate`; `systemctl --user restart receptionist-tunnel`.
3. Check: `/relay` 426, `/api/health` 200; `errand dial <test id> --check` → `health: refused: errand service down`.
4. To restore after the rehearsal: re-add the rule, restart the tunnel, `systemctl --user enable --now atwood-errand
   errand-prune.timer`; repeat the T23 step 3 read-back and `/errand/health` 200.

The keystore rows and `~/.local/bin/errand` may stay: without the service every dial refuses with "errand service down".

## Restore an errand folder (T31)

Errand folders live under `~/.sam/work/errand-caller/calls/` and are in the nightly encrypted `sam-backup`
(04:16, "sam state" block). Restore one folder by the backup's own restore path into a scratch folder under `/tmp`,
`sha256sum` every file in both, compare, then remove the scratch folder. The prune timer (04:40) runs after the backup,
so a folder on its last day is in that night's backup before it is removed (retention 90 days, OPEN 12).
