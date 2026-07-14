---
description: Validate one ticker and prepare a Hermes alpha-signal request without silently authorizing its remote cache refresh.
disable-model-invocation: true
---

# /alpha-signal

## Risk metadata

- **Risk level:** R0 for validation and cached reads; the live alpha-signal skill is preview-only because its remote cache-write scope is not documented.
- **Access:** local validation and a route to the read-only cached portfolio view; no live remote refresh and no local log write.
- **Credential-sensitive:** a future live refresh would use the SSH agent, but this command does not invoke it.
- **Invocation:** operator-only; Claude must not invoke this command automatically.

Use `/alpha-signal [TICKER]` to validate one ticker and prepare a one-line signal request. Validation is strict: uppercase 1-5 letters with an optional one-letter class suffix.

```powershell
# Preserve only one ticker token and normalize its case.
$ticker = ($args -join ' ').Trim().ToUpperInvariant()
# Reject empty, broad, option-like, and shell-bearing values.
if ($ticker -cnotmatch '^[A-Z]{1,5}(?:\.[A-Z])?$') { throw 'Give one valid ticker, for example [TICKER].' }
```

**PREVIEW ONLY [alpha-signal-cache-refresh]:** The `alpha-signal-brief` skill may refresh news/price cache objects on Hermes. Their count, exact paths, prior state, and rollback are not documented in this repository, so the live SSH call is not authorized here. Do not relabel that side effect “read-only” or run the old interpolated `hermes -z` command.

For a genuinely read-only view, use `/portfolio-status`, which reads the last cached signal and shows its timestamp. If a fresh signal is required later, first inventory the cache objects and reversibility, then add an action-specific gate. The future transport must use the static-stdin bridge in `scripts/hermes-bridge.ps1`; ticker data must never be interpolated into a remote command.

Required confirmation shape for a future reviewed refresh:

`REFRESH HERMES ALPHA CACHE FOR <TICKER> ACTION SHA256 <resolved-target-and-cache-set-sha256>`

That phrase is documentation only until the cache set and rollback are known. It does not authorize execution.

## Output boundary

Cached output remains Hermes financial analysis, not an Aegis recommendation. Show its source timestamp, do not fabricate a missing signal, and never forward it beyond the operator.

## Proposed audit line

Automatic append to `.aegis-state/hermes-escalation-log.md` is **PREVIEW ONLY**. Return without writing:

`[YYYY-MM-DD HH:MM:SS] /alpha-signal <TICKER> -> PREVIEW-NO-REFRESH`
