---
name: war-room-ops
description: Operating pattern for the Aegis D Hermes war-room bridge, including read-only views, confirmed local copies, and the no-clobber dashboard render.
---

# Skill: war-room-ops

**Trigger:** `/war-room-ops` or “war room”, “dashboard”, “morning brief”, “portfolio snapshot”, “alpha signal”, or “is Hermes up”.

**Goal:** Surface Hermes outputs safely while keeping finance in Hermes's lane and every real local/remote effect accurately classified.

## Command family

| Command | What it does | Effect boundary |
|---|---|---|
| `/war-room` | Open the latest dashboard | Constant remote selector, then separately confirmed strict local copy and browser launch; or one validated URL launch |
| `/morning-brief` | Print the current brief | Remote read; proposed audit line is preview-only |
| `/portfolio-status` | Show the current holdings snapshot | Remote read; proposed audit line is preview-only |
| `/dashboard-render` | Generate one dated dashboard | Confirmed R1 remote write only when the exact destination is absent |
| `/alpha-signal TICKER` | Request a one-line signal | Cache-refresh path is preview-only until exact remote cache effects are documented |
| `/hermes-status` | Check SSH, cron, and render age | Remote read; proposed audit line is preview-only |

## Operating rules

1. **Classify real effects.** `/dashboard-render` is a remote state mutation and refuses a same-date collision. `/war-room` is a remote read followed by independently confirmed local copy/open effects. Never describe either as universally read-only.
2. **Do not hide cache writes.** The alpha-signal skill may refresh a remote cache. Until its exact objects and rollback are verified, that live refresh remains preview-only; use the cached `/portfolio-status` view for read-only context.
3. **Static remote commands only.** User/date/path data travels through validated stdin payloads. Never interpolate it into an SSH command or trust raw `ls` output as an `scp` operand.
4. **Lane discipline.** Surface Hermes output without adding an Aegis trading recommendation. Never place trades, edit cron/configuration, or restart a service.
5. **Placeholder discipline.** Keep host, account, and paths as `[HERMES_*]` placeholders in source and shared output. Never disclose resolved private values.
6. **Authentication boundary.** Use the loaded SSH agent with no TTY, no agent/X11 forwarding, cleared forwarding, and batch authentication. Never read a private-key file.
7. **Fail closed.** Invalid input, a collision, nonzero exit, unexpected output, or confirmation mismatch stops the current phase. Do not broaden a selector or retry automatically.
8. **Audit line is preview-only.** Return a hash-only proposed record. Do not append to `hermes-escalation-log.md` without a separate exact local-write gate.

## Verification

- `/war-room` reports the validated URL or local GUID path plus SHA-256; a copy is not proof that the separate open gate passed.
- `/dashboard-render` reports the exact expected basename, remote exit zero, regular/non-symlink status, and nonzero size.
- Read-only commands report freshness and source timestamp without claiming a local log write.

## Failure triage

| Symptom | First check |
|---|---|
| Brief/dashboard empty | `/hermes-status`; do not fabricate current data |
| SSH authentication failure | `ssh-add -l`; never read or print the key |
| Render collision | Stop; an overwrite requires a separate R2 checkpoint and approval |
| Copy succeeded but open declined | Report the exact local path and hash; leave it unopened |
| Stale cached signal | Report its timestamp; do not silently trigger a refresh |
