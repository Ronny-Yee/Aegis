---
name: hermes-bridge-powershell
description: Reusable PowerShell/SSH templates for the read-only Hermes bridge and post-breach repo hygiene — read-only remote pull, latest-file scp, secret-scan one-liners, sanitization gate. Plain-English comments per line.
---

# Skill: hermes-bridge-powershell

## Execution boundary

This skill supplies reference templates only. It does not authorize state-changing administration. Templates 1-4 are read-only with respect to Hermes and git history. Template 2 keeps copy/open commands inert and routes the live, separately confirmed flow to `/war-room`. Route any Entra Connect change to `/ad-connect`, which must establish its own target, effect, scope, reversibility, checkpoint, and action-specific exact confirmation.

**Trigger:** `/hermes-bridge-powershell` or "give me the SSH pull snippet", "scan the repo for secrets", "sanitization check" — when you need a vetted, read-only PowerShell/SSH template instead of writing one from scratch.

**Goal:** Hand the operator copy-paste-safe, **read-only** templates with a plain-English comment on every line, following CLAUDE.md PowerShell rules (collapsed `<details>`, no aliases, ⚠️ flag anything destructive).

> Maps to the PowerShell family. These are the reusable patterns templated out of the v8 build session.

---

## ⚠️ Safety note
Templates 1-4 do not mutate Hermes, read credential files, create local files, launch a browser, or rewrite git history. Do not adapt these references into state-changing administration; use the canonical gated command for that action.

## Template 1 — Read-only remote command (ssh-agent auth)
```powershell
# Resolve the target from separately configured placeholder values.
$sshUser = '[HERMES_SSH_USER]'
$sshHost = '[HERMES_HOST]'
# Reject whitespace, option prefixes, shell metacharacters, and malformed account values.
if ($sshUser -cnotmatch '^[A-Za-z_][A-Za-z0-9_.-]{0,63}$' -or $sshHost -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $sshHost.Contains('..')) { throw 'Invalid Hermes SSH target.' }
# Build one data-only OpenSSH destination.
$target = '{0}@{1}' -f $sshUser, $sshHost
# Run one constant read-only command with no TTY or forwarding; authentication stays in ssh-agent.
ssh -T -a -x -o BatchMode=yes -o ClearAllForwardings=yes -o ConnectTimeout=15 $target 'whoami; uptime'
```

## Template 2 — Pull the newest matching file off Hermes (no write-back)
```powershell
# The live selector is a constant remote Python program in scripts/hermes-bridge.ps1.
# It returns one JSON basename that must match the War Room allowlist; raw `ls` output is never an scp operand.
# The live destination is a proved-absent GUID path and copy/open have different exact confirmations.
# PREVIEW ONLY [hermes-bridge-local-copy]: scp @validatedScpArguments
# Start-Process -FilePath $verifiedGuidDestination
# These lines are planning references only. Run operator-only `/war-room`; this template creates and opens nothing.
```

## Template 3 — Secret scan across FULL git history (gitleaks-equivalent, read-only)
```powershell
# Search every commit tree (not just HEAD) for secret patterns; prints commit:file:line.
# Run from a git-bash shell for the $(...) expansion.
# This example uses publicly-documented prefixes that are safe to keep in a sanitized repo;
# ADD your fine-grained-PAT and LLM-API-key prefixes from your PRIVATE security config (don't commit those literals).
git grep -nIE '(ghp_|gho_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)' $(git rev-list --all)
# Find which commit introduced/removed a specific token (pickaxe)
git log --all --oneline -S'<token-prefix>'
```
> ⚠️ This is a **read-only** scan. Do NOT rewrite history to remediate without an explicit operator decision — revoke + rotate the credential first; history purge (filter-repo/BFG) is a separate, deliberate step.

## Template 4 — Sanitization gate before committing handoff/integration content
```powershell
# Must return NOTHING. Any line printed = a leak to fix before you commit.
# Fill the bracketed terms from your peer internals + the secret-prefix ruleset in your PRIVATE config.
$forbidden = '<peer_home>/\.<agent>/|/opt/<agent>|<PEER_IP>|<peer_user>@<peer>|<peer_hostname>|<llm_key_prefixes>|<vcs_token_prefixes>'
Select-String -Path .\path\to\files\* -Pattern $forbidden   # PowerShell-native grep
# (git-bash equivalent: grep -nE "$forbidden" files...)
```

## Template 5 — Entra Connect sync reference

This is intentionally inert. Use `/ad-connect` for a separately reviewed and gated sync action.

```powershell
# PREVIEW ONLY [hermes-bridge-delta-sync]: Start-ADSyncSyncCycle -PolicyType Delta
```

## Notes
- Hermes host/paths stay as `[HERMES_*]` placeholders — resolved at runtime via `~/.ssh/config`.
- For passphrase-encrypted keys: rely on the ssh-agent; do **not** use `-o IdentitiesOnly=yes` (it bypasses the agent). See `/ask-hermes` for the canonical bridge.
- All of these are reference snippets. Reference review never counts as approval to execute a state change.
