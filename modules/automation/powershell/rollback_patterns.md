# PowerShell Rollback-State Patterns

Execution patterns for the R2/R3 blast-radius classes in CLAUDE.md's Zero-Trust Execution
Contract. Companion to [safety_patterns.md](safety_patterns.md) (WhatIf, dry-run guards).
Core idea: **Entra, Intune, and Exchange do not keep your before-state.** If you didn't
capture it, you can't roll back — you can only reconstruct from memory and hope.

All examples use placeholders. Every line is commented in plain English.

---

## Pattern 1 — Checkpoint before change (the R2 minimum)

Capture the exact pre-state to a collision-resistant, no-clobber JSON file **before** touching anything.

```powershell
# Resolve the immutable target and exact rollback state before authorizing a local write.
$resolvedUser = Get-MgUser -UserId "[UPN]" -Property Id,UserPrincipalName,AssignedLicenses -ErrorAction Stop
$licensePreState = @($resolvedUser.AssignedLicenses | ForEach-Object {
    [PSCustomObject]@{
        SkuId = [string]$_.SkuId
        DisabledPlans = @($_.DisabledPlans | ForEach-Object { [string]$_ })
    }
})
$groupPreState = @(Get-MgUserMemberOf -UserId $resolvedUser.Id -All -ErrorAction Stop | ForEach-Object {
    [PSCustomObject]@{
        Id = [string]$_.Id
        DisplayName = [string]$_.AdditionalProperties.displayName
        ObjectType = [string]$_.AdditionalProperties['@odata.type']
    }
})
$checkpointId = [Guid]::NewGuid().ToString('N')
$ckptRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Aegis\checkpoints'
$ckpt = Join-Path $ckptRoot "license-change-$checkpointId.json"
Write-Host "Resolved user: $($resolvedUser.UserPrincipalName); ID: $($resolvedUser.Id)"
Write-Host "Checkpoint ID: $checkpointId; path: $ckpt; licenses: $($licensePreState.Count); memberships: $($groupPreState.Count)"

# SAFETY GATE [rollback-license-checkpoint-write]
# Target: one new local checkpoint $checkpointId for the resolved user ID and UPN
# Effect: write license and group identity data outside the repository
# Scope: one no-clobber JSON file at the displayed $ckpt path
# Reversibility: remove the local file after the approved retention period
$requiredConfirmation = "WRITE LOCAL LICENSE CHECKPOINT $checkpointId FOR $($resolvedUser.UserPrincipalName) ID $($resolvedUser.Id)"
$confirmation = Read-Host "Type '$requiredConfirmation' to confirm the local write"
if ($confirmation -ceq $requiredConfirmation) {
    # Capture the user's CURRENT immutable license/group state — this IS the rollback data.
    $pre = [ordered]@{
        checkpointId = $checkpointId
        userId   = [string]$resolvedUser.Id
        userUpn  = [string]$resolvedUser.UserPrincipalName
        assignedLicenses = $licensePreState
        memberships = $groupPreState
    }
    if ($pre.assignedLicenses.Count -ne $licensePreState.Count -or $pre.memberships.Count -ne $groupPreState.Count) { throw "Pre-state cardinality changed during serialization. No file was written." }
    $checkpointEncoding = [Text.UTF8Encoding]::new($false, $true)
    $checkpointJson = ConvertTo-Json -InputObject $pre -Depth 8
    $checkpointBytes = $checkpointEncoding.GetBytes($checkpointJson)
    $checkpointContentHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($checkpointBytes)).Replace('-', '').ToLowerInvariant()
    $resolvedRoot = [IO.Path]::GetFullPath($ckptRoot).TrimEnd('\', '/')
    $resolvedCheckpoint = [IO.Path]::GetFullPath($ckpt)
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
        # Same-directory File.Move is an atomic no-replace install on the supported Windows runtime.
        [IO.File]::Move($checkpointTemp, $resolvedCheckpoint)
        $checkpointTempOwned = $false
        $checkpointInstalled = $true
        $readBackBytes = [IO.File]::ReadAllBytes($resolvedCheckpoint)
        $readBackHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($readBackBytes)).Replace('-', '').ToLowerInvariant()
        if ($readBackHash -cne $checkpointContentHash) { throw "Checkpoint hash read-back did not match serialized content." }
        $readBackCheckpoint = ConvertFrom-Json -InputObject ($checkpointEncoding.GetString($readBackBytes)) -ErrorAction Stop
        if ([string]$readBackCheckpoint.checkpointId -cne $checkpointId -or [string]$readBackCheckpoint.userId -cne [string]$resolvedUser.Id) { throw "Checkpoint parse read-back did not preserve the immutable target." }
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
        throw "Checkpoint persistence failed for ID $checkpointId. Final state: $finalState. Temp cleanup: $tempCleanup. No remote change may proceed. Error: $($persistenceError.Exception.Message)"
    }
    Write-Host "Verified checkpoint $checkpointId; content SHA256: $checkpointContentHash; path: $resolvedCheckpoint"
} else {
    throw "Confirmation did not match. No file was written."
}

# ONLY NOW make the change. If anything goes wrong, $ckpt says exactly what "back" means.
```

**Rule:** the checkpoint file is written and confirmed on disk *before* step 1 of the change.
A checkpoint you write "after, if needed" is not a checkpoint.

## Pattern 2 — Paired change + rollback function

Never write a change block without writing its inverse next to it.

```powershell
# Read the exact pre-state and stop if the lookup fails.
$existing = @(Get-MgGroupMember -GroupId "[GROUP_ID]" -All -ErrorAction Stop | Where-Object { $_.Id -eq "[USER_ID]" })
if ($existing.Count -gt 0) { throw "Membership already exists. No change was made." }
$checkpointId = [Guid]::NewGuid().ToString('N')
$checkpointRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Aegis\checkpoints'
$checkpointPath = Join-Path $checkpointRoot "group-membership-$checkpointId.json"

# SAFETY GATE [rollback-group-checkpoint-write]
# Target: one new local checkpoint $checkpointId for [USER_ID] and [GROUP_ID]
# Effect: write the verified membership pre-state outside the repository
# Scope: one no-clobber JSON file at the displayed $checkpointPath
# Reversibility: remove the local file after the approved retention period
$requiredConfirmation = "WRITE LOCAL GROUP CHECKPOINT $checkpointId FOR [USER_ID] IN [GROUP_ID]"
$confirmation = Read-Host "Type '$requiredConfirmation' to confirm"
if ($confirmation -ceq $requiredConfirmation) {
    $checkpointRecord = [ordered]@{ CheckpointId = $checkpointId; GroupId = '[GROUP_ID]'; UserId = '[USER_ID]'; Existed = ($existing.Count -gt 0) }
    $checkpointEncoding = [Text.UTF8Encoding]::new($false, $true)
    $checkpointJson = ConvertTo-Json -InputObject $checkpointRecord -Depth 4
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
        if ([string]$readBackCheckpoint.CheckpointId -cne $checkpointId -or [string]$readBackCheckpoint.GroupId -cne '[GROUP_ID]' -or [string]$readBackCheckpoint.UserId -cne '[USER_ID]') { throw "Checkpoint parse read-back did not preserve the immutable targets." }
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
        throw "Checkpoint persistence failed for ID $checkpointId and immutable USER ID [USER_ID] / GROUP ID [GROUP_ID]. Final state: $finalState. Temp cleanup: $tempCleanup. No remote change may proceed. Error: $($persistenceError.Exception.Message)"
    }
    Write-Host "Verified checkpoint $checkpointId; content SHA256: $checkpointContentHash; path: $resolvedCheckpoint"
} else {
    throw "Confirmation did not match. No file was written."
}

# SAFETY GATE [rollback-group-change]
# Target: [USER_ID], [GROUP_ID], and verified local checkpoint $checkpointId
# Effect: add one reviewed membership; remove the same membership if verification fails after the add returns
# Scope: one user and one group after the local pre-state checkpoint is verified
# Reversibility: paired rollback removes the same membership
$requiredConfirmation = "ADD [USER_ID] TO [GROUP_ID] AND REMOVE IT IF VERIFICATION FAILS USING CHECKPOINT $checkpointId"
$confirmation = Read-Host "Type '$requiredConfirmation' to confirm"
if ($confirmation -ceq $requiredConfirmation) {
    $addReturned = $false
    $immutableTarget = "membership USER ID [USER_ID] in GROUP ID [GROUP_ID]"
    $completedOutcomes = [System.Collections.Generic.List[string]]::new()
    $failedOutcomes = [System.Collections.Generic.List[string]]::new()
    try {
        New-MgGroupMember -GroupId "[GROUP_ID]" -DirectoryObjectId "[USER_ID]" -ErrorAction Stop
        $addReturned = $true
        $now = @(Get-MgGroupMember -GroupId "[GROUP_ID]" -All -ErrorAction Stop | Where-Object { $_.Id -eq "[USER_ID]" })
        if ($now.Count -ne 1) { throw "Verification did not find exactly one approved membership." }
        $completedOutcomes.Add("ADD verified by exact immutable-ID read-back for $immutableTarget")
        Write-Host "Completed outcomes: $($completedOutcomes -join '; '). Failed/UNKNOWN outcomes: none."
    } catch {
        $forwardError = $_
        if ($addReturned) {
            $rollbackRemoveError = $null
            $rollbackReadBackError = $null
            try {
                Remove-MgGroupMemberByRef -GroupId "[GROUP_ID]" -DirectoryObjectId "[USER_ID]" -ErrorAction Stop
            } catch {
                $rollbackRemoveError = $_
                $failedOutcomes.Add("ROLLBACK REMOVE failed for $immutableTarget; state is UNKNOWN/POSSIBLY CHANGED: $($_.Exception.Message)")
            }

            try {
                $afterRollback = @(Get-MgGroupMember -GroupId "[GROUP_ID]" -All -ErrorAction Stop | Where-Object { $_.Id -eq "[USER_ID]" })
                if ($afterRollback.Count -ne 0) { throw "Absence read-back found $($afterRollback.Count) matching membership object(s)." }
                $completedOutcomes.Add("ROLLBACK absence verified by exact immutable-ID read-back for $immutableTarget")
            } catch {
                $rollbackReadBackError = $_
                $failedOutcomes.Add("ROLLBACK READ-BACK failed for $immutableTarget; state is UNKNOWN/POSSIBLY CHANGED: $($_.Exception.Message)")
            }

            if ($null -ne $rollbackRemoveError -or $null -ne $rollbackReadBackError) {
                $completedSummary = if ($completedOutcomes.Count -gt 0) { $completedOutcomes -join '; ' } else { 'none' }
                throw "Rollback ended in UNKNOWN/PARTIAL STATE for immutable target $immutableTarget. Verified completed outcomes: [$completedSummary]. Failed/UNKNOWN outcomes: [$($failedOutcomes -join '; ')]. Forward error: $($forwardError.Exception.Message)"
            }
            $failedOutcomes.Add("FORWARD verification failed for ${immutableTarget}: $($forwardError.Exception.Message)")
            throw "Forward change failed but rollback completed for immutable target $immutableTarget. Verified completed outcomes: [$($completedOutcomes -join '; ')]. Failed outcomes: [$($failedOutcomes -join '; ')]."
        }
        $failedOutcomes.Add("ADD command failed for $immutableTarget; state is UNKNOWN/POSSIBLY CHANGED: $($forwardError.Exception.Message)")
        throw "Change ended in UNKNOWN/PARTIAL STATE for immutable target $immutableTarget. Verified completed outcomes: [none]. Failed/UNKNOWN outcomes: [$($failedOutcomes -join '; ')]. Inspect the immutable IDs before retrying."
    }
} else {
    throw "Confirmation did not match. No change was made."
}
```

## Pattern 3 — Batch with count gate and stop-on-first-failure

The pattern that prevents tenant-wide accidents. Never pipe `Get-X | Action-Y`.

```powershell
# STAGE — collect targets into a variable; nothing has happened yet
$targets = @(Get-MgUser -Filter "department eq '[DEPARTMENT]'" -Property Id,UserPrincipalName,UsageLocation)

# COUNT GATE — state the predicted count BEFORE acting; a surprise count = stop
$expectedCountText = Read-Host "Enter the reviewed expected target count"
$expectedCount = 0
if (-not [int]::TryParse($expectedCountText, [ref]$expectedCount) -or $expectedCount -lt 1) {
    throw "Expected count must be a positive integer. No change was made."
}
$targets.Count
$targets | ForEach-Object { Write-Host "  target: $($_.UserPrincipalName)" }
if ($targets.Count -eq 0) { throw "No targets were staged. No change was made." }
if ($targets.Count -ne $expectedCount) { throw "Actual count $($targets.Count) did not match reviewed count $expectedCount. No change was made." }
if (@($targets.Id | Sort-Object -Unique).Count -ne $expectedCount) { throw "Target resolution produced duplicate immutable IDs. No change was made." }
$targets = @($targets | Sort-Object Id)
$usageTargetManifest = @($targets | ForEach-Object { "$($_.Id)`t$($_.UserPrincipalName)" }) -join "`n"
$usageTargetSetHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($usageTargetManifest))).Replace('-', '').ToLowerInvariant()
Write-Host "Target-set SHA256: $usageTargetSetHash"

# Capture exact UsageLocation rollback state outside the repository before the first change.
$checkpointRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Aegis\checkpoints'
$checkpointId = [Guid]::NewGuid().ToString('N')
$checkpointPath = Join-Path $checkpointRoot "usage-location-$checkpointId.json"
$usagePreState = @($targets | Select-Object Id, UserPrincipalName, UsageLocation)
if ($usagePreState.Count -ne $expectedCount) { throw "Pre-state cardinality drifted. No change was made." }
$usageCheckpoint = [ordered]@{ CheckpointId = $checkpointId; TargetSetSHA256 = $usageTargetSetHash; Users = $usagePreState }

# SAFETY GATE [rollback-bulk-usage-checkpoint-write]
# Target: one new local checkpoint $checkpointId for $usageTargetSetHash
# Effect: write exact UsageLocation pre-state outside the repository
# Scope: one no-clobber JSON file at the displayed $checkpointPath
# Reversibility: remove the local file after the approved retention period
$requiredConfirmation = "WRITE LOCAL USAGE LOCATION CHECKPOINT $checkpointId FOR $expectedCount USERS SET SHA256 $usageTargetSetHash"
$confirmation = Read-Host "Type '$requiredConfirmation' to confirm"
if ($confirmation -ceq $requiredConfirmation) {
    $checkpointEncoding = [Text.UTF8Encoding]::new($false, $true)
    $checkpointJson = ConvertTo-Json -InputObject $usageCheckpoint -Depth 4
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
        if ([string]$readBackCheckpoint.CheckpointId -cne $checkpointId -or [string]$readBackCheckpoint.TargetSetSHA256 -cne $usageTargetSetHash -or @($readBackCheckpoint.Users).Count -ne $expectedCount) { throw "Checkpoint parse read-back did not preserve the immutable target set." }
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
        throw "Checkpoint persistence failed for ID $checkpointId and target-set SHA256 $usageTargetSetHash. Final state: $finalState. Temp cleanup: $tempCleanup. No remote change may proceed. Error: $($persistenceError.Exception.Message)"
    }
    Write-Host "Verified checkpoint $checkpointId; content SHA256: $checkpointContentHash; path: $resolvedCheckpoint"
} else {
    throw "Confirmation did not match. No file was written."
}

# SAFETY GATE [rollback-bulk-usage-location]
# Target: $usageTargetSetHash in [DEPARTMENT] and verified checkpoint $checkpointId
# Effect: changes UsageLocation to [COUNTRY_CODE] for each staged identity
# Scope: exactly $expectedCount identities; stop on the first failure
# Reversibility: restore each captured UsageLocation from $checkpointPath
$requiredConfirmation = "SET USAGE LOCATION [COUNTRY_CODE] FOR $expectedCount USERS IN [DEPARTMENT] SET SHA256 $usageTargetSetHash USING CHECKPOINT $checkpointId"
$confirmation = Read-Host "Type '$requiredConfirmation' to confirm"
if ($confirmation -ceq $requiredConfirmation) {
    $currentTargets = @(foreach ($approvedTarget in $targets) {
        $current = Get-MgUser -UserId $approvedTarget.Id -Property Id,UserPrincipalName,UsageLocation -ErrorAction Stop
        if ([string]$current.Id -cne [string]$approvedTarget.Id -or [string]$current.UserPrincipalName -cne [string]$approvedTarget.UserPrincipalName) { throw "Target identity drifted after approval. No UsageLocation was changed." }
        $current
    })
    $currentManifest = @($currentTargets | Sort-Object Id | ForEach-Object { "$($_.Id)`t$($_.UserPrincipalName)" }) -join "`n"
    $currentSetHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($currentManifest))).Replace('-', '').ToLowerInvariant()
    if ($currentSetHash -cne $usageTargetSetHash) { throw "Target-set digest drifted after approval. No UsageLocation was changed." }

    $completedIds = [System.Collections.Generic.List[string]]::new()
    for ($index = 0; $index -lt $targets.Count; $index++) {
        $u = $targets[$index]
        try {
            Set-MgUser -UserId $u.Id -UsageLocation "[COUNTRY_CODE]" -ErrorAction Stop
            $readBack = Get-MgUser -UserId $u.Id -Property Id,UsageLocation -ErrorAction Stop
            if ([string]$readBack.Id -cne [string]$u.Id -or [string]$readBack.UsageLocation -cne '[COUNTRY_CODE]') { throw "Read-back did not prove the approved UsageLocation on the immutable ID." }
            $completedIds.Add([string]$u.Id)
        } catch {
            $notAttemptedIds = @($targets | Select-Object -Skip ($index + 1) | ForEach-Object { $_.Id })
            throw "Stopped at immutable ID $($u.Id), whose state is UNKNOWN/POSSIBLY CHANGED. Verified completed IDs: $($completedIds -join ', '). Not-attempted IDs: $($notAttemptedIds -join ', '). Checkpoint: $checkpointId. $($_.Exception.Message)"
        }
    }
} else {
    throw "Confirmation did not match. No change was made."
}
```

## Pattern 4 — Policy objects: export before edit (CA, compliance, config)

Conditional Access and Intune policies are single objects with many settings — one wrong
edit is invisible later. Export the full JSON first.

```powershell
# Resolve and display the ENTIRE policy definition before authorizing the local checkpoint.
$policyPreState = Get-MgIdentityConditionalAccessPolicy -ConditionalAccessPolicyId "[POLICY_ID]" -ErrorAction Stop
if ([string]$policyPreState.Id -cne "[POLICY_ID]") { throw "Resolved policy ID did not match. No checkpoint was written." }
$checkpointId = [Guid]::NewGuid().ToString('N')
$checkpointRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Aegis\checkpoints'
$policyCheckpoint = Join-Path $checkpointRoot "ca-policy-$checkpointId.json"
Write-Host "Resolved policy: $($policyPreState.DisplayName); ID: $($policyPreState.Id); checkpoint: $checkpointId; path: $policyCheckpoint"

# SAFETY GATE [rollback-policy-checkpoint-write]
# Target: resolved [POLICY_ID] and one new local checkpoint $checkpointId
# Effect: write one Conditional Access definition outside the repository
# Scope: one no-clobber JSON checkpoint at the displayed $policyCheckpoint path
# Reversibility: remove the local file after the approved retention period
$requiredConfirmation = "WRITE LOCAL POLICY CHECKPOINT $checkpointId FOR [POLICY_ID]"
$confirmation = Read-Host "Type '$requiredConfirmation' to confirm the local write"
if ($confirmation -ceq $requiredConfirmation) {
    $policyCheckpointRecord = [ordered]@{ CheckpointId = $checkpointId; PolicyId = [string]$policyPreState.Id; Policy = $policyPreState }
    $checkpointEncoding = [Text.UTF8Encoding]::new($false, $true)
    $checkpointJson = ConvertTo-Json -InputObject $policyCheckpointRecord -Depth 10
    $checkpointBytes = $checkpointEncoding.GetBytes($checkpointJson)
    $checkpointContentHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($checkpointBytes)).Replace('-', '').ToLowerInvariant()
    $resolvedRoot = [IO.Path]::GetFullPath($checkpointRoot).TrimEnd('\', '/')
    $resolvedCheckpoint = [IO.Path]::GetFullPath($policyCheckpoint)
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
        if ([string]$readBackCheckpoint.CheckpointId -cne $checkpointId -or [string]$readBackCheckpoint.PolicyId -cne '[POLICY_ID]' -or [string]$readBackCheckpoint.Policy.Id -cne '[POLICY_ID]') { throw "Checkpoint parse read-back did not preserve the immutable policy ID." }
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
        throw "Checkpoint persistence failed for ID $checkpointId and immutable policy [POLICY_ID]. Final state: $finalState. Temp cleanup: $tempCleanup. No remote change may proceed. Error: $($persistenceError.Exception.Message)"
    }
    Write-Host "Verified checkpoint $checkpointId; content SHA256: $checkpointContentHash; path: $resolvedCheckpoint"
} else {
    throw "Confirmation did not match. No file was written."
}

# Prefer Report-only mode over live edits when testing CA changes (see /conditional-access)
```

## Pattern 5 — Irreversible operations (no rollback exists)

Device wipe, mailbox purge, permanent deletes: there is **no** rollback state to capture.
The entire control is front-loaded:

1. R3 gate (SR-2): ⚠️ flag, exact blast radius, who's affected, typed confirmation.
2. Evidence capture instead of state capture: record device ID/serial/user/ticket in the
   checkpoint file — you can't undo, but you must be able to prove exactly what was done.
3. Prefer the reversible sibling when one exists: `Retire` (removes work data, BYOD-safe)
   before `Wipe`; soft-delete (30-day recycle) before hard-delete; disable before delete.

**If a step has no undo and no reversible sibling, it gets the strongest gate in the file —
never batch it, never script it into a loop with other steps.**

## Related

- `CLAUDE.md` → Zero-Trust Execution Contract — when each pattern is mandatory (R2/R3)
- [safety_patterns.md](safety_patterns.md) — WhatIf and dry-run guards (run those FIRST)
- [../../security/threat_model.md](../../security/threat_model.md) — probe T7 tests Pattern 3's failure path
