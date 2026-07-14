# Pre-Commit Hooks — Safety Scanner

Documentation for `scripts/pre-commit-check.js` — the automated security gate
that runs on every `git commit` in this repo.

---

## What It Does

The pre-commit hook scans every staged file for six classes of issues. Full-tree
mode also includes non-ignored, untracked repair files so a reviewable local
diff cannot fall outside the scan merely because it has not been staged.

| Class | Severity | Effect |
|-------|---------|--------|
| PII (email, phone) | BLOCK | Commit is rejected — must fix before re-committing |
| Hardcoded credentials | BLOCK | Commit is rejected |
| Tenant/org literals | BLOCK | Commit is rejected |
| Operational reconnaissance (privileged paths/SSH targets) | BLOCK | Commit is rejected |
| Dangerous PowerShell / git cmdlets | WARN | Commit proceeds — operator is informed |
| Prompt-injection markers | WARN | Commit proceeds — operator must review |

---

## How It's Installed

The hook is installed in `.git/hooks/pre-commit`:

```bash
#!/bin/sh
node scripts/pre-commit-check.js
```

To install on a fresh clone:

```bash
# PREVIEW ONLY [hook-install-copy]: cp scripts/pre-commit-check.js.hook .git/hooks/pre-commit
# PREVIEW ONLY [hook-install-mode]: chmod +x .git/hooks/pre-commit
```

These installation lines are inert examples. Inspect the current destination and proposed hook source, require a no-clobber plan, and obtain a separate, repository-specific local-write approval before applying either change.

The following is the proposed hook **content template only**. It does not authorize creating or replacing `.git/hooks/pre-commit`; any manual installation follows the same destination inspection, no-clobber plan, and separate local-write approval above.

```bash
#!/bin/sh
node scripts/pre-commit-check.js
```

---

## Scan Details

### PII Patterns (BLOCK)

Applied to all non-binary, non-backup files:

```javascript
// Real email addresses — all DNS-style domains; only canonical placeholders
// and the scanner's explicit example/operational allowlist are exempt.
/\b[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,63}\b/gi

// Phone number patterns
/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g
```

**No line-level exclusion:** arbitrary bracketed text never exempts a line. The
scanner masks only the exact canonical `[USER@DOMAIN.COM]` and `[PHONE_NUMBER]`
tokens before checking the corresponding data class.

### Credential Patterns (BLOCK)

Applied to all non-binary files:

```javascript
// Variable assigned a string value containing password/secret/token/key/cred
/\$\w*(password|secret|token|key|cred)\w*\s*=\s*["'][^"']{4,}["']/i

// Telegram bot token format
/BOT_TOKEN\s*=\s*["'][0-9]+:[A-Za-z0-9_-]{35}["']/

// Generic API token (32+ char : 27+ char)
/\b[A-Za-z0-9]{32,}:[A-Za-z0-9_-]{27}\b/
```

### Dangerous Cmdlet Patterns (WARN)

Applied to `.ps1` and `.md` files. The narrow reference surfaces `CLAUDE.md`,
`README.md`, and lessons files are excluded from warning matching only; they are
still scanned for blocking data. Operational command documentation remains in
scope and is also checked by the structural state-change inventory tests.

Full list of flagged patterns:

| Pattern | Risk |
|---------|------|
| `Remove-Item -Recurse -Force` | Mass file/directory deletion |
| `Remove-Item ... -Force` | Forced file deletion |
| `Remove-Mg*` | Graph API deletion (users, groups, devices) |
| `Remove-Mailbox` | Permanent mailbox deletion |
| `Remove-MailboxPermission` | Mailbox access revocation (not mailbox deletion) |
| `Clear-MgDeviceManagementManagedDevice` / `Invoke-MgRetireDeviceManagementManagedDevice` | Managed-device wipe / retire |
| `Delete-QuarantineMessage` / `Release-QuarantineMessage` | Quarantine deletion / recipient-scoped or broad release |
| `Remove-BlockedSenderAddress` | Re-enables a restricted sender |
| `Remove-ADGroupMember` / `Remove-PnPGroupMember` | AD / SharePoint access revocation |
| `Update-MgUser ... -AccountEnabled:$false` / `-PasswordProfile` | Cloud sign-in block / cloud password reset |
| `Set-ADAccountPassword ... -Reset` | On-premises password reset |
| `Invoke-MgInvalidateUserRefreshToken` | Refresh-token invalidation |
| `Set-MgUserLicense` | License assignment change |
| `New-ADUser` / `New-Mailbox` / `New-DistributionGroup` | Identity, mailbox, or distribution-group creation |
| `Add-MailboxPermission` / `Add-RecipientPermission` / `New-MgGroupMember` | Permission or membership grant |
| `Start-ADSyncSyncCycle` | Directory synchronization trigger |
| `New/Update-MgIdentityConditionalAccessPolicy` | Conditional Access policy mutation |
| `Set-SPOSite` / `Grant-CsTeams*Policy` | SharePoint setting or Teams policy mutation |
| `New-MgDeviceManagementDeviceCompliancePolicyAssignment` | Compliance-policy assignment |
| `Set-Mailbox ... -Type Shared` | Mailbox conversion |
| `Install-Module` | PowerShell module installation (SR-2) |
| `Format-Volume` / `Format-Drive` | Destructive storage format; output-only `Format-Table` and `Format-List` are not flagged |
| `Clear-Mailbox` | Wipes mailbox contents |
| `Clear-MobileDevice` | Remote device wipe |
| `Disable-Mg*` / `Disable-ADAccount` | Account/object disable |
| Provider cmdlets beginning `Revoke-Mg`, `Revoke-AzureAD`, `Revoke-SPO`, `Revoke-PnP`, or `Revoke-Cs` | Session/token revocation; arbitrary `Revoke-*` prose is not flagged |
| `BlockCredential $true` | Blocks user sign-in |
| `Invoke-Expression` / `IEX` | Arbitrary code execution |
| `Start-Process -FilePath` | Arbitrary process launch |
| `ConvertTo-SecureString -AsPlainText -Force` | Plaintext credential in script |
| `git push --force` / `git push -f` | Can overwrite remote history |
| `git reset --hard` | Destroys uncommitted work |
| `git commit --no-verify` | Bypasses the pre-commit safety gate |
| `jira-client.js ... --execute` | External Jira API boundary |
| `init-memory.js ... --execute` / `security-audit.js ... --write` | Local filesystem mutation |
| `scp` / `sftp` | Local or remote file transfer |
| Writes or mode changes under `.git/hooks/` | Repository-local executable change |
| Dynamic `$ssh ... $remoteCommand` invocation | Remote command boundary |

---

## Output Format

### Clean
```
pre-commit-check: ✓ Clean — no issues found.
```

### Blocked
```
╔══════════════════════════════════════════════╗
║  Aegis Pre-Commit Safety Check               ║
╚══════════════════════════════════════════════╝

  scripts/my-script.ps1
    🔴 BLOCK  Line 14: Real email address detected (use [USER@DOMAIN.COM] placeholder)
           → Connect-MgGraph -Scopes "User.Read.All" -AccountId "[USER@DOMAIN.COM]"

🔴 COMMIT BLOCKED — 1 critical issue(s) found.
   Fix the issues above, then re-stage and commit.
   Do not bypass the hook. Fix the finding, re-stage, and run the scanner again.
```

### Warning (commit proceeds)
```
╔══════════════════════════════════════════════╗
║  Aegis Pre-Commit Safety Check               ║
╚══════════════════════════════════════════════╝

  scripts/offboard-user.ps1
    ⚠️  WARN  Line 32: Disable-* — account/object disable
           → Disable-ADAccount -Identity $user.SamAccountName

⚠️  1 warning(s) found — review the flagged lines above.
   These are dangerous cmdlets in scripts. Confirm they are intentional.
   Commit will proceed. Add a ⚠️ comment in the script to acknowledge.
```

---

## How to Extend the Scanner

### Adding a New PII Pattern

In `scripts/pre-commit-check.js`, add to the `PII_PATTERNS` array:

```javascript
const PII_PATTERNS = [
  // ... existing patterns ...
  {
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,  // US Social Security Number
    label: 'SSN pattern detected (use [SSN] placeholder)'
  },
];
```

### Adding a New Dangerous Cmdlet

In `scripts/pre-commit-check.js`, add to the `DANGEROUS_PS_PATTERNS` array:

```javascript
const DANGEROUS_PS_PATTERNS = [
  // ... existing patterns ...
  {
    pattern: /Remove-MgDevice/i,
    label: 'Remove-MgDevice — permanently deletes device from Entra'
  },
];
```

### Coverage reductions are security-control changes

Do not add file extensions or documentation paths to an exclusion as the normal response to a warning. First narrow an over-broad matcher by semantics and add a regression fixture proving that the real dangerous form still warns. A truly required coverage reduction needs an explicit operator decision naming the exact path/type and the blind spot it creates; it must ship with a deterministic test for the remaining coverage.

---

## Testing the Scanner

```bash
# Run against all currently staged files
node scripts/pre-commit-check.js

# Run the deterministic in-memory scanner fixtures; they do not stage or leave a credential-shaped file
node --test scripts/pre-commit-check.test.js

# Scan tracked plus non-ignored untracked working-tree files (CI/release gate)
node scripts/pre-commit-check.js --all
```

---

## False Positives

The scanner occasionally flags legitimate content. Common cases:

| False positive | Cause | Resolution |
|---------------|-------|-----------|
| Example password in docs | Credential pattern in a code block | Replace it with the canonical `[TEMP_PASSWORD]` placeholder and rerun the scanner |
| External email in vendor template | PII pattern | Replace it with `[USER@DOMAIN.COM]` |
| An actual provider `Revoke-*` cmdlet in an IR playbook | Session/token mutation in a `.md` file | Keep the warning and add the required command-local gate; do not exclude the file |
| API token format in docs | Credential pattern | Use the canonical credential placeholder from `shared/security/placeholder-dict.md` |
