---
description: Alias for /shared-mailbox — shared mailbox creation, permissions, and user-to-shared conversion. Placeholders only.
disable-model-invocation: true
---

# /shared-mailbox-create

## Execution boundary

This alias is routing-only. It cannot authorize or execute creation, conversion, or delegation. Invoke the canonical `/shared-mailbox` command; route delegation separately to `/mailbox-permissions`. Each state change must independently resolve its target and pass its own action-specific exact confirmation.

Shared mailbox creation, permission assignment (Full Access, Send As, Send on Behalf), auto-mapping, and user→shared mailbox conversion is fully covered by **/shared-mailbox**. Use that command.
