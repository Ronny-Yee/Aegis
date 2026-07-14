# PowerShell Examples — M365, Intune, Active Directory

Reusable scripts for common IT operations tasks. Every script:
- Explains each line in plain English comments
- Uses `$DryRun` flag for bulk operations
- Uses placeholder variables — replace before running
- Includes a verification step at the end

---

## EX-01 — Get All Users Without MFA

```powershell
# Connect to Microsoft Graph with the required permissions
Connect-MgGraph -Scopes "UserAuthenticationMethod.Read.All", "User.Read.All"

# Get all users who have at least one license assigned
$users = Get-MgUser -All `
  -Filter "assignedLicenses/`$count ne 0" `
  -CountVariable licCount `
  -ConsistencyLevel eventual `
  -Property DisplayName, UserPrincipalName, Department, Id

$results = foreach ($user in $users) {
    # Get all authentication methods registered for this user
    $methods = Get-MgUserAuthenticationMethod -UserId $user.Id

    # Filter out password — we only care about MFA methods
    $mfaMethods = $methods | Where-Object {
        $_.AdditionalProperties['@odata.type'] -notmatch 'password'
    }

    # If no MFA methods found, add to results
    if (-not $mfaMethods) {
        [PSCustomObject]@{
            DisplayName = $user.DisplayName
            UPN         = $user.UserPrincipalName
            Department  = $user.Department
        }
    }
}

# Display results
$results | Format-Table -AutoSize
Write-Host "Total users without MFA: $($results.Count)"

# Export sensitive identity data outside the repository working tree
# PREVIEW ONLY [automation-no-mfa-report]: $reportRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Aegis\reports'
# New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
# $reportPath = Join-Path $reportRoot "no-mfa-users-$(Get-Date -f yyyyMMdd).csv"
# $results | Export-Csv -LiteralPath $reportPath -NoTypeInformation
# Route this local PII-bearing report write to a separately reviewed R1 action; do not create it from this example.
```

---

## EX-02 — Bulk License Assignment

```powershell
# ⚠️ Bulk operation — review $DryRun flag before running
$DryRun = $true  # Set to $false only after reviewing WhatIf output

Connect-MgGraph -Scopes "User.ReadWrite.All", "Directory.ReadWrite.All"

# Replace with the SKU ID for your license
# To find SKU IDs: Get-MgSubscribedSku | Select-Object SkuPartNumber, SkuId
$licenseSkuId = "[LICENSE_SKU_ID]"  # e.g., M365 Business Premium SKU ID

# List of UPNs to assign licenses to
$targetUsers = @(
    "[UPN]",
    "[USER@DOMAIN.COM]"
    # Add more UPNs here
)

# Build the license assignment object
$licenseAssignment = @{
    addLicenses    = @(@{ skuId = $licenseSkuId })
    removeLicenses = @()
}

if ($targetUsers.Count -eq 0) { throw "No target users were staged. No change was made." }
$expectedCountText = Read-Host "Enter the independently approved expected target count"
$expectedCount = 0
if (-not [int]::TryParse($expectedCountText, [ref]$expectedCount) -or $expectedCount -le 0) {
    throw "Expected count must be a positive integer. No change was made."
}
if ($targetUsers.Count -ne $expectedCount) { throw "Staged count did not match the independently approved count. No change was made." }

$resolvedUsers = @(foreach ($requestedUpn in $targetUsers) {
    $resolved = Get-MgUser -UserId $requestedUpn -Property Id,UserPrincipalName,AssignedLicenses -ErrorAction Stop
    [PSCustomObject]@{
        Id = [string]$resolved.Id
        UserPrincipalName = [string]$resolved.UserPrincipalName
        AssignedLicenses = @($resolved.AssignedLicenses | ForEach-Object {
            [PSCustomObject]@{
                SkuId = [string]$_.SkuId
                DisabledPlans = @($_.DisabledPlans | ForEach-Object { [string]$_ })
            }
        })
    }
})
if ($resolvedUsers.Count -ne $expectedCount -or @($resolvedUsers.Id | Sort-Object -Unique).Count -ne $expectedCount) {
    throw "User resolution produced missing or duplicate immutable IDs. No change was made."
}
$resolvedUsers = @($resolvedUsers | Sort-Object Id)
$resolvedUserManifest = @($resolvedUsers | ForEach-Object { "$($_.Id)`t$($_.UserPrincipalName)" }) -join "`n"
$resolvedUserSetHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($resolvedUserManifest))).Replace('-', '').ToLowerInvariant()
Write-Host "Staged target count: $expectedCount; license SKU: $licenseSkuId"
$resolvedUsers | ForEach-Object { Write-Host "  target: $($_.UserPrincipalName); ID: $($_.Id)" }
Write-Host "Target-set SHA256: $resolvedUserSetHash"

if ($DryRun) {
    foreach ($resolvedUser in $resolvedUsers) {
        Write-Host "[DRY RUN] Would assign license $licenseSkuId to: $($resolvedUser.UserPrincipalName) [$($resolvedUser.Id)]"
    }
} else {
    $checkpointId = [Guid]::NewGuid().ToString('N')
    $checkpointRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Aegis\checkpoints'
    $checkpointPath = Join-Path $checkpointRoot "bulk-license-$checkpointId.json"
    $preState = @($resolvedUsers | Select-Object Id,UserPrincipalName,AssignedLicenses)
    if ($preState.Count -ne $expectedCount) { throw "Pre-state cardinality drifted. No change was made." }
    $checkpoint = [ordered]@{
        CheckpointId = $checkpointId
        TargetSetSHA256 = $resolvedUserSetHash
        LicenseSkuId = $licenseSkuId
        Users = $preState
    }

    # SAFETY GATE [automation-bulk-license-checkpoint-write]
    # Target: one new local checkpoint $checkpointId for $resolvedUserSetHash
    # Effect: writes exact immutable user/license/service-plan pre-state outside the repository
    # Scope: one no-clobber JSON file at the displayed $checkpointPath
    # Reversibility: remove the local file after the approved retention period
    $requiredConfirmation = "WRITE LOCAL BULK LICENSE CHECKPOINT $checkpointId FOR $expectedCount USERS SET SHA256 $resolvedUserSetHash"
    $confirmation = Read-Host "Type '$requiredConfirmation' to confirm"
    if ($confirmation -ceq $requiredConfirmation) {
        $checkpointEncoding = [Text.UTF8Encoding]::new($false, $true)
        $checkpointJson = ConvertTo-Json -InputObject $checkpoint -Depth 8
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
            if ([string]$readBackCheckpoint.CheckpointId -cne $checkpointId -or [string]$readBackCheckpoint.TargetSetSHA256 -cne $resolvedUserSetHash -or @($readBackCheckpoint.Users).Count -ne $expectedCount) { throw "Checkpoint parse read-back did not preserve the immutable target set." }
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
            throw "Checkpoint persistence failed for ID $checkpointId and target-set SHA256 $resolvedUserSetHash. Final state: $finalState. Temp cleanup: $tempCleanup. No remote change may proceed. Error: $($persistenceError.Exception.Message)"
        }
        Write-Host "Verified checkpoint $checkpointId; content SHA256: $checkpointContentHash; path: $resolvedCheckpoint"
    } else {
        throw "Confirmation did not match. No file was written."
    }

    # SAFETY GATE [automation-bulk-license]
    # Target: $resolvedUserSetHash, $licenseSkuId, and verified checkpoint $checkpointId with $checkpointContentHash
    # Effect: assigns one reviewed license SKU to each staged user
    # Scope: exactly $expectedCount identities; stop on the first failure
    # Reversibility: restore each user's AssignedLicenses and DisabledPlans from the hash-bound $checkpointPath
    $requiredConfirmation = "ASSIGN LICENSE $licenseSkuId TO $expectedCount USERS SET SHA256 $resolvedUserSetHash USING CHECKPOINT $checkpointId CONTENT SHA256 $checkpointContentHash"
    $confirmation = Read-Host "Type '$requiredConfirmation' to confirm"
    if ($confirmation -ceq $requiredConfirmation) {
        try {
            $approvedCheckpointBytes = [IO.File]::ReadAllBytes($resolvedCheckpoint)
            $approvedCheckpointHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($approvedCheckpointBytes)).Replace('-', '').ToLowerInvariant()
            if ($approvedCheckpointHash -cne $checkpointContentHash) { throw "Checkpoint content drifted after approval." }
            $approvedCheckpoint = ConvertFrom-Json -InputObject ($checkpointEncoding.GetString($approvedCheckpointBytes)) -ErrorAction Stop
            if ([string]$approvedCheckpoint.CheckpointId -cne $checkpointId -or [string]$approvedCheckpoint.TargetSetSHA256 -cne $resolvedUserSetHash -or [string]$approvedCheckpoint.LicenseSkuId -cne [string]$licenseSkuId -or @($approvedCheckpoint.Users).Count -ne $expectedCount) { throw "Checkpoint identity or scope drifted after approval." }
        } catch {
            throw "Checkpoint revalidation failed immediately before the Graph mutation. No license was assigned. $($_.Exception.Message)"
        }

        $currentUsers = @(foreach ($approvedUser in $resolvedUsers) {
            $current = Get-MgUser -UserId $approvedUser.Id -Property Id,UserPrincipalName -ErrorAction Stop
            if ([string]$current.Id -cne [string]$approvedUser.Id -or [string]$current.UserPrincipalName -cne [string]$approvedUser.UserPrincipalName) { throw "Target identity drifted after approval. No license was assigned." }
            [PSCustomObject]@{ Id = [string]$current.Id; UserPrincipalName = [string]$current.UserPrincipalName }
        })
        $currentManifest = @($currentUsers | Sort-Object Id | ForEach-Object { "$($_.Id)`t$($_.UserPrincipalName)" }) -join "`n"
        $currentSetHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($currentManifest))).Replace('-', '').ToLowerInvariant()
        if ($currentSetHash -cne $resolvedUserSetHash) { throw "Target-set digest drifted after approval. No license was assigned." }

        $completedUserIds = [System.Collections.Generic.List[string]]::new()
        for ($index = 0; $index -lt $resolvedUsers.Count; $index++) {
            $resolvedUser = $resolvedUsers[$index]
            try {
                Set-MgUserLicense -UserId $resolvedUser.Id -BodyParameter $licenseAssignment -ErrorAction Stop
                $readBack = Get-MgUser -UserId $resolvedUser.Id -Property Id,AssignedLicenses -ErrorAction Stop
                if ([string]$readBack.Id -cne [string]$resolvedUser.Id -or -not @($readBack.AssignedLicenses | Where-Object { [string]$_.SkuId -eq [string]$licenseSkuId }).Count) {
                    throw "Read-back did not prove the approved SKU on the immutable user ID."
                }
                $completedUserIds.Add($resolvedUser.Id)
                Write-Host "Assigned and verified license for: $($resolvedUser.UserPrincipalName) [$($resolvedUser.Id)]"
            } catch {
                $notAttemptedIds = @($resolvedUsers | Select-Object -Skip ($index + 1) | ForEach-Object { $_.Id })
                throw "Stopped at immutable ID $($resolvedUser.Id), whose state is UNKNOWN/POSSIBLY CHANGED. Verified completed IDs: $($completedUserIds -join ', '). Not-attempted IDs: $($notAttemptedIds -join ', '). Checkpoint: $checkpointId. $($_.Exception.Message)"
            }
        }
    } else {
        throw "Confirmation did not match. No change was made."
    }
}

# Verification step (runs in both modes)
Write-Host "`nVerification:"
foreach ($resolvedUser in $resolvedUsers) {
    $user = Get-MgUser -UserId $resolvedUser.Id -Property AssignedLicenses -ErrorAction Stop
    $hasLicense = $user.AssignedLicenses | Where-Object { $_.SkuId -eq $licenseSkuId }
    $status = if ($hasLicense) { "✓ Licensed" } else { "✗ No license" }
    Write-Host "  $($resolvedUser.UserPrincipalName) — $status"
}
```

---

## EX-03 — Export All Group Members

```powershell
# Get all members of a specific security group
Connect-MgGraph -Scopes "Group.Read.All", "User.Read.All"

$groupName = "[GROUP_DISPLAY_NAME]"  # Replace with the group name

# Find the group by display name
$group = Get-MgGroup -Filter "displayName eq '$groupName'" -ConsistencyLevel eventual

if (-not $group) {
    Write-Host "Group not found: $groupName"
    exit
}

# Get all members of the group
$members = Get-MgGroupMember -GroupId $group.Id -All

# Get display details for each member
$output = foreach ($member in $members) {
    $user = Get-MgUser -UserId $member.Id -Property DisplayName, UserPrincipalName, Department
    [PSCustomObject]@{
        DisplayName = $user.DisplayName
        UPN         = $user.UserPrincipalName
        Department  = $user.Department
    }
}

$output | Sort-Object Department, DisplayName | Format-Table -AutoSize
Write-Host "Total members in '$groupName': $($output.Count)"

# Export sensitive identity data outside the repository working tree
# PREVIEW ONLY [automation-group-members-report]: $reportRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Aegis\reports'
# New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
# $reportPath = Join-Path $reportRoot "group-members-$(Get-Date -f yyyyMMdd).csv"
# $output | Export-Csv -LiteralPath $reportPath -NoTypeInformation
```

---

## EX-04 — Request Entra Session Revocation for a User (Incident Response)

```powershell
# ⚠️ High-impact — invalidates Entra refresh tokens and browser session cookies after propagation
# Current access tokens and sessions issued by individual apps can persist until expiry or app-specific revocation.
Connect-MgGraph -Scopes "User.RevokeSessions.All"

$upn = "[UPN]"  # Replace with the target user's UPN
$sessionUser = Get-MgUser -UserId $upn -Property Id,UserPrincipalName -ErrorAction Stop
if ([string]::IsNullOrWhiteSpace([string]$sessionUser.Id) -or [string]$sessionUser.UserPrincipalName -cne $upn) { throw "The exact Entra identity was not resolved. No change was made." }

# Confirm before proceeding
# SAFETY GATE [automation-token-revoke]
# Target: canonical UPN and immutable ID in $sessionUser
# Effect: invalidates refresh tokens and browser session cookies for the resolved user
# Scope: Entra-managed refresh tokens and browser cookies for one user; app-issued sessions can persist
# Reversibility: not reversible; the user must authenticate again
$requiredConfirmation = "REVOKE ENTRA SESSIONS FOR $($sessionUser.UserPrincipalName) ID $($sessionUser.Id)"
$confirmation = Read-Host "Type '$requiredConfirmation' to confirm"
if ($confirmation -ceq $requiredConfirmation) {
    # Revoke refresh tokens and browser session cookies; do not claim instant sign-out from every application.
    $revocationAccepted = Revoke-MgUserSignInSession -UserId $sessionUser.Id -ErrorAction Stop
    if ($revocationAccepted.Value -ne $true) { throw "Entra did not acknowledge the revocation request. Current session state is unknown." }
    Write-Host "Entra session revocation accepted for: $($sessionUser.UserPrincipalName) [$($sessionUser.Id)]; verify after propagation"
} else {
    throw "Confirmation did not match. No change was made."
}

# Verification — check sign-in logs for recent activity
Write-Host "`nTo verify, check sign-in logs:"
Write-Host "Entra → Users → $upn → Sign-in logs"
```

---

## EX-05 — Find Inactive Users (No Sign-In in 90 Days)

```powershell
# Requires Entra ID P1 or P2 for signInActivity
Connect-MgGraph -Scopes "User.Read.All", "AuditLog.Read.All"

# Calculate cutoff date (90 days ago)
$cutoffDate = (Get-Date).AddDays(-90).ToString("yyyy-MM-ddTHH:mm:ssZ")

# Get all licensed users with their last sign-in date
$users = Get-MgUser -All `
  -Filter "assignedLicenses/`$count ne 0" `
  -CountVariable c -ConsistencyLevel eventual `
  -Property DisplayName, UserPrincipalName, AccountEnabled, SignInActivity

$inactive = $users | Where-Object {
    # Flag if no sign-in on record, or last sign-in before cutoff
    -not $_.SignInActivity.LastSignInDateTime -or
    $_.SignInActivity.LastSignInDateTime -lt $cutoffDate
} | Select-Object DisplayName, UserPrincipalName, AccountEnabled,
    @{N='LastSignIn'; E={
        if ($null -eq $_.SignInActivity.LastSignInDateTime) { "Never" }
        else { $_.SignInActivity.LastSignInDateTime }
    }}

$inactive | Sort-Object LastSignIn | Format-Table -AutoSize
Write-Host "Inactive users (no sign-in in 90+ days): $($inactive.Count)"

# Export sensitive identity data outside the repository working tree
# PREVIEW ONLY [automation-inactive-users-report]: $reportRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Aegis\reports'
# New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
# $reportPath = Join-Path $reportRoot "inactive-users-$(Get-Date -f yyyyMMdd).csv"
# $inactive | Export-Csv -LiteralPath $reportPath -NoTypeInformation
Write-Host "No report was written by this preview. Review the displayed list before proposing any action."
```

---

## EX-06 — Assign Intune Compliance Policy to a Group

```powershell
Connect-MgGraph -Scopes "DeviceManagementConfiguration.ReadWrite.All", "Group.Read.All"

$policyName  = "[COMPLIANCE_POLICY_NAME]"  # Name of the Intune compliance policy
$groupName   = "[TARGET_GROUP_NAME]"        # Entra group to assign it to
$DryRun      = $true                        # Review before executing
if ([string]::IsNullOrWhiteSpace($groupName) -or $groupName -match '[\x00-\x1F\x7F]') { throw "Group name is empty or contains control characters. No change was made." }

# Find the compliance policy
$policies = @(Get-MgDeviceManagementDeviceCompliancePolicy -All |
    Where-Object { $_.DisplayName -eq $policyName })

# Find the group. OData string literals escape an apostrophe as two apostrophes.
$escapedGroupName = $groupName.Replace("'", "''")
$groups = @(Get-MgGroup -Filter "displayName eq '$escapedGroupName'" -Property Id,DisplayName -ConsistencyLevel eventual)

if ($policies.Count -ne 1) { throw "Expected exactly one policy named '$policyName'; found $($policies.Count). No change was made." }
if ($groups.Count -ne 1)   { throw "Expected exactly one group named '$groupName'; found $($groups.Count). No change was made." }
$policy = $policies[0]
$group = $groups[0]
if ([string]$group.DisplayName -cne $groupName -or [string]::IsNullOrWhiteSpace([string]$group.Id)) { throw "The returned group DisplayName did not exactly match the requested name, or its immutable ID was empty. No change was made." }
Write-Host "Target policy: $policyName [$($policy.Id)]"
Write-Host "Target group:  $($group.DisplayName) [$($group.Id)]"

# Read and validate the existing assignment state before creating anything.
$preAssignments = @(Get-MgDeviceManagementDeviceCompliancePolicyAssignment `
    -DeviceCompliancePolicyId $policy.Id `
    -ErrorAction Stop)
function Get-ComplianceAssignmentGroupId {
    param([Parameter(Mandatory)]$Assignment)
    if ($null -eq $Assignment.Target) { return $null }
    if ($Assignment.Target.PSObject.Properties.Name -contains 'GroupId') {
        return [string]$Assignment.Target.GroupId
    }
    if ($null -ne $Assignment.Target.AdditionalProperties -and
        $Assignment.Target.AdditionalProperties.ContainsKey('groupId')) {
        return [string]$Assignment.Target.AdditionalProperties['groupId']
    }
    return $null
}
$existingAssignments = @($preAssignments | Where-Object {
    (Get-ComplianceAssignmentGroupId -Assignment $_) -eq [string]$group.Id
})
if ($existingAssignments.Count -ne 0) {
    throw "The policy already has an assignment for the resolved group. No change was made."
}
$preAssignmentManifest = @($preAssignments | ForEach-Object { "$([string]$_.Id)`t$(Get-ComplianceAssignmentGroupId -Assignment $_)" } | Sort-Object) -join "`n"
$preAssignmentSetHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($preAssignmentManifest))).Replace('-', '').ToLowerInvariant()
Write-Host "Pre-assignment-set SHA256: $preAssignmentSetHash"

if (-not $DryRun) {
    $checkpointId = [Guid]::NewGuid().ToString('N')
    $resultRecordId = [Guid]::NewGuid().ToString('N')
    $checkpointRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Aegis\checkpoints'
    $checkpointPath = Join-Path $checkpointRoot "compliance-assignment-prestate-$checkpointId.json"
    $resultRecordPath = Join-Path $checkpointRoot "compliance-assignment-result-$resultRecordId.json"
    $checkpoint = [ordered]@{
        CheckpointId = $checkpointId
        PolicyId = [string]$policy.Id
        GroupId = [string]$group.Id
        PreAssignmentSetSHA256 = $preAssignmentSetHash
        PreAssignments = @($preAssignments | Select-Object Id,Target)
        CapturedAtUtc = [DateTime]::UtcNow.ToString('o')
    }

    # SAFETY GATE [automation-compliance-checkpoint-write]
    # Target: one new local checkpoint $checkpointId for policy $($policy.Id), resolved group $($group.DisplayName) [$($group.Id)], and $preAssignmentSetHash
    # Effect: writes the exact pre-assignment state outside the repository
    # Scope: one no-clobber JSON file at the displayed $checkpointPath
    # Reversibility: remove the local file after the approved retention period
    $requiredConfirmation = "WRITE LOCAL COMPLIANCE CHECKPOINT $checkpointId FOR POLICY $($policy.Id) GROUP $($group.DisplayName) ID $($group.Id) PRESTATE SHA256 $preAssignmentSetHash"
    $confirmation = Read-Host "Type '$requiredConfirmation' to confirm"
    if ($confirmation -ceq $requiredConfirmation) {
        $checkpointEncoding = [Text.UTF8Encoding]::new($false, $true)
        $checkpointJson = ConvertTo-Json -InputObject $checkpoint -Depth 10
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
            if ([string]$readBackCheckpoint.CheckpointId -cne $checkpointId -or [string]$readBackCheckpoint.PolicyId -cne [string]$policy.Id -or [string]$readBackCheckpoint.GroupId -cne [string]$group.Id -or [string]$readBackCheckpoint.PreAssignmentSetSHA256 -cne $preAssignmentSetHash) { throw "Checkpoint parse read-back did not preserve the immutable policy, group, and pre-state set." }
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
            throw "Checkpoint persistence failed for ID $checkpointId, policy $($policy.Id), group $($group.Id), and pre-state SHA256 $preAssignmentSetHash. Final state: $finalState. Temp cleanup: $tempCleanup. No remote change may proceed. Error: $($persistenceError.Exception.Message)"
        }
        Write-Host "Verified checkpoint $checkpointId; content SHA256: $checkpointContentHash; path: $resolvedCheckpoint"
    } else {
        throw "Confirmation did not match. No file was written."
    }
    if (Test-Path -LiteralPath $resultRecordPath) { throw "Result-record collision. No remote change was made." }

    # SAFETY GATE [automation-compliance-assignment]
    # Target: resolved policy ID, exact returned group DisplayName and ID, $preAssignmentSetHash, checkpoint $checkpointId with $checkpointContentHash, and new local result record $resultRecordId
    # Effect: assigns the compliance policy and writes the verified created-assignment ID to the displayed result record
    # Scope: one policy-to-group assignment and one no-clobber local result JSON; stop on any failure
    # Reversibility: remove only the independently verified created assignment ID, also recorded in $resultRecordPath, through a separate reviewed action
    $requiredConfirmation = "ASSIGN COMPLIANCE POLICY $($policy.Id) TO GROUP $($group.DisplayName) ID $($group.Id) FROM PRESTATE SHA256 $preAssignmentSetHash USING CHECKPOINT $checkpointId CONTENT SHA256 $checkpointContentHash AND WRITE RESULT $resultRecordId"
    $confirmation = Read-Host "Type '$requiredConfirmation' to confirm"
    if ($confirmation -ceq $requiredConfirmation) {
        try {
            $approvedCheckpointBytes = [IO.File]::ReadAllBytes($resolvedCheckpoint)
            $approvedCheckpointHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($approvedCheckpointBytes)).Replace('-', '').ToLowerInvariant()
            if ($approvedCheckpointHash -cne $checkpointContentHash) { throw "Checkpoint content drifted after approval." }
            $approvedCheckpoint = ConvertFrom-Json -InputObject ($checkpointEncoding.GetString($approvedCheckpointBytes)) -ErrorAction Stop
            if ([string]$approvedCheckpoint.CheckpointId -cne $checkpointId -or [string]$approvedCheckpoint.PolicyId -cne [string]$policy.Id -or [string]$approvedCheckpoint.GroupId -cne [string]$group.Id -or [string]$approvedCheckpoint.PreAssignmentSetSHA256 -cne $preAssignmentSetHash) { throw "Checkpoint identity or scope drifted after approval." }
        } catch {
            throw "Checkpoint revalidation failed immediately before the Graph mutation. No assignment was created. $($_.Exception.Message)"
        }

        $currentAssignments = @(Get-MgDeviceManagementDeviceCompliancePolicyAssignment -DeviceCompliancePolicyId $policy.Id -ErrorAction Stop)
        $currentManifest = @($currentAssignments | ForEach-Object { "$([string]$_.Id)`t$(Get-ComplianceAssignmentGroupId -Assignment $_)" } | Sort-Object) -join "`n"
        $currentSetHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($currentManifest))).Replace('-', '').ToLowerInvariant()
        if ($currentSetHash -cne $preAssignmentSetHash -or @($currentAssignments | Where-Object { (Get-ComplianceAssignmentGroupId -Assignment $_) -eq [string]$group.Id }).Count -ne 0) { throw "Assignment pre-state drifted after approval. No assignment was created." }

        $assignment = @{ target = @{ "@odata.type" = "#microsoft.graph.groupAssignmentTarget"; groupId = $group.Id } }
        $verifiedCreatedAssignmentId = $null
        try {
            New-MgDeviceManagementDeviceCompliancePolicyAssignment -DeviceCompliancePolicyId $policy.Id -BodyParameter $assignment -ErrorAction Stop

            $readBack = @(Get-MgDeviceManagementDeviceCompliancePolicyAssignment -DeviceCompliancePolicyId $policy.Id -ErrorAction Stop)
            $createdAssignments = @($readBack | Where-Object { (Get-ComplianceAssignmentGroupId -Assignment $_) -eq [string]$group.Id })
            if ($createdAssignments.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$createdAssignments[0].Id)) { throw "Read-back did not find exactly one created assignment with an ID." }
            $verifiedCreatedAssignmentId = [string]$createdAssignments[0].Id

            $resultRecord = [ordered]@{
                ResultRecordId = $resultRecordId
                CheckpointId = $checkpointId
                PolicyId = [string]$policy.Id
                GroupId = [string]$group.Id
                CreatedAssignmentId = $verifiedCreatedAssignmentId
                VerifiedAtUtc = [DateTime]::UtcNow.ToString('o')
            }
            $resultEncoding = [Text.UTF8Encoding]::new($false, $true)
            $resultJson = ConvertTo-Json -InputObject $resultRecord -Depth 6
            $resultBytes = $resultEncoding.GetBytes($resultJson)
            $resultContentHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($resultBytes)).Replace('-', '').ToLowerInvariant()
            $resolvedResultRoot = [IO.Path]::GetFullPath($checkpointRoot).TrimEnd('\', '/')
            $resolvedResult = [IO.Path]::GetFullPath($resultRecordPath)
            if (-not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetDirectoryName($resolvedResult).TrimEnd('\', '/'), $resolvedResultRoot)) { throw "Result-record target escaped its approved root." }
            $resultTemp = Join-Path $resolvedResultRoot (".$([IO.Path]::GetFileName($resolvedResult)).$([Guid]::NewGuid().ToString('N')).tmp")
            $checkpointTempOwned = $false
            $resultInstalled = $false
            try {
                $rootItem = Get-Item -LiteralPath $resolvedResultRoot -Force -ErrorAction Stop
                if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Result-record root is a reparse point." }
                if (Test-Path -LiteralPath $resolvedResult -ErrorAction Stop) { throw "Result-record collision. The existing file was not changed." }
                $checkpointStream = [IO.FileStream]::new($resultTemp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
                $checkpointTempOwned = $true
                try {
                    $checkpointStream.Write($resultBytes, 0, $resultBytes.Length)
                    $checkpointStream.Flush($true)
                } finally {
                    $checkpointStream.Dispose()
                }
                [IO.File]::Move($resultTemp, $resolvedResult)
                $checkpointTempOwned = $false
                $resultInstalled = $true
                $resultReadBackBytes = [IO.File]::ReadAllBytes($resolvedResult)
                $resultReadBackHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($resultReadBackBytes)).Replace('-', '').ToLowerInvariant()
                if ($resultReadBackHash -cne $resultContentHash) { throw "Result-record hash read-back did not match serialized content." }
                $resultReadBack = ConvertFrom-Json -InputObject ($resultEncoding.GetString($resultReadBackBytes)) -ErrorAction Stop
                if ([string]$resultReadBack.ResultRecordId -cne $resultRecordId -or [string]$resultReadBack.CheckpointId -cne $checkpointId -or [string]$resultReadBack.PolicyId -cne [string]$policy.Id -or [string]$resultReadBack.GroupId -cne [string]$group.Id -or [string]$resultReadBack.CreatedAssignmentId -cne $verifiedCreatedAssignmentId) { throw "Result-record parse read-back did not preserve the verified assignment identity." }
            } catch {
                $resultPersistenceError = $_
                $tempCleanup = 'no invocation-owned temp required cleanup'
                if ($checkpointTempOwned) {
                    try {
                        [IO.File]::Delete($resultTemp)
                        $tempCleanup = if ([IO.File]::Exists($resultTemp)) { "FAILED; invocation-owned temp remains at $resultTemp" } else { 'invocation-owned temp removed' }
                    } catch {
                        $tempCleanup = "FAILED for invocation-owned temp $resultTemp`: $($_.Exception.Message)"
                    }
                }
                $finalState = if ($resultInstalled) { "installed at $resolvedResult but verification is UNKNOWN; file was left for inspection" } else { 'not installed by this invocation' }
                throw "Result-record persistence failed for ID $resultRecordId. Final state: $finalState. Temp cleanup: $tempCleanup. Error: $($resultPersistenceError.Exception.Message)"
            }
            Write-Host "Verified assignment ID $verifiedCreatedAssignmentId for '$policyName' → '$groupName'. Pre-state: $checkpointPath; result: $resultRecordPath"
        } catch {
            if (-not [string]::IsNullOrWhiteSpace([string]$verifiedCreatedAssignmentId)) {
                throw "Assignment processing stopped after independent read-back proved CREATED assignment ID $verifiedCreatedAssignmentId for policy $($policy.Id) and group $($group.Id). Remote state: VERIFIED CHANGED. The local result record may be absent or unverified; rollback must use that exact assignment ID through a separate reviewed action. Checkpoint: $checkpointId; result path: '$resultRecordPath'. $($_.Exception.Message)"
            }
            throw "Assignment processing stopped. The policy assignment is UNKNOWN/POSSIBLY CHANGED and the local result record may be absent; inspect policy $($policy.Id), group $($group.Id), checkpoint '$checkpointPath', and result path '$resultRecordPath'. $($_.Exception.Message)"
        }
    } else {
        throw "Confirmation did not match. No change was made."
    }
}

if ($DryRun) {
    Write-Host "[DRY RUN] Would assign policy '$policyName' to group '$groupName'"
    Write-Host "  Policy ID: $($policy.Id)"
    Write-Host "  Group ID:  $($group.Id)"
}
```
