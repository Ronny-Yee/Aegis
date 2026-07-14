[CmdletBinding()]
param(
    [ValidateSet('Ask', 'Render', 'WarRoom', 'ValidateQuery', 'ValidateDate', 'ValidateUrl', 'ValidateBasename', 'DescribeAsk', 'DescribeRender', 'DescribeSelector')]
    [string]$Action,
    [string]$Query,
    [string]$Date,
    [string]$WarRoomUrl = $env:WAR_ROOM_URL,
    [string]$AllowedWebHost = $env:WAR_ROOM_ALLOWED_HOST,
    [string]$SshUser = $env:HERMES_SSH_USER,
    [string]$SshHost = $env:HERMES_HOST,
    [string]$ScriptsDir = $env:HERMES_SCRIPTS_DIR,
    [string]$DeliveryDir = $env:HERMES_DELIVERY_DIR,
    [string]$SshPath = 'C:\Windows\System32\OpenSSH\ssh.exe',
    [string]$ScpPath = 'C:\Windows\System32\OpenSSH\scp.exe'
)

# This command is deliberately constant. Query bytes travel only on SSH stdin.
$script:HermesAskRemoteCommand = 'IFS=; set -f; query=$(tr -d ''\r\n'' | base64 --decode) || exit 64; [ ${#query} -le 8192 ] || exit 64; exec timeout 240 hermes -z READ_ONLY_QUERY:$query'
$script:WarRoomNamePattern = '^war_room_(?:v30_)?[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.html$'
$script:HermesMaximumArtifactBytes = [int64]52428800

$script:HermesRenderProgram = @'
import base64, datetime, json, os, pathlib, re, stat as stat_module, subprocess, sys, time

def finish(code, **values):
    print(json.dumps(values, separators=(",", ":")))
    raise SystemExit(code)

try:
    wire = b"".join(sys.stdin.buffer.read().split())
    request = json.loads(base64.b64decode(wire, validate=True).decode("utf-8"))
except Exception:
    finish(64, ok=False, error="invalid-request")

if set(request) != {"date", "scriptsDir", "deliveryDir"}:
    finish(64, ok=False, error="invalid-request-keys")

date_text = request["date"]
if not isinstance(date_text, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", date_text):
    finish(64, ok=False, error="invalid-date")
try:
    if datetime.date.fromisoformat(date_text).isoformat() != date_text:
        finish(64, ok=False, error="invalid-date")
except ValueError:
    finish(64, ok=False, error="invalid-date")

scripts_dir = pathlib.Path(request["scriptsDir"])
delivery_dir = pathlib.Path(request["deliveryDir"])
if not scripts_dir.is_absolute() or not delivery_dir.is_absolute():
    finish(64, ok=False, error="invalid-directory")
if any(part in (".", "..") for part in scripts_dir.parts + delivery_dir.parts):
    finish(64, ok=False, error="invalid-directory")

renderer = scripts_dir / "render_war_room_dashboard.py"
destination = delivery_dir / ("war_room_" + date_text.replace("-", "") + ".html")
if not renderer.is_file() or renderer.is_symlink():
    finish(66, ok=False, error="renderer-unavailable")
if not hasattr(os, "O_NOFOLLOW"):
    finish(70, ok=False, error="nofollow-unavailable")

# Reserve the final name atomically. The reviewed renderer may write only into
# this invocation-owned inode; an existing file, link, or concurrent creator wins.
try:
    descriptor = os.open(
        str(destination),
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0),
        0o600,
    )
except FileExistsError:
    finish(73, ok=False, error="destination-exists", name=destination.name)
except OSError:
    finish(73, ok=False, error="destination-reservation-failed", name=destination.name)

try:
    reservation = os.fstat(descriptor)
finally:
    os.close(descriptor)

def fail_after_reservation(code, error):
    partial_state = "destination-missing"
    try:
        current = destination.lstat()
        if not stat_module.S_ISREG(current.st_mode) or current.st_dev != reservation.st_dev or current.st_ino != reservation.st_ino:
            partial_state = "destination-identity-unknown"
        elif current.st_size == 0:
            try:
                destination.unlink()
                partial_state = "empty-reservation-removed"
            except OSError:
                partial_state = "empty-reservation-unresolved"
        else:
            partial_state = "partial-artifact-present"
    except OSError:
        pass
    finish(code, ok=False, error=error, name=destination.name, partialState=partial_state)

started_ns = time.time_ns()
try:
    completed = subprocess.run(
        [sys.executable, str(renderer), "--date", date_text],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=240,
        check=False,
    )
except subprocess.TimeoutExpired:
    fail_after_reservation(124, "renderer-timeout")
except Exception:
    fail_after_reservation(70, "renderer-start-failed")

if completed.returncode != 0:
    fail_after_reservation(completed.returncode or 70, "renderer-failed")
try:
    stat = destination.lstat()
except OSError:
    fail_after_reservation(74, "artifact-missing")
if (
    not stat_module.S_ISREG(stat.st_mode)
    or stat.st_dev != reservation.st_dev
    or stat.st_ino != reservation.st_ino
    or stat.st_size <= 0
    or stat.st_mtime_ns + 5_000_000_000 < started_ns
):
    fail_after_reservation(74, "artifact-verification-failed")

finish(0, ok=True, name=destination.name, size=stat.st_size, mtimeNs=stat.st_mtime_ns)
'@

$script:HermesSelectorProgram = @'
import base64, hashlib, json, os, pathlib, re, stat as stat_module, sys

MAX_FILE_BYTES = 52_428_800

def finish(code, **values):
    print(json.dumps(values, separators=(",", ":")))
    raise SystemExit(code)

try:
    wire = b"".join(sys.stdin.buffer.read().split())
    request = json.loads(base64.b64decode(wire, validate=True).decode("utf-8"))
except Exception:
    finish(64, ok=False, error="invalid-request")

if set(request) != {"deliveryDir"}:
    finish(64, ok=False, error="invalid-request-keys")
root = pathlib.Path(request["deliveryDir"])
if not root.is_absolute() or any(part in (".", "..") for part in root.parts):
    finish(64, ok=False, error="invalid-directory")
if not root.is_dir() or root.is_symlink():
    finish(66, ok=False, error="delivery-directory-unavailable")

pattern = re.compile(r"war_room_(?:v30_)?[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.html")
candidates = []
for item in root.iterdir():
    if pattern.fullmatch(item.name) and ".." not in item.name and item.is_file() and not item.is_symlink():
        try:
            metadata = item.stat()
            if 0 < metadata.st_size <= MAX_FILE_BYTES:
                candidates.append((metadata.st_mtime_ns, item.name))
        except OSError:
            pass
if not candidates:
    finish(66, ok=False, error="dashboard-not-found")

_, name = max(candidates)
chosen = root / name
if not hasattr(os, "O_NOFOLLOW"):
    finish(70, ok=False, error="nofollow-unavailable")
try:
    descriptor = os.open(str(chosen), os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0))
except OSError:
    finish(66, ok=False, error="dashboard-open-failed")

try:
    before = os.fstat(descriptor)
    if not stat_module.S_ISREG(before.st_mode) or not (0 < before.st_size <= MAX_FILE_BYTES):
        finish(66, ok=False, error="dashboard-metadata-invalid")
    digest = hashlib.sha256()
    bytes_read = 0
    while True:
        chunk = os.read(descriptor, 1024 * 1024)
        if not chunk:
            break
        bytes_read += len(chunk)
        if bytes_read > MAX_FILE_BYTES:
            finish(66, ok=False, error="dashboard-size-invalid")
        digest.update(chunk)
    after = os.fstat(descriptor)
    if (
        bytes_read != before.st_size
        or after.st_size != before.st_size
        or after.st_mtime_ns != before.st_mtime_ns
        or after.st_dev != before.st_dev
        or after.st_ino != before.st_ino
    ):
        finish(75, ok=False, error="dashboard-changed-during-hash")
finally:
    os.close(descriptor)

finish(
    0,
    ok=True,
    name=name,
    size=before.st_size,
    mtimeNs=before.st_mtime_ns,
    sha256=digest.hexdigest(),
)
'@

function Get-HermesUtf8Bytes {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    $encoding = New-Object System.Text.UTF8Encoding($false, $true)
    return $encoding.GetBytes($Value)
}

function Get-HermesSha256Hex {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Get-HermesStringSha256 {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    return Get-HermesSha256Hex -Bytes (Get-HermesUtf8Bytes -Value $Value)
}

function Assert-HermesTarget {
    param(
        [Parameter(Mandatory = $true)][string]$User,
        [Parameter(Mandatory = $true)][string]$HostName
    )

    if ($User -cnotmatch '^[A-Za-z_][A-Za-z0-9_.-]{0,63}$') {
        throw 'Hermes SSH user is invalid.'
    }
    if ($HostName.Length -gt 253 -or $HostName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $HostName.Contains('..')) {
        throw 'Hermes SSH host or config alias is invalid.'
    }
    return ('{0}@{1}' -f $User, $HostName)
}

function Assert-HermesPosixPath {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.Length -gt 1024 -or $Value -cnotmatch '^/[A-Za-z0-9._/-]+$' -or $Value.Contains('//')) {
        throw 'Hermes path is invalid.'
    }
    $normalized = $Value.TrimEnd('/')
    if ([string]::IsNullOrEmpty($normalized)) {
        throw 'Hermes path is invalid.'
    }
    foreach ($part in $normalized.Split('/')) {
        if ($part -ceq '.' -or $part -ceq '..') {
            throw 'Hermes path traversal is not allowed.'
        }
    }
    return $normalized
}

function Assert-HermesQuery {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    $normalized = $Value.Trim()
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        throw 'Hermes query is required.'
    }
    if ($normalized.IndexOf([char]0) -ge 0 -or $normalized -match '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]') {
        throw 'Hermes query contains a prohibited control character.'
    }
    $bytes = Get-HermesUtf8Bytes -Value $normalized
    if ($bytes.Length -gt 8192) {
        throw 'Hermes query exceeds the 8192-byte UTF-8 limit.'
    }
    return [pscustomobject]@{
        Value   = $normalized
        Bytes   = $bytes
        Hash    = Get-HermesSha256Hex -Bytes $bytes
        Payload = [System.Convert]::ToBase64String($bytes)
    }
}

function Assert-HermesDate {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    $parsed = [datetime]::MinValue
    $culture = [System.Globalization.CultureInfo]::InvariantCulture
    $styles = [System.Globalization.DateTimeStyles]::None
    if (-not [datetime]::TryParseExact($Value, 'yyyy-MM-dd', $culture, $styles, [ref]$parsed)) {
        throw 'Dashboard date must be a real date in YYYY-MM-DD form.'
    }
    if ($parsed.ToString('yyyy-MM-dd', $culture) -cne $Value) {
        throw 'Dashboard date must round-trip exactly as YYYY-MM-DD.'
    }
    return $Value
}

function Assert-HermesWarRoomName {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    if ($Value -cnotmatch $script:WarRoomNamePattern -or $Value.Contains('..')) {
        throw 'War Room filename is invalid.'
    }
    return $Value
}

function Assert-HermesWarRoomUri {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value,
        [AllowEmptyString()][string]$AllowedHost
    )

    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -match '[\x00-\x1F\x7F]') {
        throw 'WAR_ROOM_URL is invalid.'
    }
    $uri = $null
    if (-not [uri]::TryCreate($Value, [System.UriKind]::Absolute, [ref]$uri)) {
        throw 'WAR_ROOM_URL must be an absolute URI.'
    }
    if (-not [string]::IsNullOrEmpty($uri.UserInfo) -or -not [string]::IsNullOrEmpty($uri.Fragment)) {
        throw 'WAR_ROOM_URL cannot contain user information or a fragment.'
    }
    if ($uri.Scheme -ceq 'http' -and $uri.IsLoopback) {
        return $uri
    }
    if ($uri.Scheme -cne 'https' -or -not $uri.IsDefaultPort) {
        throw 'WAR_ROOM_URL must use default-port HTTPS, or HTTP on loopback.'
    }
    if ([string]::IsNullOrWhiteSpace($AllowedHost) -or $uri.IdnHost -cne $AllowedHost.Trim().ToLowerInvariant()) {
        throw 'WAR_ROOM_URL host is not the configured allowed host.'
    }
    return $uri
}

function Test-HermesExactConfirmation {
    param(
        [Parameter(Mandatory = $true)][string]$Expected,
        [AllowNull()][AllowEmptyString()][string]$Submitted
    )

    return -not [string]::IsNullOrEmpty($Submitted) -and $Submitted -ceq $Expected
}

function Invoke-HermesConfirmedAction {
    param(
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$Effect,
        [Parameter(Mandatory = $true)][string]$Scope,
        [Parameter(Mandatory = $true)][string]$Reversibility,
        [Parameter(Mandatory = $true)][string]$Expected,
        [Parameter(Mandatory = $true)][scriptblock]$Sink,
        [AllowNull()][AllowEmptyString()][string]$Submitted
    )

    Write-Host ('Target: {0}' -f $Target)
    Write-Host ('Effect: {0}' -f $Effect)
    Write-Host ('Scope: {0}' -f $Scope)
    Write-Host ('Reversibility: {0}' -f $Reversibility)
    Write-Host ('Required confirmation: {0}' -f $Expected)
    if (-not $PSBoundParameters.ContainsKey('Submitted')) {
        $Submitted = Read-Host 'Type the required confirmation exactly'
    }
    if (Test-HermesExactConfirmation -Expected $Expected -Submitted $Submitted) {
        return & $Sink
    }
    else {
        throw 'Exact confirmation did not match; no action was run.'
    }
}

function ConvertTo-HermesWirePayload {
    param([Parameter(Mandatory = $true)]$Value)

    $json = ConvertTo-Json -InputObject $Value -Compress
    return [System.Convert]::ToBase64String((Get-HermesUtf8Bytes -Value $json))
}

function ConvertTo-HermesRemotePythonCommand {
    param([Parameter(Mandatory = $true)][string]$Program)

    $hex = ([System.BitConverter]::ToString((Get-HermesUtf8Bytes -Value $Program))).Replace('-', '').ToLowerInvariant()
    return ("python3 -c exec\(bytes.fromhex\(\'{0}\'\)\)" -f $hex)
}

function Get-HermesAskRequest {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    $queryInfo = Assert-HermesQuery -Value $Value
    return [pscustomobject]@{
        Query         = $queryInfo.Value
        QueryHash     = $queryInfo.Hash
        Payload       = $queryInfo.Payload
        RemoteCommand = $script:HermesAskRemoteCommand
    }
}

function Get-HermesRenderRequest {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$RemoteScriptsDir,
        [Parameter(Mandatory = $true)][string]$RemoteDeliveryDir
    )

    $validDate = Assert-HermesDate -Value $Value
    $validScripts = Assert-HermesPosixPath -Value $RemoteScriptsDir
    $validDelivery = Assert-HermesPosixPath -Value $RemoteDeliveryDir
    $name = 'war_room_{0}.html' -f $validDate.Replace('-', '')
    $request = [ordered]@{
        date        = $validDate
        scriptsDir  = $validScripts
        deliveryDir = $validDelivery
    }
    return [pscustomobject]@{
        Date          = $validDate
        ExpectedName  = $name
        Payload       = ConvertTo-HermesWirePayload -Value $request
        RemoteCommand = ConvertTo-HermesRemotePythonCommand -Program $script:HermesRenderProgram
    }
}

function Get-HermesRenderPlan {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$RemoteScriptsDir,
        [Parameter(Mandatory = $true)][string]$RemoteDeliveryDir,
        [Parameter(Mandatory = $true)][string]$User,
        [Parameter(Mandatory = $true)][string]$HostName
    )

    $request = Get-HermesRenderRequest -Value $Value -RemoteScriptsDir $RemoteScriptsDir -RemoteDeliveryDir $RemoteDeliveryDir
    $target = Assert-HermesTarget -User $User -HostName $HostName
    $requestHash = Get-HermesStringSha256 -Value $request.Payload
    $descriptor = 'render|{0}|request-sha256|{1}' -f $target, $requestHash
    $actionHash = Get-HermesStringSha256 -Value $descriptor
    return [pscustomobject]@{
        Request      = $request
        Target       = $target
        RequestHash  = $requestHash
        ActionHash   = $actionHash
        Confirmation = 'CREATE WAR ROOM DASHBOARD {0} ACTION SHA256 {1}' -f $request.Date, $actionHash
    }
}

function Get-HermesSelectorRequest {
    param([Parameter(Mandatory = $true)][string]$RemoteDeliveryDir)

    $validDelivery = Assert-HermesPosixPath -Value $RemoteDeliveryDir
    $request = [ordered]@{ deliveryDir = $validDelivery }
    return [pscustomobject]@{
        DeliveryDir   = $validDelivery
        Payload       = ConvertTo-HermesWirePayload -Value $request
        RemoteCommand = ConvertTo-HermesRemotePythonCommand -Program $script:HermesSelectorProgram
    }
}

function New-HermesWarRoomDestination {
    param([guid]$Id = [guid]::NewGuid())

    $destination = Join-Path ([System.IO.Path]::GetTempPath()) ('aegis-war-room-{0}.html' -f $Id.ToString('N'))
    if (Test-Path -LiteralPath $destination) {
        throw 'Generated War Room destination already exists; refusing to overwrite it.'
    }
    return [System.IO.Path]::GetFullPath($destination)
}

function Assert-HermesExecutable {
    param([Parameter(Mandatory = $true)][string]$Value)

    if (-not (Test-Path -LiteralPath $Value -PathType Leaf)) {
        throw 'Required OpenSSH executable is unavailable.'
    }
    return [System.IO.Path]::GetFullPath($Value)
}

function Invoke-HermesSshWire {
    param(
        [Parameter(Mandatory = $true)][string]$Payload,
        [Parameter(Mandatory = $true)][string]$RemoteCommand,
        [Parameter(Mandatory = $true)][string]$User,
        [Parameter(Mandatory = $true)][string]$HostName,
        [Parameter(Mandatory = $true)][string]$Executable
    )

    $target = Assert-HermesTarget -User $User -HostName $HostName
    $ssh = Assert-HermesExecutable -Value $Executable
    $nativeArguments = @(
        '-T', '-a', '-x',
        '-o', 'BatchMode=yes',
        '-o', 'ClearAllForwardings=yes',
        '-o', 'ConnectTimeout=15',
        $target,
        $RemoteCommand
    )
    $previousEncoding = $OutputEncoding
    try {
        $OutputEncoding = [System.Text.Encoding]::ASCII
        $output = @($Payload | & $ssh @nativeArguments 2>&1)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $OutputEncoding = $previousEncoding
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = $output }
}

function ConvertFrom-HermesJsonResult {
    param([Parameter(Mandatory = $true)]$Result)

    $text = (@($Result.Output | ForEach-Object { [string]$_ }) -join "`n")
    if ($text.Length -gt 65536) {
        throw 'Hermes returned an oversized control response.'
    }
    try {
        $value = ConvertFrom-Json -InputObject $text
    }
    catch {
        throw 'Hermes returned an invalid control response.'
    }
    if ($Result.ExitCode -ne 0 -or $value.ok -ne $true) {
        $errorCode = if ($value.error) { [string]$value.error } else { 'remote-failure' }
        $partialState = if ($value.PSObject.Properties.Name -ccontains 'partialState' -and
            @('destination-missing', 'destination-identity-unknown', 'empty-reservation-removed', 'empty-reservation-unresolved', 'partial-artifact-present') -ccontains [string]$value.partialState) {
            [string]$value.partialState
        }
        else {
            'not-reported'
        }
        throw ('Hermes operation failed safely (exit {0}, code {1}, partial state {2}).' -f $Result.ExitCode, $errorCode, $partialState)
    }
    return $value
}

function Assert-HermesSelectedArtifact {
    param([Parameter(Mandatory = $true)]$Value)

    $requiredProperties = @('ok', 'name', 'size', 'mtimeNs', 'sha256')
    $actualProperties = @($Value.PSObject.Properties | ForEach-Object { $_.Name })
    $missingProperties = @($requiredProperties | Where-Object { $actualProperties -cnotcontains $_ })
    if ($actualProperties.Count -ne $requiredProperties.Count -or $missingProperties.Count -ne 0) {
        throw 'Hermes selector returned an unexpected metadata shape.'
    }
    if ($Value.ok -isnot [bool] -or $Value.ok -ne $true -or $Value.name -isnot [string]) {
        throw 'Hermes selector returned invalid status or filename metadata.'
    }
    if (($Value.size -isnot [int] -and $Value.size -isnot [long]) -or
        [int64]$Value.size -le 0 -or [int64]$Value.size -gt $script:HermesMaximumArtifactBytes) {
        throw 'Hermes selector returned an invalid artifact size.'
    }
    if (($Value.mtimeNs -isnot [int] -and $Value.mtimeNs -isnot [long]) -or [int64]$Value.mtimeNs -le 0) {
        throw 'Hermes selector returned an invalid artifact timestamp.'
    }
    if ($Value.sha256 -isnot [string] -or $Value.sha256 -cnotmatch '^[0-9a-f]{64}$') {
        throw 'Hermes selector returned an invalid artifact SHA-256.'
    }

    return [pscustomobject]@{
        Name     = Assert-HermesWarRoomName -Value $Value.name
        Size     = [int64]$Value.size
        MtimeNs  = [int64]$Value.mtimeNs
        Sha256   = $Value.sha256
    }
}

function ConvertTo-HermesSafeOutput {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value,
        [AllowEmptyString()][string]$ResolvedHost = '',
        [AllowEmptyString()][string]$ResolvedUser = ''
    )

    if ($Value.Length -gt 262144) {
        throw 'Hermes response exceeded the local display limit.'
    }
    $safe = $Value -replace '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', [char]0xFFFD
    # Email/UPN-looking strings are minimized before exact configured values.
    $safe = $safe -ireplace '(?<![A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]+@[A-Za-z0-9](?:[A-Za-z0-9.\-]{0,251}[A-Za-z0-9])?(?![A-Za-z0-9.\-])', '[USER@DOMAIN.COM]'
    $redactions = @(
        [pscustomobject]@{ Value = $env:AEGION_DOMAIN; Token = '[@Aegion_DOMAIN]' }
        [pscustomobject]@{ Value = $env:AEGION_ORG_NAME; Token = '[@Aegion]' }
        [pscustomobject]@{ Value = $ResolvedHost; Token = '[HERMES_HOST]' }
        [pscustomobject]@{ Value = $ResolvedUser; Token = '[HERMES_SSH_USER]' }
    )
    foreach ($redaction in $redactions) {
        if (-not [string]::IsNullOrWhiteSpace([string]$redaction.Value) -and ([string]$redaction.Value).Length -ge 3) {
            $safe = $safe -ireplace [regex]::Escape([string]$redaction.Value), [string]$redaction.Token
        }
    }
    return $safe
}

function Invoke-HermesAsk {
    $request = Get-HermesAskRequest -Value $Query
    $target = Assert-HermesTarget -User $SshUser -HostName $SshHost
    $targetHash = (Get-HermesStringSha256 -Value $target).Substring(0, 16)
    $expected = 'SEND READ-ONLY HERMES QUERY SHA256 {0} TO TARGET {1}' -f $request.QueryHash, $targetHash
    $result = Invoke-HermesConfirmedAction `
        -Target ('Hermes target digest {0}' -f $targetHash) `
        -Effect 'Sends one advisory query over SSH with a requested READ_ONLY_QUERY policy marker, which is not a technical sandbox; query bytes are stdin data, never shell syntax.' `
        -Scope ('One query, SHA256 {0}; no retry.' -f $request.QueryHash) `
        -Reversibility 'No remote administrative change is authorized; data disclosure cannot be undone.' `
        -Expected $expected `
        -Sink { Invoke-HermesSshWire -Payload $request.Payload -RemoteCommand $request.RemoteCommand -User $SshUser -HostName $SshHost -Executable $SshPath }

    if ($result.ExitCode -ne 0) {
        throw ('Hermes query failed safely with exit code {0}.' -f $result.ExitCode)
    }
    $text = (@($result.Output | ForEach-Object { [string]$_ }) -join "`n")
    if ([string]::IsNullOrWhiteSpace($text)) {
        throw 'Hermes returned no output; no automatic retry was attempted.'
    }
    return ConvertTo-HermesSafeOutput -Value $text -ResolvedHost $SshHost -ResolvedUser $SshUser
}

function Invoke-HermesRender {
    $renderDate = if ([string]::IsNullOrEmpty($Date)) { Get-Date -Format 'yyyy-MM-dd' } else { $Date }
    $plan = Get-HermesRenderPlan -Value $renderDate -RemoteScriptsDir $ScriptsDir -RemoteDeliveryDir $DeliveryDir -User $SshUser -HostName $SshHost
    $request = $plan.Request
    $target = $plan.Target
    $requestHash = $plan.RequestHash
    $actionHash = $plan.ActionHash
    $expected = $plan.Confirmation
    $result = Invoke-HermesConfirmedAction `
        -Target ('Hermes dashboard {0}; private target and full render request bound by SHA256 {1}' -f $request.ExpectedName, $actionHash) `
        -Effect 'Atomically reserves and creates exactly one new remote dashboard artifact; an existing path or concurrent creator wins.' `
        -Scope ('One date, renderer directory, delivery directory, and filename: {0}; request SHA256 {1}.' -f $request.ExpectedName, $requestHash) `
        -Reversibility 'Removing the exact new artifact is a separate destructive action requiring its own approval.' `
        -Expected $expected `
        -Sink { Invoke-HermesSshWire -Payload $request.Payload -RemoteCommand $request.RemoteCommand -User $SshUser -HostName $SshHost -Executable $SshPath }

    return ConvertFrom-HermesJsonResult -Result $result
}

function Invoke-HermesWarRoomUrl {
    $uri = Assert-HermesWarRoomUri -Value $WarRoomUrl -AllowedHost $AllowedWebHost
    $expected = 'CREATE BROWSER LAUNCH FOR {0}' -f $uri.AbsoluteUri
    return Invoke-HermesConfirmedAction `
        -Target $uri.AbsoluteUri `
        -Effect 'Creates one default-browser launch for the validated War Room URL.' `
        -Scope 'One local browser launch; no file is created.' `
        -Reversibility 'Close the browser tab or window.' `
        -Expected $expected `
        -Sink { Start-Process -FilePath $uri.AbsoluteUri }
}

function Invoke-HermesWarRoomPull {
    $selector = Get-HermesSelectorRequest -RemoteDeliveryDir $DeliveryDir
    $selectionResult = ConvertFrom-HermesJsonResult -Result (Invoke-HermesSshWire -Payload $selector.Payload -RemoteCommand $selector.RemoteCommand -User $SshUser -HostName $SshHost -Executable $SshPath)
    $selected = Assert-HermesSelectedArtifact -Value $selectionResult
    $name = $selected.Name
    $destination = New-HermesWarRoomDestination
    $target = Assert-HermesTarget -User $SshUser -HostName $SshHost
    $remotePath = '{0}/{1}' -f $selector.DeliveryDir, $name
    $source = '{0}:{1}' -f $target, $remotePath
    $sourceHash = Get-HermesStringSha256 -Value $source
    $copyExpected = 'CREATE WAR ROOM COPY {0} SOURCE SHA256 {1} CONTENT SHA256 {2} SIZE {3}' -f $destination, $sourceHash, $selected.Sha256, $selected.Size

    Invoke-HermesConfirmedAction `
        -Target ('New local file {0}; private source bound by SHA256 {1}; content SHA256 {2}; size {3} bytes' -f $destination, $sourceHash, $selected.Sha256, $selected.Size) `
        -Effect 'Creates exactly one local HTML copy of the selected content; an existing destination is never accepted.' `
        -Scope ('One validated remote file named {0}, exactly {1} bytes, and one GUID destination.' -f $name, $selected.Size) `
        -Reversibility 'The local copy may be removed later only as a separate destructive action.' `
        -Expected $copyExpected `
        -Sink {
            if (Test-Path -LiteralPath $destination) {
                throw 'War Room destination collision detected immediately before copy.'
            }
            $scp = Assert-HermesExecutable -Value $ScpPath
            $scpArguments = @(
                '-q',
                '-o', 'BatchMode=yes',
                '-o', 'ClearAllForwardings=yes',
                '-o', 'ConnectTimeout=15',
                $source,
                $destination
            )
            & $scp @scpArguments
            $copyExit = $LASTEXITCODE
            if ($copyExit -ne 0) {
                throw ('War Room copy failed with exit code {0}; any partial file remains at {1}.' -f $copyExit, $destination)
            }
        } | Out-Null

    try {
        $item = Get-Item -LiteralPath $destination -ErrorAction Stop
    }
    catch {
        throw ('Downloaded War Room file is unavailable at {0}; no browser was opened.' -f $destination)
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -or
        $item.Length -le 0 -or $item.Length -gt $script:HermesMaximumArtifactBytes) {
        throw ('Downloaded War Room file failed regular-file verification. It remains at {0} and was not opened.' -f $destination)
    }
    if ([int64]$item.Length -ne $selected.Size) {
        throw ('Downloaded War Room size did not match the approved remote size. It remains at {0} and was not opened.' -f $destination)
    }
    $downloadHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($downloadHash -cne $selected.Sha256) {
        throw ('Downloaded War Room SHA-256 did not match the approved remote content. It remains at {0} and was not opened.' -f $destination)
    }
    $openExpected = 'CREATE BROWSER LAUNCH FOR {0} SHA256 {1}' -f $destination, $downloadHash
    Invoke-HermesConfirmedAction `
        -Target ('Verified local file {0}, SHA256 {1}' -f $destination, $downloadHash) `
        -Effect 'Creates one default-browser launch for the verified local HTML file.' `
        -Scope 'One browser launch; the downloaded file remains unchanged.' `
        -Reversibility 'Close the browser tab or window.' `
        -Expected $openExpected `
        -Sink { Start-Process -FilePath $destination } | Out-Null

    return [pscustomobject]@{ Name = $name; Destination = $destination; Sha256 = $downloadHash }
}

function Invoke-HermesWarRoom {
    if (-not [string]::IsNullOrWhiteSpace($WarRoomUrl)) {
        return Invoke-HermesWarRoomUrl
    }
    return Invoke-HermesWarRoomPull
}

if ($MyInvocation.InvocationName -eq '.') {
    return
}

if ([string]::IsNullOrWhiteSpace($Action)) {
    throw 'Specify an explicit Hermes bridge action.'
}

switch ($Action) {
    'Ask' { Invoke-HermesAsk }
    'Render' { Invoke-HermesRender }
    'WarRoom' { Invoke-HermesWarRoom }
    'ValidateQuery' {
        $value = Assert-HermesQuery -Value $Query
        [pscustomobject]@{ ok = $true; hash = $value.Hash; bytes = $value.Bytes.Length } | ConvertTo-Json -Compress
    }
    'ValidateDate' { [pscustomobject]@{ ok = $true; date = (Assert-HermesDate -Value $Date) } | ConvertTo-Json -Compress }
    'ValidateUrl' {
        $value = Assert-HermesWarRoomUri -Value $WarRoomUrl -AllowedHost $AllowedWebHost
        [pscustomobject]@{ ok = $true; url = $value.AbsoluteUri } | ConvertTo-Json -Compress
    }
    'ValidateBasename' { [pscustomobject]@{ ok = $true; name = (Assert-HermesWarRoomName -Value $Query) } | ConvertTo-Json -Compress }
    'DescribeAsk' { Get-HermesAskRequest -Value $Query | Select-Object QueryHash, Payload, RemoteCommand | ConvertTo-Json -Compress }
    'DescribeRender' { Get-HermesRenderRequest -Value $Date -RemoteScriptsDir $ScriptsDir -RemoteDeliveryDir $DeliveryDir | Select-Object Date, ExpectedName, Payload, RemoteCommand | ConvertTo-Json -Compress }
    'DescribeSelector' { Get-HermesSelectorRequest -RemoteDeliveryDir $DeliveryDir | Select-Object DeliveryDir, Payload, RemoteCommand | ConvertTo-Json -Compress }
}
