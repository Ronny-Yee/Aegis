---
description: Create one new, non-colliding War Room dashboard artifact on Aegis D Hermes through the hardened bridge.
disable-model-invocation: true
---

# /dashboard-render

## Risk metadata

- **Risk level:** R1 remote write - creates one new dashboard artifact only after exact confirmation; automatic local logging is disabled.
- **Access:** credential-sensitive remote execution and one no-clobber remote write.
- **Credential-sensitive:** yes - uses the operator's SSH agent and never reads or prints key material.
- **Invocation:** operator-only; Claude must not invoke this command automatically.

Use `/dashboard-render` for today or `/dashboard-render YYYY-MM-DD` for one exact trading date.

## Safety boundary

The renderer is a remote state mutation. This path is R1 only when the expected `war_room_YYYYMMDD.html` destination does not already exist. The hardened wrapper atomically reserves that final name with exclusive no-follow creation; an existing file, link, or concurrent creator wins with exit `73`. The renderer must populate the same invocation-owned inode, so the check cannot become an overwrite of a pre-existing path. Overwriting a same-date dashboard is a separate R2 action requiring a checkpoint and a distinct `OVERWRITE` confirmation, and is not implemented here.

The wrapper also refuses an unknown renderer interface. The earlier “run it bare if `--date` is unsupported” fallback is removed because it would break the confirmed date and destination binding.

## Execution contract

1. Accept zero or one argument. Default locally to today; reject additional arguments.
2. Validate an explicitly supplied value with invariant `DateTime.TryParseExact('yyyy-MM-dd')` and exact round-trip. Do not trim an invalid supplied date.
3. Derive exactly one expected basename from the validated date.
4. Send date and validated remote directories as Base64-encoded JSON on SSH stdin to a constant Python wrapper.
5. Display the date, expected basename, scope, reversibility, and action SHA-256. The digest binds the target and full structured request, including both remote directories. Require the exact phrase emitted by the bridge.
6. Before running the renderer, the remote wrapper atomically reserves the final path with `O_CREAT|O_EXCL|O_NOFOLLOW` and invokes Python with an argv list, never a shell-built command.
7. Claim success only when SSH exits zero and the exact expected artifact is the same reserved, regular, non-symlink, nonempty file.

<details>
<summary>PowerShell - operator-invoked R1 render</summary>

```powershell
# Resolve the repository without relying on a fixed local path.
$repoRoot = git rev-parse --show-toplevel
# Use the reviewed bridge that owns validation, the exact gate, no-clobber behavior, and read-back.
$bridge = Join-Path $repoRoot 'scripts\hermes-bridge.ps1'
# Permit no argument or one exact date; anything else stops before the bridge.
if ($args.Count -gt 1) { throw 'Use /dashboard-render or /dashboard-render YYYY-MM-DD.' }
# Preserve an explicitly supplied date exactly; the bridge validates it with TryParseExact.
$date = if ($args.Count -eq 1) { [string]$args[0] } else { Get-Date -Format 'yyyy-MM-dd' }
# Derive the visible target without contacting Hermes.
$expectedName = 'war_room_{0}.html' -f $date.Replace('-', '')
# Keep the committed target symbolic; the bridge binds the resolved private target to a second action digest.
$targetLabel = '[HERMES_HOST]'
# SAFETY GATE [dashboard-render-artifact]
# Target: $targetLabel and $expectedName for $date.
# Effect: Creates one new remote dashboard artifact and refuses an existing destination.
# Scope: Exactly one date and one expected filename; no overwrite and no retry.
# Reversibility: Removing the exact artifact is a separate destructive action requiring new approval.
$requiredConfirmation = "CREATE WAR ROOM DASHBOARD $date AT $expectedName ON $targetLabel"
$confirmation = Read-Host "Type exactly: $requiredConfirmation"
if ($confirmation -ceq $requiredConfirmation) {
    # The bridge repeats confirmation against a digest of the resolved private target before SSH.
    & $bridge -Action Render -Date $date -SshUser '[HERMES_SSH_USER]' -SshHost '[HERMES_HOST]' -ScriptsDir '[HERMES_SCRIPTS_DIR]' -DeliveryDir '[HERMES_DELIVERY_DIR]'
}
else {
    throw 'Exact dashboard-render confirmation did not match; no renderer was run.'
}
```

</details>

Required confirmation shape:

`CREATE WAR ROOM DASHBOARD <YYYY-MM-DD> ACTION SHA256 <resolved-action-sha256>`

Empty input, generic `yes`, case changes, added whitespace, or a hash mismatch means no renderer runs.

## Verification and undo

- **R1 remote write:** one previously absent `war_room_YYYYMMDD.html` only.
- **Undo:** removal of that exact artifact is destructive and must be proposed as a separate exact-path action; this command never performs cleanup automatically.
- A failed renderer may leave a partial artifact. Report its expected basename and stop; do not delete or retry automatically.
- The command does not deliver to Telegram, place trades, edit configuration/cron, or restart a service.

## Local audit record

Automatic append to `.aegis-state/hermes-escalation-log.md` is **PREVIEW ONLY**. Return this proposed record without writing it:

`[YYYY-MM-DD HH:MM:SS] /dashboard-render <date> -> <RENDERED name|FAILED code|UNREACHABLE>`

Any future append requires a separate exact local-write gate.
