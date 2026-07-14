# Automation Module

PowerShell patterns, safety guardrails, and CI/CD tooling for IT operations automation.

## Contents

| File | Purpose |
|------|---------|
| [powershell/examples.md](powershell/examples.md) | Reusable PS scripts for M365, Intune, and AD operations |
| [powershell/safety_patterns.md](powershell/safety_patterns.md) | Defensive coding patterns, WhatIf, dry-run, rollback |
| [cicd.md](cicd.md) | Git workflow, branch strategy, and automation pipeline for this repo |
| [pre_commit_hooks.md](pre_commit_hooks.md) | How the pre-commit safety scanner works and how to extend it |
| [scripts/deploy-check.js](scripts/deploy-check.js) | Pre-deployment checklist validator — reads checklist.json, validates conditions |
| [scripts/checklist.json](scripts/checklist.json) | Sample deployment checklist with file, command, and env var checks |

## Design Principles

**Automation in IT ops is high-stakes.** A script that iterates over [@Aegion_SIZE] users and
removes licenses, disables accounts, or modifies group membership can cause irreversible
damage in seconds if written carelessly. These principles govern every script in this repo:

1. **WhatIf first** — any script that modifies more than one object must support `-WhatIf`
   to show what it *would* do before it does anything. Run WhatIf, review the output,
   then run for real.

2. **Dry run by default** — scripts that affect >10 objects default to `$DryRun = $true`.
   Setting `$DryRun = $false` is only a mode selection, never authorization. A live run also needs an independently predicted count, immutable reviewed target set, off-repo pre-state checkpoint, and action-specific exact confirmation.

3. **Audit trail** — every bulk operation uses collision-resistant, no-clobber records outside the repository under the approved local application-data path. Identity/tenant state and operation logs are never written into tracked paths.

4. **Recovery plan** — reversible disable/assignment changes capture exact immutable pre-state and a separately reviewed inverse before execution. Irreversible deletion/wipe has no rollback script: capture evidence and verified backup/retention facts, prefer a reversible sibling, and require the strongest target-bound gate.

5. **Pre-commit scanning** — the pre-commit hook catches PII, credentials, and dangerous
   cmdlets before they reach the repo. See [pre_commit_hooks.md](pre_commit_hooks.md).

## Quick Reference — Modules Required

The table names required modules but contains no runnable install command. Use the listed canonical route, which must show the exact module and CurrentUser scope and require its concrete case-sensitive phrase; any other response stops without installing.

| Task | Module | Canonical route |
|------|--------|-----------------|
| Entra, Intune, M365 users | Microsoft.Graph | Gated local install in `/conditional-access` |
| Exchange mailboxes, mail flow | ExchangeOnlineManagement | Gated local install in `/email-quarantine` |
| On-prem Active Directory | ActiveDirectory (RSAT) | Windows feature; separate operator-owned installation |
| AD Connect | ADSync | Pre-installed on AD Connect server; execution routes to `/ad-connect` |
