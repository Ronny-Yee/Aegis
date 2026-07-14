'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE = path.join(ROOT, 'scripts', 'hermes-bridge.ps1');
const bridgeSource = fs.readFileSync(BRIDGE, 'utf8');
const commandFiles = [
  '.claude/commands/ask-hermes.md',
  '.claude/commands/dashboard-render.md',
  '.claude/commands/war-room.md',
  '.claude/commands/alpha-signal.md',
  '.claude/commands/morning-brief.md',
  '.claude/commands/portfolio-status.md',
  '.claude/commands/hermes-status.md',
  'docs/hermes-integration.md',
  '.claude/skills/hermes-bridge-powershell/SKILL.md',
  '.claude/skills/war-room-ops/SKILL.md',
];

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function balancedFences(source) {
  let open = null;
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!match) continue;
    if (!open) open = match[1];
    else if (match[1][0] === open[0] && match[1].length >= open.length) open = null;
  }
  return open === null;
}

function validQuery(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  return normalized.length > 0 &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(normalized) &&
    Buffer.byteLength(normalized, 'utf8') <= 8192;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validName(value) {
  return /^war_room_(?:v30_)?[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.html$/.test(value) && !value.includes('..');
}

function exact(expected, submitted) {
  return typeof submitted === 'string' && submitted.length > 0 && submitted === expected;
}

function simulateCopyOpen({ copyExpected, copySubmitted, copyExit, regularVerified, selectedSize, selectedHash, localSize, localHash, openExpected, openSubmitted }) {
  let copyCalls = 0;
  let openCalls = 0;
  if (!exact(copyExpected, copySubmitted)) return { copyCalls, openCalls, state: 'copy-declined' };
  copyCalls += 1;
  if (copyExit !== 0) return { copyCalls, openCalls, state: 'copy-failed' };
  if (!regularVerified) return { copyCalls, openCalls, state: 'verification-failed' };
  if (localSize !== selectedSize) return { copyCalls, openCalls, state: 'size-mismatch' };
  if (localHash !== selectedHash) return { copyCalls, openCalls, state: 'hash-mismatch' };
  if (!exact(openExpected, openSubmitted)) return { copyCalls, openCalls, state: 'open-declined' };
  openCalls += 1;
  return { copyCalls, openCalls, state: 'opened' };
}

test('authorized Hermes Markdown is syntactically complete and local logs are inert', () => {
  for (const file of commandFiles) {
    const source = read(file);
    assert.ok(source.endsWith('\n'), `${file}: missing final newline`);
    assert.ok(balancedFences(source), `${file}: unbalanced Markdown fence`);
  }
  for (const file of commandFiles.filter((name) => /commands\/(?:ask-hermes|dashboard-render|war-room|alpha-signal|morning-brief|portfolio-status|hermes-status)\.md$/.test(name))) {
    const source = read(file);
    assert.doesNotMatch(source, /Append to the repository-relative `\.aegis-state\/hermes-escalation-log\.md`/i, `${file}: live log append remains`);
    assert.match(source, /PREVIEW ONLY/i, `${file}: missing inert audit/cache boundary`);
  }

  const projectBrain = read('CLAUDE.md');
  assert.doesNotMatch(projectBrain, /verbatim answer/i, 'CLAUDE.md: stale verbatim-output promise remains');
  assert.doesNotMatch(projectBrain, /logs to `hermes-escalation-log\.md`/i, 'CLAUDE.md: stale automatic-log claim remains');
  assert.doesNotMatch(projectBrain, /write local audit logs under `\.aegis-state\/`/i, 'CLAUDE.md: stale live-log claim remains');
  assert.match(projectBrain, /Automatic (?:local )?logging is disabled/i, 'CLAUDE.md: missing disabled-log boundary');
  assert.match(projectBrain, /separate(?:ly confirmed)? local-write (?:gate|path)/i, 'CLAUDE.md: missing separate local-write authorization boundary');
});

test('legacy query interpolation, raw latest-path use, and timestamp-only destinations are absent', () => {
  const askSurface = `${read('.claude/commands/ask-hermes.md')}\n${read('docs/hermes-integration.md')}`;
  assert.doesNotMatch(askSurface, /hermes\s+-z\s+["'][^\n]*<(?:query|the user query)/i);
  assert.doesNotMatch(askSurface, /internal double-quotes escaped/i);

  const warRoomSurface = `${read('.claude/commands/war-room.md')}\n${read('.claude/skills/hermes-bridge-powershell/SKILL.md')}`;
  assert.doesNotMatch(warRoomSurface, /\$latest\s*=\s*ssh/i);
  assert.doesNotMatch(warRoomSurface, /Get-Date\s+-Format\s+yyyyMMdd_HHmmss/i);
  assert.doesNotMatch(warRoomSurface, /Start-Process\s+\$env:WAR_ROOM_URL/i);
});

test('query remote command is constant and query bytes are stdin payload data', () => {
  assert.match(bridgeSource, /\$script:HermesAskRemoteCommand\s*=\s*'[^'\r\n]*(?:''[^'\r\n]*)*'/);
  assert.equal((bridgeSource.match(/\$script:HermesAskRemoteCommand\s*=/g) || []).length, 1);
  assert.match(bridgeSource, /base64 --decode/);
  assert.match(bridgeSource, /READ_ONLY_QUERY:\$query/);
  assert.match(bridgeSource, /requested READ_ONLY_QUERY policy marker, which is not a technical sandbox/);
  assert.match(bridgeSource, /Invoke-HermesSshWire -Payload \$request\.Payload -RemoteCommand \$request\.RemoteCommand/);
});

test('render and selector wrappers use structured stdin, argv execution, and atomic no-clobber checks', t => {
  assert.match(bridgeSource, /base64\.b64decode\(wire, validate=True\)/);
  assert.match(bridgeSource, /subprocess\.run\(\s*\[sys\.executable, str\(renderer\), "--date", date_text\]/s);
  assert.doesNotMatch(bridgeSource, /shell\s*=\s*True/);
  assert.match(bridgeSource, /os\.O_WRONLY \| os\.O_CREAT \| os\.O_EXCL \| os\.O_NOFOLLOW/);
  assert.match(bridgeSource, /current\.st_dev != reservation\.st_dev/);
  assert.match(bridgeSource, /current\.st_ino != reservation\.st_ino/);
  assert.match(bridgeSource, /error="destination-exists"/);
  assert.match(bridgeSource, /pattern\.fullmatch\(item\.name\)/);
  assert.match(bridgeSource, /item\.is_file\(\) and not item\.is_symlink\(\)/);
  assert.match(bridgeSource, /0 < metadata\.st_size <= MAX_FILE_BYTES/);
  assert.match(bridgeSource, /os\.O_NOFOLLOW/);
  assert.match(bridgeSource, /stat_module\.S_ISREG\(before\.st_mode\)/);
  assert.match(bridgeSource, /digest = hashlib\.sha256\(\)/);
  assert.match(bridgeSource, /after = os\.fstat\(descriptor\)/);
  assert.match(bridgeSource, /sha256=digest\.hexdigest\(\)/);

  const renderMatch = bridgeSource.match(/\$script:HermesRenderProgram = @'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(renderMatch, 'render Python program was not found');
  const selectorMatch = bridgeSource.match(/\$script:HermesSelectorProgram = @'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(selectorMatch, 'selector Python program was not found');
  const pythonCandidates = process.platform === 'win32' ? ['python.exe', 'python'] : ['python3', 'python'];
  let python = null;
  for (const candidate of pythonCandidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) continue;
    python = candidate;
    break;
  }
  if (!python) {
    t.skip('Python is unavailable; structural no-clobber assertions still ran.');
    return;
  }
  for (const [name, program] of [['render', renderMatch[1]], ['selector', selectorMatch[1]]]) {
    const compile = spawnSync(python, ['-c', `import sys; compile(sys.stdin.read(), "<hermes-${name}>", "exec")`], { input: program, encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
  }

  const noFollow = spawnSync(python, ['-c', 'import os,sys;sys.exit(0 if hasattr(os,"O_NOFOLLOW") else 1)']);
  if (noFollow.status !== 0) return; // Exact remote behavior is exercised on the Ubuntu CI leg.

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-hermes-render-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const scriptsDir = path.join(fixtureRoot, 'scripts');
  const deliveryDir = path.join(fixtureRoot, 'delivery');
  fs.mkdirSync(scriptsDir);
  fs.mkdirSync(deliveryDir);
  const renderer = path.join(scriptsDir, 'render_war_room_dashboard.py');
  fs.writeFileSync(renderer, [
    'import argparse, os, pathlib',
    'p=argparse.ArgumentParser(); p.add_argument("--date", required=True); a=p.parse_args()',
    'dest=pathlib.Path(os.environ["HERMES_TEST_DELIVERY"]) / ("war_room_" + a.date.replace("-", "") + ".html")',
    'dest.write_text("verified dashboard", encoding="utf-8")',
  ].join('\n'), 'utf8');
  const destination = path.join(deliveryDir, 'war_room_20260713.html');
  fs.writeFileSync(destination, 'concurrent owner content', 'utf8');
  const wire = Buffer.from(JSON.stringify({ date: '2026-07-13', scriptsDir: scriptsDir.replaceAll('\\', '/'), deliveryDir: deliveryDir.replaceAll('\\', '/') })).toString('base64');
  const collision = spawnSync(python, ['-c', renderMatch[1]], {
    input: wire,
    encoding: 'utf8',
    env: { ...process.env, HERMES_TEST_DELIVERY: deliveryDir },
  });
  assert.equal(collision.status, 73, collision.stderr || collision.stdout);
  assert.equal(JSON.parse(collision.stdout).error, 'destination-exists');
  assert.equal(fs.readFileSync(destination, 'utf8'), 'concurrent owner content');

  fs.unlinkSync(destination);
  const success = spawnSync(python, ['-c', renderMatch[1]], {
    input: wire,
    encoding: 'utf8',
    env: { ...process.env, HERMES_TEST_DELIVERY: deliveryDir },
  });
  assert.equal(success.status, 0, success.stderr || success.stdout);
  assert.equal(JSON.parse(success.stdout).ok, true);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'verified dashboard');
});

test('copy is content-bound, GUID-based, collision checked twice, and open follows exact verification', () => {
  assert.match(bridgeSource, /aegis-war-room-\{0\}\.html/);
  assert.match(bridgeSource, /Generated War Room destination already exists/);
  assert.match(bridgeSource, /destination collision detected immediately before copy/i);
  assert.match(bridgeSource, /CONTENT SHA256 \{2\} SIZE \{3\}/);
  const scpArgumentsStart = bridgeSource.indexOf('$scpArguments = @(');
  const copyIndex = bridgeSource.indexOf('& $scp @scpArguments');
  assert.ok(scpArgumentsStart >= 0 && scpArgumentsStart < copyIndex, 'SCP argument block was not found');
  const scpArgumentsSource = bridgeSource.slice(scpArgumentsStart, copyIndex);
  assert.doesNotMatch(scpArgumentsSource, /['"]-(?:T|O|r)['"]/);
  const exitIndex = bridgeSource.indexOf('if ($copyExit -ne 0)', copyIndex);
  const verifyIndex = bridgeSource.indexOf('Get-Item -LiteralPath $destination', exitIndex);
  const sizeIndex = bridgeSource.indexOf('if ([int64]$item.Length -ne $selected.Size)', verifyIndex);
  const hashIndex = bridgeSource.indexOf('Get-FileHash -LiteralPath $destination', verifyIndex);
  const hashMatchIndex = bridgeSource.indexOf('if ($downloadHash -cne $selected.Sha256)', hashIndex);
  const openIndex = bridgeSource.indexOf('Start-Process -FilePath $destination', hashMatchIndex);
  assert.ok(copyIndex >= 0 && copyIndex < exitIndex && exitIndex < verifyIndex && verifyIndex < sizeIndex && sizeIndex < hashIndex && hashIndex < hashMatchIndex && hashMatchIndex < openIndex);
  assert.match(bridgeSource, /It remains at \{0\} and was not opened/);
});

test('URL and basename policy models reject executable and traversal inputs', () => {
  const validNames = ['war_room_20260713.html', 'war_room_v30_2026-07-13.html', 'war_room_v30_safe_01.html'];
  const invalidNames = ['', '../war_room_20260713.html', 'war_room_.._x.html', 'war_room_x.html\nnext', 'war_room_x.htm', '/tmp/war_room_x.html'];
  validNames.forEach((value) => assert.equal(validName(value), true, value));
  invalidNames.forEach((value) => assert.equal(validName(value), false, value));

  const urlSource = bridgeSource.slice(bridgeSource.indexOf('function Assert-HermesWarRoomUri'), bridgeSource.indexOf('function Test-HermesExactConfirmation'));
  assert.match(urlSource, /Scheme -ceq 'http' -and \$uri\.IsLoopback/);
  assert.match(urlSource, /Scheme -cne 'https'/);
  assert.match(urlSource, /AllowedHost/);
  assert.match(urlSource, /UserInfo/);
  assert.match(urlSource, /Fragment/);
});

test('table-driven models enforce query/date/exact-confirmation boundaries', () => {
  const validQueries = ['hello', 'quotes " \' ; $(id) `id` | & * ?', 'line one\nline two', 'Unicode café — ✓'];
  const invalidQueries = ['', '   ', `bad${String.fromCharCode(0)}nul`, `bad${String.fromCharCode(27)}escape`, 'a'.repeat(8193)];
  validQueries.forEach((value) => assert.equal(validQuery(value), true));
  invalidQueries.forEach((value) => assert.equal(validQuery(value), false));

  ['2028-02-29', '2026-07-13'].forEach((value) => assert.equal(validDate(value), true));
  ['2027-02-29', '2026-13-01', '2026-00-01', '2026-01-32', ' 2026-07-13', '2026-07-13;id'].forEach((value) => assert.equal(validDate(value), false));

  const expected = `CREATE WAR ROOM COPY C:\\Temp\\a.html SOURCE SHA256 ${'a'.repeat(64)} CONTENT SHA256 ${'b'.repeat(64)} SIZE 123`;
  [undefined, null, '', 'yes', 'YES', ` ${expected}`, `${expected} `, expected.toLowerCase()].forEach((value) => assert.equal(exact(expected, value), false));
  assert.equal(exact(expected, expected), true);
});

test('inert copy/open model never opens after decline, transfer failure, or content mismatch', () => {
  const base = { copyExpected: 'COPY', openExpected: 'OPEN', regularVerified: true, selectedSize: 3, selectedHash: 'abc', localSize: 3, localHash: 'abc' };
  assert.deepEqual(simulateCopyOpen({ ...base, copySubmitted: '', copyExit: 0, openSubmitted: 'OPEN' }), { copyCalls: 0, openCalls: 0, state: 'copy-declined' });
  assert.deepEqual(simulateCopyOpen({ ...base, copySubmitted: 'COPY', copyExit: 1, openSubmitted: 'OPEN' }), { copyCalls: 1, openCalls: 0, state: 'copy-failed' });
  assert.deepEqual(simulateCopyOpen({ ...base, copySubmitted: 'COPY', copyExit: 0, regularVerified: false, openSubmitted: 'OPEN' }), { copyCalls: 1, openCalls: 0, state: 'verification-failed' });
  assert.deepEqual(simulateCopyOpen({ ...base, copySubmitted: 'COPY', copyExit: 0, localSize: 4, openSubmitted: 'OPEN' }), { copyCalls: 1, openCalls: 0, state: 'size-mismatch' });
  assert.deepEqual(simulateCopyOpen({ ...base, copySubmitted: 'COPY', copyExit: 0, localHash: 'def', openSubmitted: 'OPEN' }), { copyCalls: 1, openCalls: 0, state: 'hash-mismatch' });
  assert.deepEqual(simulateCopyOpen({ ...base, copySubmitted: 'COPY', copyExit: 0, openSubmitted: 'yes' }), { copyCalls: 1, openCalls: 0, state: 'open-declined' });
  assert.deepEqual(simulateCopyOpen({ ...base, copySubmitted: 'COPY', copyExit: 0, openSubmitted: 'OPEN' }), { copyCalls: 1, openCalls: 1, state: 'opened' });
});

test('actual PowerShell 5.1-compatible functions pass an inert source harness', (t) => {
  const candidates = process.platform === 'win32' ? ['powershell.exe'] : ['pwsh'];
  let engine = null;
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (probe.status === 0) { engine = candidate; break; }
  }
  if (!engine) {
    t.skip('PowerShell is unavailable; platform-independent structural/model checks still ran.');
    return;
  }

  const bridgeLiteral = BRIDGE.replace(/'/g, "''");
  const harness = String.raw`
$ErrorActionPreference = 'Stop'
. '${bridgeLiteral}'
function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }

$adversarial = 'quotes " '' ; $(Get-Process) ' + [char]96 + 'Get-Date' + [char]96 + ' | & * ?' + [Environment]::NewLine + 'Unicode ' + [char]0x00e9 + ' ' + [char]0x2014 + ' ' + [char]0x2713
$first = Get-HermesAskRequest -Value 'plain query'
$second = Get-HermesAskRequest -Value $adversarial
Assert-True ($first.RemoteCommand -ceq $second.RemoteCommand) 'query changed the remote command'
Assert-True (-not $second.RemoteCommand.Contains($adversarial)) 'query leaked into remote command'
$decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($second.Payload))
Assert-True ($decoded -ceq $adversarial) 'stdin payload did not round-trip'

foreach ($bad in @('', ' ', ([string][char]0), ([string][char]27), ('a' * 8193))) {
    $threw = $false
    try { Assert-HermesQuery -Value $bad | Out-Null } catch { $threw = $true }
    Assert-True $threw 'invalid query was accepted'
}
Assert-True ((Assert-HermesDate -Value '2028-02-29') -ceq '2028-02-29') 'valid leap date rejected'
foreach ($bad in @('2027-02-29', '2026-13-01', ' 2026-07-13', '2026-07-13;id')) {
    $threw = $false
    try { Assert-HermesDate -Value $bad | Out-Null } catch { $threw = $true }
    Assert-True $threw 'invalid date was accepted'
}
Assert-True ((Assert-HermesWarRoomName -Value 'war_room_v30_2026-07-13.html') -ceq 'war_room_v30_2026-07-13.html') 'valid name rejected'
foreach ($bad in @('../war_room_x.html', 'war_room_.._x.html', ('war_room_x.html' + [Environment]::NewLine + 'next'))) {
    $threw = $false
    try { Assert-HermesWarRoomName -Value $bad | Out-Null } catch { $threw = $true }
    Assert-True $threw 'invalid basename was accepted'
}
$validSha = 'a' * 64
$validMetadata = [pscustomobject]@{ ok = $true; name = 'war_room_v30_2026-07-13.html'; size = [int]3; mtimeNs = [long]123; sha256 = $validSha }
$validatedMetadata = Assert-HermesSelectedArtifact -Value $validMetadata
Assert-True ($validatedMetadata.Name -ceq 'war_room_v30_2026-07-13.html') 'valid selector name was rejected'
Assert-True ($validatedMetadata.Size -eq 3 -and $validatedMetadata.MtimeNs -eq 123 -and $validatedMetadata.Sha256 -ceq $validSha) 'valid selector metadata changed during validation'
$badMetadataCases = @(
    [pscustomobject]@{ ok = $true; name = 'war_room_x.html'; size = '3'; mtimeNs = [long]123; sha256 = $validSha }
    [pscustomobject]@{ ok = $true; name = 'war_room_x.html'; size = [int]0; mtimeNs = [long]123; sha256 = $validSha }
    [pscustomobject]@{ ok = $true; name = 'war_room_x.html'; size = [int]52428801; mtimeNs = [long]123; sha256 = $validSha }
    [pscustomobject]@{ ok = $true; name = 'war_room_x.html'; size = [int]3; mtimeNs = '123'; sha256 = $validSha }
    [pscustomobject]@{ ok = $true; name = 'war_room_x.html'; size = [int]3; mtimeNs = [long]123; sha256 = ('A' * 64) }
    [pscustomobject]@{ ok = $true; name = '../war_room_x.html'; size = [int]3; mtimeNs = [long]123; sha256 = $validSha }
    [pscustomobject]@{ ok = $true; name = 'war_room_x.html'; size = [int]3; mtimeNs = [long]123; sha256 = $validSha; extra = 'unexpected' }
)
foreach ($badMetadata in $badMetadataCases) {
    $threw = $false
    try { Assert-HermesSelectedArtifact -Value $badMetadata | Out-Null } catch { $threw = $true }
    Assert-True $threw 'invalid selector metadata was accepted'
}
$uri = Assert-HermesWarRoomUri -Value 'https://dashboard.example.test/' -AllowedHost 'dashboard.example.test'
Assert-True ($uri.AbsoluteUri -ceq 'https://dashboard.example.test/') 'valid HTTPS URI rejected'
foreach ($bad in @('file:///C:/temp/a.html', 'javascript:alert(1)', ('https://user' + '@' + 'dashboard.example.test/'), 'https://wrong.example.test/')) {
    $threw = $false
    try { Assert-HermesWarRoomUri -Value $bad -AllowedHost 'dashboard.example.test' | Out-Null } catch { $threw = $true }
    Assert-True $threw 'invalid URI was accepted'
}

$expected = 'CREATE [TEST_TARGET]'
foreach ($bad in @($null, '', 'yes', 'YES', ' CREATE [TEST_TARGET]', 'CREATE [TEST_TARGET] ')) {
    $script:hits = 0
    $threw = $false
    try {
        Invoke-HermesConfirmedAction -Target '[TEST_TARGET]' -Effect 'Creates one inert test marker.' -Scope 'One inert sink.' -Reversibility 'None needed.' -Expected $expected -Submitted $bad -Sink { $script:hits += 1 } | Out-Null
    } catch { $threw = $true }
    Assert-True ($threw -and $script:hits -eq 0) 'rejected confirmation reached the inert sink'
}
$script:hits = 0
Invoke-HermesConfirmedAction -Target '[TEST_TARGET]' -Effect 'Creates one inert test marker.' -Scope 'One inert sink.' -Reversibility 'None needed.' -Expected $expected -Submitted $expected -Sink { $script:hits += 1 } | Out-Null
Assert-True ($script:hits -eq 1) 'exact confirmation did not reach inert sink exactly once'

$knownGuid = [guid]'00112233-4455-6677-8899-aabbccddeeff'
$destination = New-HermesWarRoomDestination -Id $knownGuid
Assert-True ($destination.EndsWith('aegis-war-room-00112233445566778899aabbccddeeff.html')) 'GUID destination is not deterministic'

$renderOne = Get-HermesRenderRequest -Value '2028-02-29' -RemoteScriptsDir '/opt/hermes/scripts' -RemoteDeliveryDir '/opt/hermes/delivery'
$renderTwo = Get-HermesRenderRequest -Value '2028-03-01' -RemoteScriptsDir '/srv/hermes/scripts' -RemoteDeliveryDir '/srv/hermes/delivery'
Assert-True ($renderOne.RemoteCommand -ceq $renderTwo.RemoteCommand) 'render input changed the static remote command'
Assert-True (-not $renderOne.RemoteCommand.Contains('2028-02-29')) 'date leaked into render command'
Assert-True (-not $renderOne.RemoteCommand.Contains('/opt/hermes')) 'path leaked into render command'

$planOne = Get-HermesRenderPlan -Value '2028-02-29' -RemoteScriptsDir '/opt/hermes/scripts' -RemoteDeliveryDir '/opt/hermes/delivery' -User 'operator' -HostName 'hermes.example.test'
$planReplay = Get-HermesRenderPlan -Value '2028-02-29' -RemoteScriptsDir '/opt/hermes/scripts' -RemoteDeliveryDir '/opt/hermes/delivery' -User 'operator' -HostName 'hermes.example.test'
$planDifferentRenderer = Get-HermesRenderPlan -Value '2028-02-29' -RemoteScriptsDir '/srv/hermes/scripts' -RemoteDeliveryDir '/opt/hermes/delivery' -User 'operator' -HostName 'hermes.example.test'
Assert-True ($planOne.Confirmation -ceq $planReplay.Confirmation) 'identical render request did not produce a stable confirmation'
Assert-True ($planOne.Confirmation -cne $planDifferentRenderer.Confirmation) 'renderer directory was not bound into the confirmation'

$env:AEGION_DOMAIN = 'private.example.test'
$env:AEGION_ORG_NAME = 'Private Example Org'
$sanitized = ConvertTo-HermesSafeOutput -Value ('alice' + '@private.example.test Private Example Org hermes.private operator-private') -ResolvedHost 'hermes.private' -ResolvedUser 'operator-private'
Assert-True (-not $sanitized.Contains('alice')) 'UPN local part remained in sanitized output'
Assert-True (-not $sanitized.Contains('private.example.test')) 'configured tenant domain remained in sanitized output'
Assert-True (-not $sanitized.Contains('Private Example Org')) 'configured organization remained in sanitized output'
Assert-True (-not $sanitized.Contains('hermes.private')) 'configured Hermes host remained in sanitized output'
Assert-True (-not $sanitized.Contains('operator-private')) 'configured Hermes account remained in sanitized output'
Assert-True ($sanitized.Contains('[USER@DOMAIN.COM]') -and $sanitized.Contains('[@Aegion]') -and $sanitized.Contains('[HERMES_HOST]') -and $sanitized.Contains('[HERMES_SSH_USER]')) 'canonical sanitized tokens were missing'

Write-Output 'HERMES_POWERSHELL_TEST_OK'
`;
  const encoded = Buffer.from(harness, 'utf16le').toString('base64');
  const result = spawnSync(engine, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  assert.equal(result.status, 0, `${result.stderr || result.stdout}`);
  assert.match(result.stdout, /HERMES_POWERSHELL_TEST_OK/);
});
