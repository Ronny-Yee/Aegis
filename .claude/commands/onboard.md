---
description: Alias for /new-user — full onboarding deep flow (AD → sync → license → MFA → mail/groups → apps → devices → site/facilities → wrap-up). Placeholders only.
disable-model-invocation: true
---

# /onboard

## Execution boundary

This alias is routing-only. It cannot authorize or execute any onboarding action. Invoke the canonical `/new-user` command; each state change there must independently resolve its target and pass its own action-specific exact confirmation. Approval of this alias or of an onboarding plan is not execution approval.

Full new-user onboarding is owned by **/new-user** — the canonical 26-step deep flow built from the operator's real checklist (gold-standard format per `docs/command-output-standard.md`, Variant A). Use that command: same placeholders, same admin gates, same verification discipline.

This alias exists so `/onboard` can never serve a stale generic copy again (2026-06-09 drift lesson). When invoked, deliver the `/new-user` runbook.
