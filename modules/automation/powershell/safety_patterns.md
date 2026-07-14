# PowerShell Safety Patterns

Defensive patterns for writing IT automation scripts that are safe to run in production.
These patterns prevent the most common causes of accidental bulk damage in M365 and AD.

---

## Pattern 1 — WhatIf Before Every Destructive Operation

PowerShell's built-in `-WhatIf` parameter shows what a command *would* do without
executing it. Use it on the first run of any destructive operation.

```powershell
# Show what would be disabled — does nothing
Disable-ADAccount -Identity "[USERNAME]" -WhatIf

# Show what would be removed — does nothing
Remove-ADGroupMember -Identity "[GROUP]" -Members "[USERNAME]" -WhatIf

# Only after reviewing WhatIf output, run for real:
# SAFETY GATE [safety-whatif-disable]
# Target: [USERNAME]
# Effect: disables one reviewed AD account
# Scope: one exact sAMAccountName
# Reversibility: reversible through a separately reviewed Enable-ADAccount action
$requiredConfirmation = "DISABLE [USERNAME]"
$confirmation = Read-Host "Type '$requiredConfirmation' to confirm"
if ($confirmation -ceq $requiredConfirmation) {
    Disable-ADAccount -Identity "[USERNAME]" -ErrorAction Stop
    $readBack = Get-ADUser -Identity "[USERNAME]" -Properties Enabled -ErrorAction Stop
    if ($readBack.Enabled) { throw "Disable returned but read-back still shows enabled." }
} else {
    throw "Confirmation did not match. No change was made."
}
```

**Rule:** If the cmdlet supports `-WhatIf`, use it on the first run. If it doesn't,
write a dry-run guard (see Pattern 2).

---

## Pattern 2 — Dry Run Flag for Bulk Operations

For scripts that loop over multiple objects, use a `$DryRun` flag that defaults to `$true`.
Changing it to `$false` selects live mode but is never authorization; the checkpoint and remote-action gates below are still mandatory.

```powershell
# ---- CONFIGURATION ----
$DryRun = $true  # ← Change to $false only after reviewing dry-run output
$expectedCountText = Read-Host "Enter the independently approved expected user count"
$expectedCount = 0
if (-not [int]::TryParse($expectedCountText, [ref]$expectedCount) -or $expectedCount -le 0) {
    throw "Expected count must be a positive integer. No change was made."
}

# ---- OPERATION ----
$usersToDisable = @(Get-ADUser -Filter "Department -eq '[DEPARTMENT]'" -SearchBase "OU=Users,DC=..." -Properties Enabled,ObjectGuid,UserPrincipalName -ErrorAction Stop)
if ($usersToDisable.Count -eq 0) { throw "No users were staged. No change was made." }
if ($usersToDisable.Count -ne $expectedCount) {
    throw "Expected $expectedCount users but staged $($usersToDisable.Count). Review the filter; no change was made."
}
Write-Host "Staged users in [DEPARTMENT]: $($usersToDisable.Count)"
$usersToDisable | ForEach-Object { Write-Host "  target: $($_.SamAccountName); GUID: $($_.ObjectGuid); enabled: $($_.Enabled)" }
if (@($usersToDisable.ObjectGuid | Sort-Object -Unique).Count -ne $expectedCount) {
    throw "Staged identities contain duplicate immutable IDs. No change was made."
}
$usersToDisable = @($usersToDisable | Sort-Object ObjectGuid)
$disableTargetManifest = @($usersToDisable | ForEach-Object { "$($_.ObjectGuid)`t$($_.UserPrincipalName)" }) -join "`n"
$disableTargetSetHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($disableTargetManifest))).Replace('-', '').ToLowerInvariant()
Write-Host "Target-set SHA256: $disableTargetSetHash"

if ($DryRun) {
    foreach ($user in $usersToDisable) { Write-Host "[DRY RUN] Would disable: $($user.SamAccountName) [$($user.ObjectGuid)]" }
    Write-Host "`n[DRY RUN COMPLETE] Live mode still requires separate checkpoint-write and remote-action confirmations."
} else {
    $checkpointId = [Guid]::NewGuid().ToString('N')
    $checkpointRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Aegis\checkpoints'
    $checkpointPath = Join-Path $checkpointRoot "bulk-disable-$checkpointId.json"
    $preState = @($usersToDisable | Select-Object SamAccountName,UserPrincipalName,ObjectGuid,DistinguishedName,Enabled)
    if ($preState.Count -ne $expectedCount) { throw "Pre-state cardinality drifted. No change was made." }
    $checkpoint = [ordered]@{ CheckpointId = $checkpointId; TargetSetSHA256 = $disableTargetSetHash; Users = $preState }

    # SAFETY GATE [safety-bulk-disable-checkpoint-write]
    # Target: one new local checkpoint $checkpointId for $disableTargetSetHash
    # Effect: writes exact immutable AD enabled-state pre-state outside the repository
    # Scope: one no-clobber JSON file at the displayed $checkpointPath
    # Reversibility: remove the local file after the approved retention period
    $requiredConfirmation = "WRITE LOCAL BULK DISABLE CHECKPOINT $checkpointId FOR $expectedCount USERS SET SHA256 $disableTargetSetHash"
    $confirmation = Read-Host "Type '$requiredConfirmation' to confirm"
    if ($confirmation -ceq $requiredConfirmation) {
        $checkpointEncoding = [Text.UTF8Encoding]::new($false, $true)
        $checkpointJson = ConvertTo-Json -InputObject $checkpoint -Depth 6
        $checkpointBytes = $checkpointEncoding.GetBytes($checkpointJson)
        $checkpointContentHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($checkpointBytes)).Replace('-', '').ToLowerInvariant()
        $resolvedRoot = [IO.Path]::GetFullPath($checkpointRoot).TrimEnd('\', '/')
        $resolvedCheckpoint = [IO.Path]::GetFullPath($checkpointPath)
        if (-not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetDirectoryName($resolvedCheckpoint).TrimEnd('\', '/'), $resolvedRoot)) { throw "Checkpoint target escaped its approved root. No file was written." }
        $checkpointTemp = Join-Path $resolvedRoot (".$([IO.Path]::GetFileName($resolvedCheckpoint)).$([Guid]::NewGuid().ToString('N')).tmp")
        $checkpointTempOwned = $false
        $checkpointInstalled = $false
        try {
            New-Item -ItemType Directory -Path $resolvedRoot -Force -ErrorAction Stop | Out-Null
            $rootItem = Get-Item -LiteralPath $resolvedRoot -Force -ErrorAction Stop
            if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Checkpoint root is a reparse point." }
            if (Test-Path -LiteralPath $resolvedCheckpoint -ErrorAction Stop) { throw "Checkpoint collision. The existing file was not changed." }
            $checkpointStream = [IO.FileStream]::new($checkpointTemp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
            $checkpointTempOwned = $true
            try {
                $checkpointStream.Write($checkpointBytes, 0, $checkpointBytes.Length)
                $checkpointStream.Flush($true)
            } finally {
                $checkpointStream.Dispose()
            }
            [IO.File]::Move($checkpointTemp, $resolvedCheckpoint)
            $checkpointTempOwned = $false
            $checkpointInstalled = $true
            $readBackBytes = [IO.File]::ReadAllBytes($resolvedCheckpoint)
            $readBackHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($readBackBytes)).Replace('-', '').ToLowerInvariant()
            if ($readBackHash -cne $checkpointContentHash) { throw "Checkpoint hash read-back did not match serialized content." }
            $readBackCheckpoint = ConvertFrom-Json -InputObject ($checkpointEncoding.GetString($readBackBytes)) -ErrorAction Stop
            if ([string]$readBackCheckpoint.CheckpointId -cne $checkpointId -or [string]$readBackCheckpoint.TargetSetSHA256 -cne $disableTargetSetHash -or @($readBackCheckpoint.Users).Count -ne $expectedCount) { throw "Checkpoint parse read-back did not preserve the immutable target set." }
        } catch {
            $persistenceError = $_
            $tempCleanup = 'no invocation-owned temp required cleanup'
            if ($checkpointTempOwned) {
                try {
                    [IO.File]::Delete($checkpointTemp)
                    $tempCleanup = if ([IO.File]::Exists($checkpointTemp)) { "FAILED; invocation-owned temp remains at $checkpointTemp" } else { 'invocation-owned temp removed' }
                } catch {
                    $tempCleanup = "FAILED for invocation-owned temp $checkpointTemp`: $($_.Exception.Message)"
                }
            }
            $finalState = if ($checkpointInstalled) { "installed at $resolvedCheckpoint but verification is UNKNOWN; file was left for inspection" } else { 'not installed by this invocation' }
            throw "Checkpoint persistence failed for ID $checkpointId and target-set SHA256 $disableTargetSetHash. Final state: $finalState. Temp cleanup: $tempCleanup. No account may be disabled. Error: $($persistenceError.Exception.Message)"
        }
        Write-Host "Verified checkpoint $checkpointId; content SHA256: $checkpointContentHash; path: $resolvedCheckpoint"
    } else {
        throw "Confirmation did not match. No file was written."
    }

    # SAFETY GATE [safety-bulk-disable]
    # Target: $disableTargetSetHash in [DEPARTMENT] and checkpoint $checkpointId
    # Effect: disables each staged AD account
    # Scope: exactly the independently approved $expectedCount identities; stop on the first failure
    # Reversibility: restore captured Enabled state from $checkpointPath through a separate action
    $requiredConfirmation = "DISABLE $expectedCount USERS IN [DEPARTMENT] SET SHA256 $disableTargetSetHash USING CHECKPOINT $checkpointId"
    $confirmation = Read-Host "Type '$requiredConfirmation' to confirm"
    if ($confirmation -ceq $requiredConfirmation) {
        $currentUsers = @(foreach ($approvedUser in $usersToDisable) {
            $current = Get-ADUser -Identity $approvedUser.ObjectGuid -Properties ObjectGuid,UserPrincipalName,Enabled -ErrorAction Stop
            if ([string]$current.ObjectGuid -cne [string]$approvedUser.ObjectGuid -or [string]$current.UserPrincipalName -cne [string]$approvedUser.UserPrincipalName) { throw "Target identity drifted after approval. No account was disabled." }
            $current
        })
        $currentManifest = @($currentUsers | Sort-Object ObjectGuid | ForEach-Object { "$($_.ObjectGuid)`t$($_.UserPrincipalName)" }) -join "`n"
        $currentSetHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($currentManifest))).Replace('-', '').ToLowerInvariant()
        if ($currentSetHash -cne $disableTargetSetHash) { throw "Target-set digest drifted after approval. No account was disabled." }

        $completedObjectGuids = [System.Collections.Generic.List[string]]::new()
        for ($index = 0; $index -lt $usersToDisable.Count; $index++) {
            $user = $usersToDisable[$index]
            try {
                Disable-ADAccount -Identity $user.ObjectGuid -ErrorAction Stop
                $verifiedUser = Get-ADUser -Identity $user.ObjectGuid -Properties ObjectGuid,Enabled -ErrorAction Stop
                if ([string]$verifiedUser.ObjectGuid -cne [string]$user.ObjectGuid -or $verifiedUser.Enabled) { throw "Read-back did not prove the immutable account disabled." }
                $completedObjectGuids.Add([string]$user.ObjectGuid)
                Write-Host "Disabled and verified: $($user.SamAccountName) [$($user.ObjectGuid)]"
            } catch {
                $notAttemptedGuids = @($usersToDisable | Select-Object -Skip ($index + 1) | ForEach-Object { $_.ObjectGuid })
                throw "Stopped at ObjectGuid $($user.ObjectGuid), whose state is UNKNOWN/POSSIBLY CHANGED. Verified completed GUIDs: $($completedObjectGuids -join ', '). Not-attempted GUIDs: $($notAttemptedGuids -join ', '). Checkpoint: $checkpointId. $($_.Exception.Message)"
            }
        }
    } else {
        throw "Confirmation did not match. No change was made."
    }
}
Write-Host "Total affected: $($usersToDisable.Count)"
```

---

## Pattern 3 — Export Before Modify (Audit Trail + Rollback)

Before any bulk modification, export the current state to a structured checkpoint. JSON preserves immutable IDs, object types, and an explicitly empty member list better than a display-oriented CSV. This serves two purposes:
1. Audit trail — proves what state things were in before the script ran
2. Rollback input — can be fed back into a rollback script if needed

```powershell
# Resolve the immutable group and capture every member object without assuming all members are users.
$group = Get-MgGroup -GroupId "[GROUP_ID]" -Property Id,DisplayName -ErrorAction Stop
$currentState = @(Get-MgGroupMember -GroupId $group.Id -All -ErrorAction Stop | ForEach-Object {
    [PSCustomObject]@{
        GroupId = [string]$group.Id
        MemberId = [string]$_.Id
        ObjectType = [string]$_.AdditionalProperties['@odata.type']
        DisplayName = [string]$_.AdditionalProperties.displayName
        UserPrincipalName = [string]$_.AdditionalProperties.userPrincipalName
    }
})
$checkpointId = [Guid]::NewGuid().ToString('N')
$exportRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Aegis\checkpoints'
$exportPath = Join-Path $exportRoot "group-members-$checkpointId.json"
Write-Host "Resolved group: $($group.DisplayName); ID: $($group.Id); members: $($currentState.Count); checkpoint: $checkpointId; path: $exportPath"

# SAFETY GATE [safety-group-checkpoint-write]
# Target: resolved [GROUP_ID] and one new local checkpoint $checkpointId
# Effect: write one group-membership checkpoint to the local export path
# Scope: one no-clobber JSON file at the displayed $exportPath outside the repository
# Reversibility: remove the local file after the approved retention period
$requiredConfirmation = "WRITE LOCAL GROUP CHECKPOINT $checkpointId FOR [GROUP_ID]"
$confirmation = Read-Host "Type '$requiredConfirmation' to confirm the local write"
if ($confirmation -ceq $requiredConfirmation) {
    $checkpoint = [ordered]@{
        CheckpointId = $checkpointId
        GroupId = [string]$group.Id
        GroupDisplayName = [string]$group.DisplayName
        Members = $currentState
    }
    $checkpointEncoding = [Text.UTF8Encoding]::new($false, $true)
    $checkpointJson = ConvertTo-Json -InputObject $checkpoint -Depth 6
    $checkpointBytes = $checkpointEncoding.GetBytes($checkpointJson)
    $checkpointContentHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($checkpointBytes)).Replace('-', '').ToLowerInvariant()
    $resolvedRoot = [IO.Path]::GetFullPath($exportRoot).TrimEnd('\', '/')
    $resolvedCheckpoint = [IO.Path]::GetFullPath($exportPath)
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetDirectoryName($resolvedCheckpoint).TrimEnd('\', '/'), $resolvedRoot)) { throw "Checkpoint target escaped its approved root. No file was written." }
    $checkpointTemp = Join-Path $resolvedRoot (".$([IO.Path]::GetFileName($resolvedCheckpoint)).$([Guid]::NewGuid().ToString('N')).tmp")
    $checkpointTempOwned = $false
    $checkpointInstalled = $false
    try {
        New-Item -ItemType Directory -Path $resolvedRoot -Force -ErrorAction Stop | Out-Null
        $rootItem = Get-Item -LiteralPath $resolvedRoot -Force -ErrorAction Stop
        if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Checkpoint root is a reparse point." }
        if (Test-Path -LiteralPath $resolvedCheckpoint -ErrorAction Stop) { throw "Checkpoint collision. The existing file was not changed." }
        $checkpointStream = [IO.FileStream]::new($checkpointTemp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
        $checkpointTempOwned = $true
        try {
            $checkpointStream.Write($checkpointBytes, 0, $checkpointBytes.Length)
            $checkpointStream.Flush($true)
        } finally {
            $checkpointStream.Dispose()
        }
        [IO.File]::Move($checkpointTemp, $resolvedCheckpoint)
        $checkpointTempOwned = $false
        $checkpointInstalled = $true
        $readBackBytes = [IO.File]::ReadAllBytes($resolvedCheckpoint)
        $readBackHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($readBackBytes)).Replace('-', '').ToLowerInvariant()
        if ($readBackHash -cne $checkpointContentHash) { throw "Checkpoint hash read-back did not match serialized content." }
        $readBackCheckpoint = ConvertFrom-Json -InputObject ($checkpointEncoding.GetString($readBackBytes)) -ErrorAction Stop
        if ([string]$readBackCheckpoint.CheckpointId -cne $checkpointId -or [string]$readBackCheckpoint.GroupId -cne [string]$group.Id -or @($readBackCheckpoint.Members).Count -ne $currentState.Count) { throw "Checkpoint parse read-back did not preserve the immutable group state." }
    } catch {
        $persistenceError = $_
        $tempCleanup = 'no invocation-owned temp required cleanup'
        if ($checkpointTempOwned) {
            try {
                [IO.File]::Delete($checkpointTemp)
                $tempCleanup = if ([IO.File]::Exists($checkpointTemp)) { "FAILED; invocation-owned temp remains at $checkpointTemp" } else { 'invocation-owned temp removed' }
            } catch {
                $tempCleanup = "FAILED for invocation-owned temp $checkpointTemp`: $($_.Exception.Message)"
            }
        }
        $finalState = if ($checkpointInstalled) { "installed at $resolvedCheckpoint but verification is UNKNOWN; file was left for inspection" } else { 'not installed by this invocation' }
        throw "Checkpoint persistence failed for ID $checkpointId and immutable group ID $($group.Id). Final state: $finalState. Temp cleanup: $tempCleanup. No remote change may proceed. Error: $($persistenceError.Exception.Message)"
    }
    Write-Host "Verified pre-change checkpoint $checkpointId; content SHA256: $checkpointContentHash; path: $resolvedCheckpoint"
} else {
    throw "Confirmation did not match. No file was written."
}

# Step 2: Make the changes
# ... (your modification logic here)

# Step 3: a post-change export is a separate local write and is not performed by this checkpoint example.
# PREVIEW ONLY [safety-group-poststate-export]: Export-Csv -LiteralPath $postStatePath -NoTypeInformation -ErrorAction Stop
```

---

## Pattern 4 — Confirmation Gate for Dangerous Operations

For destructive or provider-retention-dependent operations (user soft-delete, device wipe,
license removal), capture recovery evidence first and require an exact confirmation string.

```powershell
$targetUpn = "[UPN]"
$targetUser = Get-MgUser -UserId $targetUpn -Property Id,UserPrincipalName -ErrorAction Stop
if ([string]::IsNullOrWhiteSpace([string]$targetUser.Id) -or [string]$targetUser.UserPrincipalName -cne $targetUpn) { throw "The exact Entra identity was not resolved. No change was made." }

# Capture current provider evidence without embedding PII, secrets, or a stale hard-coded retention promise.
$providerEvidence = 'Microsoft Entra ID via Microsoft Graph'
$retentionEvidence = Read-Host "Enter the current provider retention evidence (documentation reference and verification date; no PII/secrets)"
$recoveryEvidence = Read-Host "Enter the approved recovery runbook or backup evidence (sanitized reference and verification date)"
foreach ($evidenceValue in @($retentionEvidence, $recoveryEvidence)) {
    if ([string]::IsNullOrWhiteSpace($evidenceValue) -or $evidenceValue.Length -gt 2048 -or $evidenceValue -match '[\x00-\x1f\x7f]') { throw "Provider retention and recovery evidence must be non-empty, bounded, single-line text. No checkpoint was written." }
}
$checkpointId = [Guid]::NewGuid().ToString('N')
$checkpointRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Aegis\checkpoints'
$checkpointPath = Join-Path $checkpointRoot "soft-delete-$checkpointId.json"
$checkpointRecord = [ordered]@{
    CheckpointId = $checkpointId
    CapturedUtc = [DateTimeOffset]::UtcNow.ToString('o')
    Effect = 'SoftDeleteEntraUser'
    TargetId = [string]$targetUser.Id
    TargetUpn = [string]$targetUser.UserPrincipalName
    ProviderEvidence = $providerEvidence
    RetentionEvidence = $retentionEvidence
    RecoveryEvidence = $recoveryEvidence
}
$checkpointEncoding = [Text.UTF8Encoding]::new($false, $true)
$checkpointJson = ConvertTo-Json -InputObject $checkpointRecord -Depth 5
$checkpointBytes = $checkpointEncoding.GetBytes($checkpointJson)
$checkpointContentHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($checkpointBytes)).Replace('-', '').ToLowerInvariant()
Write-Host "Prepared checkpoint: $checkpointId; immutable target ID: $($targetUser.Id); content SHA256: $checkpointContentHash"

# SAFETY GATE [safety-delete-user-checkpoint-write]
# Target: one new local checkpoint $checkpointId for the immutable Entra ID in $targetUser
# Effect: writes provider, retention, recovery, and target evidence outside the repository
# Scope: one no-clobber JSON file at the displayed $checkpointPath
# Reversibility: remove the local evidence file after the approved retention period
$requiredConfirmation = "WRITE LOCAL SOFT DELETE CHECKPOINT $checkpointId FOR $($targetUser.UserPrincipalName) ID $($targetUser.Id) CONTENT SHA256 $checkpointContentHash"
$confirmation = Read-Host "Type '$requiredConfirmation' to confirm the local evidence write"
if ($confirmation -ceq $requiredConfirmation) {
    $resolvedRoot = [IO.Path]::GetFullPath($checkpointRoot).TrimEnd('\', '/')
    $resolvedCheckpoint = [IO.Path]::GetFullPath($checkpointPath)
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetDirectoryName($resolvedCheckpoint).TrimEnd('\', '/'), $resolvedRoot)) { throw "Checkpoint target escaped its approved root. No file was written." }
    $checkpointTemp = Join-Path $resolvedRoot (".$([IO.Path]::GetFileName($resolvedCheckpoint)).$([Guid]::NewGuid().ToString('N')).tmp")
    $checkpointTempOwned = $false
    $checkpointInstalled = $false
    try {
        New-Item -ItemType Directory -Path $resolvedRoot -Force -ErrorAction Stop | Out-Null
        $rootItem = Get-Item -LiteralPath $resolvedRoot -Force -ErrorAction Stop
        if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Checkpoint root is a reparse point." }
        if (Test-Path -LiteralPath $resolvedCheckpoint -ErrorAction Stop) { throw "Checkpoint collision. The existing file was not changed." }
        $checkpointStream = [IO.FileStream]::new($checkpointTemp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
        $checkpointTempOwned = $true
        try {
            $checkpointStream.Write($checkpointBytes, 0, $checkpointBytes.Length)
            $checkpointStream.Flush($true)
        } finally {
            $checkpointStream.Dispose()
        }
        [IO.File]::Move($checkpointTemp, $resolvedCheckpoint)
        $checkpointTempOwned = $false
        $checkpointInstalled = $true
        $readBackBytes = [IO.File]::ReadAllBytes($resolvedCheckpoint)
        $readBackHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($readBackBytes)).Replace('-', '').ToLowerInvariant()
        if ($readBackHash -cne $checkpointContentHash) { throw "Checkpoint hash read-back did not match serialized evidence." }
        $readBackCheckpoint = ConvertFrom-Json -InputObject ($checkpointEncoding.GetString($readBackBytes)) -ErrorAction Stop
        if ([string]$readBackCheckpoint.CheckpointId -cne $checkpointId -or [string]$readBackCheckpoint.TargetId -cne [string]$targetUser.Id -or [string]$readBackCheckpoint.TargetUpn -cne [string]$targetUser.UserPrincipalName -or [string]::IsNullOrWhiteSpace([string]$readBackCheckpoint.RetentionEvidence) -or [string]::IsNullOrWhiteSpace([string]$readBackCheckpoint.RecoveryEvidence)) { throw "Checkpoint parse read-back did not preserve the immutable target and recovery evidence." }
    } catch {
        $persistenceError = $_
        $tempCleanup = 'no invocation-owned temp required cleanup'
        if ($checkpointTempOwned) {
            try {
                [IO.File]::Delete($checkpointTemp)
                $tempCleanup = if ([IO.File]::Exists($checkpointTemp)) { "FAILED; invocation-owned temp remains at $checkpointTemp" } else { 'invocation-owned temp removed' }
            } catch {
                $tempCleanup = "FAILED for invocation-owned temp $checkpointTemp`: $($_.Exception.Message)"
            }
        }
        $finalState = if ($checkpointInstalled) { "installed at $resolvedCheckpoint but verification is UNKNOWN; file was left for inspection" } else { 'not installed by this invocation' }
        throw "Evidence checkpoint failed for ID $checkpointId and immutable target $($targetUser.Id). Final state: $finalState. Temp cleanup: $tempCleanup. No soft-delete may proceed. Error: $($persistenceError.Exception.Message)"
    }
    Write-Host "Verified evidence checkpoint $checkpointId; content SHA256: $checkpointContentHash; path: $resolvedCheckpoint"
} else {
    throw "Confirmation did not match. No checkpoint was written."
}

Write-Host ""
Write-Host "⚠️  About to soft-delete Entra user: $($targetUser.UserPrincipalName) [$($targetUser.Id)]"
Write-Host "    Checkpoint: $checkpointId; content SHA256: $checkpointContentHash"
Write-Host "    Recovery is governed by the captured provider retention and recovery evidence."
Write-Host ""

# SAFETY GATE [safety-delete-user]
# Target: canonical UPN and immutable ID in $targetUser, bound to checkpoint $checkpointId / $checkpointContentHash
# Effect: deletes one reviewed Entra user into the provider's soft-deleted state
# Scope: one exact immutable ID after checkpoint and target-drift verification
# Reversibility: governed by the provider retention and recovery evidence captured in the bound checkpoint
$requiredConfirmation = "SOFT DELETE ENTRA USER $($targetUser.UserPrincipalName) ID $($targetUser.Id) USING CHECKPOINT $checkpointId SHA256 $checkpointContentHash"
$confirmation = Read-Host "Type '$requiredConfirmation' to confirm"
if ($confirmation -ceq $requiredConfirmation) {
    $currentTarget = Get-MgUser -UserId $targetUser.Id -Property Id,UserPrincipalName -ErrorAction Stop
    if ([string]$currentTarget.Id -cne [string]$targetUser.Id -or [string]$currentTarget.UserPrincipalName -cne [string]$targetUser.UserPrincipalName) { throw "Immutable target drifted after approval. No soft-delete was attempted." }
    $currentCheckpointBytes = [IO.File]::ReadAllBytes($resolvedCheckpoint)
    $currentCheckpointHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($currentCheckpointBytes)).Replace('-', '').ToLowerInvariant()
    if ($currentCheckpointHash -cne $checkpointContentHash) { throw "Bound checkpoint drifted after approval. No soft-delete was attempted." }
    $deleteReturned = $false
    try {
        # ⚠️ Remove-MgUser — moves the exact immutable Entra user into the provider's deleted-item lifecycle
        Remove-MgUser -UserId $targetUser.Id -ErrorAction Stop
        $deleteReturned = $true
        $deletedUser = Get-MgDirectoryDeletedItemAsUser -DirectoryObjectId $targetUser.Id -ErrorAction Stop
        if ([string]$deletedUser.Id -cne [string]$targetUser.Id) { throw "Deleted-item read-back did not preserve the immutable target ID." }
    } catch {
        throw "Soft-delete ended in UNKNOWN/POSSIBLY CHANGED state for immutable ID $($targetUser.Id), checkpoint $checkpointId SHA256 $checkpointContentHash. Remove command returned: $deleteReturned. Error: $($_.Exception.Message)"
    }
    Write-Host "Verified deleted-item ID $($targetUser.Id) using checkpoint $checkpointId SHA256 $checkpointContentHash. Recovery remains governed by its captured evidence."
} else {
    throw "Confirmation did not match. No change was made."
}
```

---

## Pattern 5 — Scope Limiter (Fail-Safe on Large Batches)

If a script is expected to affect a bounded number of objects (e.g., "disable accounts in
the Disabled OU"), add a count check. If the count is unexpectedly large, stop and alert
rather than proceeding.

```powershell
$maxExpected = 10  # How many objects you expect to affect — adjust per task

$targets = Get-ADUser -Filter "Enabled -eq $true" -SearchBase "OU=Disabled Users,DC=..."

if ($targets.Count -gt $maxExpected) {
    Write-Host "⚠️  STOP: Found $($targets.Count) objects — expected $maxExpected or fewer."
    Write-Host "    Possible filter issue. Review the query before proceeding."
    Write-Host "    Re-run with -WhatIf if you want to see what would be affected."
    exit 1
}

Write-Host "Count check passed: $($targets.Count) objects within expected range."
# Proceed with operation...
```

---

## Pattern 6 — Error Handling with Rollback State

If a bulk script fails mid-run, stop immediately and report the immutable IDs that changed and those not attempted. Do not create a second, subtly different bulk-license implementation here. The canonical executable pattern is EX-02 in `examples.md`; it resolves unique user IDs, captures `AssignedLicenses` plus `DisabledPlans` to a no-clobber off-repo checkpoint, binds that checkpoint ID into a separate remote confirmation, reads back each result, and stops on the first failure.

```powershell
$targetUsers = @('[UPN]', '[USER@DOMAIN.COM]')
$licenseSkuId = '[LICENSE_SKU_ID]'
if ($targetUsers.Count -eq 0) { throw "No target users were staged. No change was made." }
Write-Host "Staged target count: $($targetUsers.Count); SKU: $licenseSkuId"
$targetUsers | ForEach-Object { Write-Host "  target: $_" }
# PREVIEW ONLY [safety-bulk-license-route]: Set-MgUserLicense -UserId "[USER_ID]" -BodyParameter @{ addLicenses = @(@{ skuId = $licenseSkuId }); removeLicenses = @() } -ErrorAction Stop
```

---

## Pattern 7 — Avoid Aliases and One-Liners

Scripts should be readable by someone who did not write them. Avoid:

```powershell
# BAD — cryptic alias, compressed logic
# PREVIEW ONLY [safety-cryptic-bulk-mutation]: gm -f "dept -eq 'IT'" | %{ set-mg... }

# GOOD — full cmdlet names, one operation per line
$itUsers = Get-ADUser -Filter "Department -eq 'IT'"
foreach ($user in $itUsers) {
    # PREVIEW ONLY [safety-readable-bulk-mutation]: Set-MgUser -UserId $user.UserPrincipalName -Property ...
}
```

**Rule:** Use full cmdlet names. One pipeline operation per line. Comment anything
that isn't obvious from the cmdlet name alone.

---

## Pattern 8 — Module Pre-Check

Always verify required modules are installed and connected before starting a script.
Fail fast with a clear message rather than crashing mid-operation.

```powershell
# Check that Microsoft.Graph is installed
if (-not (Get-Module -ListAvailable -Name Microsoft.Graph)) {
    Write-Host "Required module not installed. Run:"
    Write-Host "  Installation requires the exact gate: INSTALL POWERSHELL MODULE Microsoft.Graph"
    exit 1
}

# Check that we're connected to Graph (catches expired sessions)
try {
    $ctx = Get-MgContext
    if (-not $ctx) { throw "Not connected" }
    Write-Host "Connected as: $($ctx.Account)"
} catch {
    Write-Host "Not connected to Microsoft Graph. Run:"
    Write-Host "  Connect-MgGraph -Scopes `"User.Read.All`""
    exit 1
}

# --- Safe to proceed ---
```

---

## Pre-Commit Scan Coverage

The pre-commit hook (`scripts/pre-commit-check.js`) will catch these automatically:

| Pattern | Scan class | Action |
|---------|-----------|--------|
| `$password = "..."` | Credential scan | BLOCK |
| `Remove-Item -Recurse -Force` | Dangerous cmdlet | WARN |
| `Invoke-Expression` or `IEX` | Dangerous cmdlet | WARN |
| Real email address | PII scan | BLOCK |
| Phone number pattern | PII scan | BLOCK |
| `ConvertTo-SecureString -AsPlainText` | Dangerous cmdlet | WARN |

See [pre_commit_hooks.md](../pre_commit_hooks.md) for full pattern list and how to extend it.
