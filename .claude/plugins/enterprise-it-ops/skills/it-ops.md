---
description: Provide placeholder-only enterprise IT operations guidance for Microsoft 365, Entra, Intune, Meraki, VoIP, Jira, automation, and documentation tasks.
disable-model-invocation: true
---

# [@Aegion] IT Ops — Skill Knowledge Base

## Execution boundary

This knowledge base is planning/reference only and cannot authorize or perform a state change. For execution, invoke the exact canonical command listed below. That command must independently show the resolved target, effect, scope, reversibility, checkpoint/rollback, and an action-specific exact confirmation immediately before its one action. Generic approval such as `yes`, `proceed`, or approval of a plan is never sufficient.

## Environment

| Item | Detail |
|------|--------|
| Tenant | [@Aegion_DOMAIN] |
| Users | [@Aegion_SIZE] on M365 Business Premium |
| Identity | Hybrid AD + Entra Connect sync (create users in on-prem AD first) |
| Devices | Windows (majority), few Macs, iPhones, Android (Moto G), MDM work phones |
| MDM | Intune — iOS, Android, Windows |
| Network | Cisco Meraki MX firewall + MR access points across multiple office sites |
| ISP | [@Aegion_ISP] |
| WAN | [@Aegion_WAN] (main ↔ [@Aegion_SITE_2]) → migrating to Meraki site-to-site VPN |
| Remote access | [@Aegion_REMOTE_ACCESS] (temp) + Client VPN for remote workers |
| VoIP | [@Aegion_VOIP] — migrated from [@Aegion_VOIP_LEGACY]; [@Aegion_SITE_2] + [@Aegion_SITE_3] still in progress |
| Security | [@Aegion_ALARM] — upgrading to internet-based |
| Ticketing | Jira Service Management (cloud, 2026) |
| MFA | Microsoft Authenticator + SMS fallback |

**Device naming:** DT-FirstName,LastName (desktop) · LT-FirstName,LastName (laptop)

**Admin portals:**
- admin.microsoft.com
- entra.microsoft.com
- intune.microsoft.com
- portal.azure.com
- security.microsoft.com
- admin.exchange.microsoft.com

---

## Active Projects (2026)

| Project | Status | Key Detail |
|---------|--------|-----------|
| VoIP migration — [@Aegion_SITE_2] + [@Aegion_SITE_3] | In progress | [@Aegion_NETPARTNER] handles cabling |
| P2P → Site-to-site VPN | In progress | [@Aegion_REMOTE_ACCESS] still running; Meraki S2S is the target |
| [@Aegion_ALARM] upgrade | Planning | Tie to VoIP migration — eliminate [@Aegion_ISP] landlines |
| Aegis | Active | GitHub repository URL supplied at runtime |
| Jira Service Management | In progress | 2026 rollout — DevOps / Get IT Help space |

---

## Response Rules

- Portal/admin center steps FIRST — PowerShell in `<details>` collapse blocks
- ⚠️ on anything destructive (wipe, delete, disable, remove, reset)
- Require an action-specific exact confirmation immediately before each destructive action
- Placeholders only — never real employee names, emails, or UPNs
- Short bullets, clear headers, phone-readable
- Plain-English comment on every PowerShell line

---

## Placeholder Standards

| Placeholder | Use for |
|-------------|---------|
| `[FIRST_NAME]` | User's first name |
| `[LAST_NAME]` | User's last name |
| `[UPN]` | User principal name (email) |
| Department (sanitized description) | Do not include a real organization-specific name |
| `[MANAGER_NAME]` | Manager's name |
| `[UPN]` | Manager's UPN when that context is explicitly needed |
| `[DEVICE_NAME]` | Device hostname |
| `[USER@DOMAIN.COM]` | IT admin UPN |

---

## Common Procedures — Canonical Routes

This skill deliberately contains no executable or portal mutation procedure.

| Intended operation | Canonical command |
|---|---|
| New-user onboarding | `/new-user` |
| Offboarding | `/offboard` |
| Entra Connect sync | `/ad-connect` |
| MFA method reset or session revocation | `/mfa-issue` |
| Password reset | `/password-reset` |
| Quarantine release or deletion | `/email-quarantine` |
| Device wipe or retire | `/device-wipe` |
| Shared mailbox creation or conversion | `/shared-mailbox` |
| Mailbox delegation | `/mailbox-permissions` |
| Group or distribution-list changes | `/group-membership-audit` or `/distribution-list` |
| SharePoint or Teams access | `/sharepoint-access` or `/teams-issue` |
| Conditional Access change | `/conditional-access` |
| License change | `/license-audit` |

Session revocation requests invalidation of Entra refresh tokens and browser cookies after propagation. Current access tokens and app-issued sessions may persist until expiry or until the application enforces revocation.

---

## Server Infrastructure

- **AD Connect server** — syncs on-prem AD → Entra ID
- **[@Aegion_FINANCE_SERVER]** — Windows Server for finance/accounting
- **Third tower** — unknown purpose; check with senior IT

---

## Escalation Templates

**Vendor:**
> State the issue, sanitized user/site impact, start time, and approved vendor case reference. Request Tier 2 escalation and a resolution timeline.

**Microsoft:**
> Use [@Aegion_DOMAIN] and [USER@DOMAIN.COM], then state the issue, sanitized impact, start time, and troubleshooting already completed.

**Internal:**
> Hi [FIRST_NAME], I'm working on a ticket and need one detail before I can continue. Summarize the situation, completed steps, and specific blocker without real identities.
