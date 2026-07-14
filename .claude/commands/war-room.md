---
description: Open a validated War Room HTTPS URL or copy and open one verified dashboard from Aegis D Hermes.
disable-model-invocation: true
---

# /war-room

## Risk metadata

- **Risk level:** R0 remote selection; R1 for one confirmed local HTML copy and each confirmed browser launch. Automatic local logging is disabled.
- **Access:** credential-sensitive remote read, no-clobber local write, and local browser launch.
- **Credential-sensitive:** yes - uses the operator's SSH agent and never reads or prints key material.
- **Invocation:** operator-only; Claude must not invoke this command automatically.

The URL and copy paths are separate. A URL is validated before its launch gate. A pulled dashboard receives one content-bound copy gate, then a second open gate only after the local file exactly matches the selected remote size and SHA-256.

## Path A - configured URL

`WAR_ROOM_URL` must be either:

- default-port HTTPS whose IDN-normalized host exactly matches `WAR_ROOM_ALLOWED_HOST`; or
- HTTP on a loopback host for local development.

The bridge rejects relative URLs, user information, fragments, controls, nondefault remote ports, `file:`, `data:`, `javascript:`, and every other scheme. It then requires:

`CREATE BROWSER LAUNCH FOR <validated-absolute-url>`

## Path B - read-only remote selection, local copy, then open

1. A constant remote Python selector receives the validated delivery directory through SSH stdin.
2. It considers only regular, non-symlink files whose basename matches `war_room_(v30_)?<safe-suffix>.html`.
3. It opens the selected regular file without following symlinks, streams a full SHA-256, verifies the file did not change during hashing, and returns one JSON object containing the basename, bounded positive size, mtime, and lowercase SHA-256. The local bridge strictly validates the exact metadata shape and values.
4. The bridge generates `aegis-war-room-<GUID>.html` under the canonical local temp directory and proves the path is absent.
5. The exact copy source is built only from the validated target, fixed delivery directory, and validated basename. `scp` uses its default strict filename behavior; `-T`, `-O`, and `-r` are forbidden.
6. Immediately before `scp`, the bridge repeats the destination absence check and requires:

   `CREATE WAR ROOM COPY <absolute-guid-destination> SOURCE SHA256 <source-sha256> CONTENT SHA256 <remote-content-sha256> SIZE <remote-size>`

7. A failed transfer stops and leaves any partial file visible for diagnosis. It is never silently deleted.
8. The bridge verifies a regular, non-reparse, nonempty file no larger than 50 MiB, then requires its exact size and full SHA-256 to match the content approved in the copy gate. A mismatch remains visible at the GUID path and is never opened.
9. Opening the verified copy requires a separate phrase:

   `CREATE BROWSER LAUNCH FOR <absolute-guid-destination> SHA256 <download-sha256>`

<details>
<summary>PowerShell - operator-invoked hardened War Room</summary>

```powershell
# Resolve the reviewed implementation from the current repository.
$repoRoot = git rev-parse --show-toplevel
# The bridge owns URL validation, static remote selection, copy collision checks, and both exact launch gates.
$bridge = Join-Path $repoRoot 'scripts\hermes-bridge.ps1'
# Invoke one operator-only flow; no real host or remote path is written into this command file.
& $bridge -Action WarRoom -WarRoomUrl $env:WAR_ROOM_URL -AllowedWebHost $env:WAR_ROOM_ALLOWED_HOST -SshUser '[HERMES_SSH_USER]' -SshHost '[HERMES_HOST]' -DeliveryDir '[HERMES_DELIVERY_DIR]'
```

</details>

<details>
<summary>PowerShell - state-changing phase owned by the bridge (do not run separately)</summary>

The validated variables below are produced inside `scripts/hermes-bridge.ps1`. This excerpt keeps each native local effect visible to the structural safety inventory.

```powershell
# SAFETY GATE [war-room-open-url]
# Target: $validatedUrl.
# Effect: Creates one default-browser launch for the validated HTTPS or loopback URL.
# Scope: One browser launch and no local file creation.
# Reversibility: Close the browser tab or window.
$requiredConfirmation = "CREATE BROWSER LAUNCH FOR $validatedUrl"
$confirmation = Read-Host "Type exactly: $requiredConfirmation"
if ($confirmation -ceq $requiredConfirmation) {
    Start-Process -FilePath $validatedUrl
}
else {
    throw 'Exact URL-open confirmation did not match; no browser was launched.'
}

# SAFETY GATE [war-room-copy]
# Target: $destination, remote source digest $sourceHash, content digest $remoteContentHash, and byte count $remoteSize.
# Effect: Creates one new local HTML copy and refuses an existing destination.
# Scope: One validated source basename and content identity, one GUID destination, no recursion or overwrite.
# Reversibility: Removing the exact copy is a separate destructive action requiring new approval.
$requiredConfirmation = "CREATE WAR ROOM COPY $destination SOURCE SHA256 $sourceHash CONTENT SHA256 $remoteContentHash SIZE $remoteSize"
$confirmation = Read-Host "Type exactly: $requiredConfirmation"
if ($confirmation -ceq $requiredConfirmation) {
    scp @scpArguments
}
else {
    throw 'Exact copy confirmation did not match; no local file was created.'
}

# SAFETY GATE [war-room-open-file]
# Target: $destination with verified content digest $downloadHash.
# Effect: Creates one default-browser launch for the verified local HTML file.
# Scope: One browser launch; the downloaded file remains unchanged.
# Reversibility: Close the browser tab or window.
$requiredConfirmation = "CREATE BROWSER LAUNCH FOR $destination SHA256 $downloadHash"
$confirmation = Read-Host "Type exactly: $requiredConfirmation"
if ($confirmation -ceq $requiredConfirmation) {
    Start-Process -FilePath $destination
}
else {
    throw 'Exact file-open confirmation did not match; the copy remains unopened.'
}
```

</details>

## Failure behavior

- Invalid configured URL: stop; never fall through to opening it as a file or command.
- URL absent and SSH unavailable: report that no current dashboard was opened.
- No valid dashboard candidate: suggest `/dashboard-render`; do not broaden the filename pattern.
- Selection/copy mismatch: stop before browser launch.
- Copy succeeded but open confirmation failed: report the exact local path and hash; leave the file unopened.

## Local audit record

Automatic append to `.aegis-state/hermes-escalation-log.md` is **PREVIEW ONLY**. Return this proposed record without writing it:

`[YYYY-MM-DD HH:MM:SS] /war-room -> <OPENED url|file | COPIED-NOT-OPENED | UNREACHABLE>`

Any future append requires a separate exact local-write gate naming the resolved log path and entry hash.
