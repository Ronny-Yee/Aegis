#!/usr/bin/env node
/**
 * init-memory.js
 * Safely initializes Claude Code memory files for this Git repository.
 * Preview with: node scripts/init-memory.js
 * Execute only with the exact confirmation printed by the preview.
 * Existing files additionally require --force and receive a verified backup.
 * No npm install needed — uses only built-in Node.js modules.
 *
 * Config via environment variables:
 *   MEMORY_DIR  — override full path to memory directory
 *   PROJECT_KEY — optional stable slug; default is derived from the Git repository root
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ── Paths ──────────────────────────────────────────────────────────────────
function findRepositoryRoot(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch {
    throw new Error('Unable to resolve the Git repository root. Run inside a repository or pass --memory-dir.');
  }
}

function encodeProjectRoot(repoRoot) {
  return path.resolve(repoRoot).replace(/[^a-zA-Z0-9_-]/g, '-');
}

function validateProjectKey(projectKey) {
  if (typeof projectKey !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(projectKey)) {
    throw new Error('PROJECT_KEY must be a simple 1-128 character slug using only letters, numbers, hyphens, and underscores. Use MEMORY_DIR for an explicit path.');
  }
  return projectKey;
}

function resolveMemoryDir(options = {}, env = process.env, cwd = process.cwd()) {
  if (options.memoryDir) return path.resolve(options.memoryDir);
  if (env.MEMORY_DIR) return path.resolve(env.MEMORY_DIR);

  const projectKey = env.PROJECT_KEY
    ? validateProjectKey(env.PROJECT_KEY)
    : encodeProjectRoot(findRepositoryRoot(cwd));
  return path.join(os.homedir(), '.claude', 'projects', projectKey, 'memory');
}

// ── Memory file definitions ────────────────────────────────────────────────
const memories = [
  {
    file: 'user_role.md',
    indexLine: '- [User Role](user_role.md) — IT operator role, experience level, and daily toolset',
    content: `---
name: User Role & Environment
description: IT operator's role, experience level, and daily toolset
type: user
---

[ADMIN_NAME] is the IT operator at [@Aegion] ([@Aegion_DOMAIN]).

- **Experience:** IT generalist — explain PowerShell commands in plain English
- **Microsoft stack:** M365 Business Premium, Entra ID (hybrid AD via Entra Connect), Intune, Exchange Online, Azure
- **Network:** Cisco Meraki MX + MR across multiple office sites
- **VoIP:** [@Aegion_VOIP]
- **Ticketing:** Jira Service Management (cloud)
- **Response preference:** Portal/admin center steps FIRST, PowerShell second (wrapped in collapsible block)
- **Device convention:** DT-FirstName,LastName (desktops), LT-FirstName,LastName (laptops) — flag violations
`
  },
  {
    file: 'project_voip_migration.md',
    indexLine: '- [VoIP Migration](project_voip_migration.md) — VoIP platform rollout status across sites',
    content: `---
name: VoIP Migration
description: Status of VoIP migration across all office sites
type: project
---

Migrating all office sites to [@Aegion_VOIP].

**Why:** Legacy PBX end-of-life; cost savings by eliminating landlines site-by-site as new VoIP goes live.

| Site | Status |
|------|--------|
| Main office | ✅ Complete |
| [@Aegion_SITE_2] | 🔄 In progress |
| [@Aegion_SITE_3] | 🔄 In progress |
| [@Aegion_SITE_4] | Unknown |

**How to apply:** When troubleshooting phone issues, check whether the affected site has completed migration. If not, the user may still be on the legacy system. Coordinate alarm/landline cutover to happen simultaneously with VoIP go-live at each site.
`
  },
  {
    file: 'project_vpn_migration.md',
    indexLine: '- [VPN Migration](project_vpn_migration.md) — P2P fiber to Meraki site-to-site VPN',
    content: `---
name: VPN Migration — P2P to Meraki Site-to-Site
description: Replacing P2P fiber between main office and secondary site with Meraki MX-to-MX VPN
type: project
---

Replacing the existing [@Aegion_WAN] link with a Meraki site-to-site VPN (MX-to-MX).

**Why:** Simplify WAN topology, reduce P2P costs, bring remote sites onto the same Meraki SD-WAN fabric.

**Current blocker:** [@Aegion_REMOTE_ACCESS] is still running over the P2P link and needs to be migrated before the P2P can be cut.

**How to apply:** Do not recommend cutting the P2P link until the remote access dependency is resolved. VPN config path: Meraki → Security & SD-WAN → Site-to-site VPN.
`
  },
  {
    file: 'feedback_response_style.md',
    indexLine: '- [Response Style Feedback](feedback_response_style.md) — Portal first, no PII, plain English PS, direct tone',
    content: `---
name: Response Style Preferences
description: How the operator wants Aegis to format and deliver responses
type: feedback
---

Always show **portal/admin center steps FIRST**. PowerShell is secondary — wrap it in a \`<details>\` collapse block labeled "PowerShell (for reference only)" and explain every line in plain English.

**Why:** The operator primarily works through admin portals. Portal steps are immediately actionable; PS blocks are for reference.

**How to apply:** Every IT response should lead with numbered GUI steps using exact portal paths. Never lead with a PS block unless explicitly asked.

---

Never ask for or include real employee names, emails, UPNs, phone numbers, or any PII. Always use placeholders: [FIRST_NAME], [UPN], [USER@DOMAIN.COM], [DEVICE_NAME], etc.

**Why:** Hard security rule to prevent accidental PII exposure in AI conversations.

**How to apply:** Even if the user volunteers real names/emails, use placeholders in all output. No exceptions.

---

Keep responses short, scannable, and phone-screen readable. No walls of text. Use short bullets and clear headers. Never say "Great question!" or "Certainly!" — just answer.

**How to apply:** Bullet points over paragraphs. Warn with ⚠️ before any destructive action. End every workflow with a verification checklist.
`
  },
  {
    file: 'project_alarm_upgrade.md',
    indexLine: '- [Alarm Upgrade](project_alarm_upgrade.md) — Landline to internet-based alarm, timed with VoIP cutover',
    content: `---
name: Physical Security Alarm Upgrade
description: Upgrading alarm monitoring from landline to internet-based, coordinated with VoIP migration
type: project
---

Upgrading [@Aegion_ALARM] monitoring from landline to internet-based at each site.

**Why:** Once [@Aegion_VOIP] is live at a site, the [@Aegion_ISP] landline feeding the alarm can be cut — eliminating the landline cost. The alarm cutover is intentionally timed with the VoIP go-live to coordinate a single vendor/cabling visit.

**How to apply:** Do not schedule alarm cutover independently. It must be coordinated with: [@Aegion_NETPARTNER] (cabling), [@Aegion_ALARM] (alarm cutover), and [@Aegion_ISP] (landline disconnect) at the same time VoIP goes live at that site.
`
  }
];

// ── MEMORY.md index template ───────────────────────────────────────────────
function buildMemoryIndex(entries) {
  const lines = entries.map(e => e.indexLine).join('\n');
  return `# ITOps Session Memory

## User Preferences
- Always show **portal/admin center steps FIRST**, PowerShell second
- Tenant domain: [@Aegion_DOMAIN]
- Keep responses direct and step-by-step

## Memory Files
${lines}
`;
}

// ── Safe state handling ─────────────────────────────────────────────────────
function desiredFiles() {
  return [
    ...memories.map(mem => ({ file: mem.file, content: mem.content })),
    { file: 'MEMORY.md', content: buildMemoryIndex(memories) }
  ];
}

function fileDigest(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function bufferDigest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizeAbsolute(input) {
  return path.normalize(path.resolve(input));
}

function comparisonPath(input) {
  const normalized = normalizeAbsolute(input);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isPathInside(root, candidate) {
  const relative = path.relative(normalizeAbsolute(root), normalizeAbsolute(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function lstatIfPresent(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertNoLinksInExistingPath(target) {
  const normalized = normalizeAbsolute(target);
  const parsed = path.parse(normalized);
  const relative = path.relative(parsed.root, normalized);
  const components = relative === '' ? [] : relative.split(path.sep);
  let cursor = parsed.root;

  const rootStat = lstatIfPresent(cursor);
  if (rootStat && rootStat.isSymbolicLink()) {
    throw new Error(`Unsafe symbolic-link or junction/reparse path component: ${cursor}`);
  }

  for (const component of components) {
    cursor = path.join(cursor, component);
    const stat = lstatIfPresent(cursor);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new Error(`Unsafe symbolic-link or junction/reparse path component: ${cursor}`);
    }
  }
}

function assertSafeMemoryPaths(memoryDir, files = desiredFiles()) {
  const normalizedDir = normalizeAbsolute(memoryDir);
  if (/[\u0000-\u001f\u007f]/.test(normalizedDir)) {
    throw new Error('MEMORY_DIR must not contain control characters.');
  }
  assertNoLinksInExistingPath(normalizedDir);

  const dirStat = lstatIfPresent(normalizedDir);
  if (dirStat && !dirStat.isDirectory()) {
    throw new Error(`Memory path exists but is not a directory: ${normalizedDir}`);
  }

  const seen = new Set();
  for (const entry of files) {
    const target = normalizeAbsolute(path.join(normalizedDir, entry.file));
    if (!isPathInside(normalizedDir, target)) {
      throw new Error(`Memory target escapes the resolved memory directory: ${entry.file}`);
    }
    const key = comparisonPath(target);
    if (seen.has(key)) throw new Error(`Duplicate normalized memory target: ${target}`);
    seen.add(key);
    assertNoLinksInExistingPath(target);
    const stat = lstatIfPresent(target);
    if (stat && !stat.isFile()) {
      throw new Error(`Memory target must be a regular file: ${target}`);
    }
  }

  const backupRoot = normalizeAbsolute(path.join(normalizedDir, '.backups'));
  if (!isPathInside(normalizedDir, backupRoot)) {
    throw new Error('Backup root escapes the resolved memory directory.');
  }
  assertNoLinksInExistingPath(backupRoot);
  const backupStat = lstatIfPresent(backupRoot);
  if (backupStat && !backupStat.isDirectory()) {
    throw new Error(`Backup root exists but is not a directory: ${backupRoot}`);
  }
  return normalizedDir;
}

function mkdirSafeRecursive(target, createdDirectories = []) {
  const normalized = normalizeAbsolute(target);
  const parsed = path.parse(normalized);
  const relative = path.relative(parsed.root, normalized);
  const components = relative === '' ? [] : relative.split(path.sep);
  let cursor = parsed.root;

  for (const component of components) {
    cursor = path.join(cursor, component);
    let stat = lstatIfPresent(cursor);
    if (!stat) {
      fs.mkdirSync(cursor, { mode: 0o700 });
      createdDirectories.push(cursor);
      stat = fs.lstatSync(cursor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Unsafe directory component created or encountered: ${cursor}`);
    }
  }
}

function durableTempWrite(directory, targetName, content, suffix = 'tmp') {
  const tempName = `.${targetName}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.${suffix}`;
  const tempPath = path.join(directory, tempName);
  const fd = fs.openSync(tempPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return tempPath;
}

function createVerifiedBackup(memoryDir, files, expectedDigests, now = new Date()) {
  assertSafeMemoryPaths(memoryDir);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(memoryDir, '.backups');
  if (!lstatIfPresent(backupRoot)) fs.mkdirSync(backupRoot, { mode: 0o700 });
  assertNoLinksInExistingPath(backupRoot);
  const backupDir = path.join(backupRoot, `${stamp}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(backupDir, { mode: 0o700 });

  for (const file of files) {
    const source = path.join(memoryDir, file);
    const destination = path.join(backupDir, file);
    const expected = expectedDigests.get(file);
    if (!expected || fileDigest(source) !== expected) {
      throw new Error(`Backup checkpoint aborted because the source drifted: ${file}`);
    }
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
    const backupFd = fs.openSync(destination, 'r+');
    try {
      fs.fsyncSync(backupFd);
    } finally {
      fs.closeSync(backupFd);
    }
    if (fileDigest(destination) !== expected || fileDigest(source) !== expected) {
      throw new Error(`Backup verification failed for ${file}. No memory files were replaced.`);
    }
  }

  return backupDir;
}

function installNewFileExclusive(tempPath, targetPath) {
  fs.linkSync(tempPath, targetPath);
}

function writeFilesAtomically(memoryDir, files, options = {}) {
  assertSafeMemoryPaths(memoryDir, files);
  const directoryStat = lstatIfPresent(memoryDir);
  if (!directoryStat || !directoryStat.isDirectory()) {
    throw new Error('The resolved memory directory must exist before temporary files are prepared.');
  }
  const previous = new Map();
  const pending = [];
  const installed = [];
  const replaceFile = options.installFile || fs.renameSync;
  const installNewFile = options.installNewFile || installNewFileExclusive;
  const replaceFiles = options.replaceFiles || new Set();
  const expectedDigests = options.expectedDigests || new Map();

  try {
    for (const entry of files) {
      const target = path.join(memoryDir, entry.file);
      if (replaceFiles.has(entry.file)) {
        const stat = lstatIfPresent(target);
        if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
          throw new Error(`Authorized replacement target disappeared: ${entry.file}`);
        }
        const expectedDigest = expectedDigests.get(entry.file);
        if (!expectedDigest || fileDigest(target) !== expectedDigest) {
          throw new Error(`Authorized replacement target changed after backup: ${entry.file}`);
        }
        previous.set(entry.file, fs.readFileSync(target));
      } else {
        if (lstatIfPresent(target)) {
          throw new Error(`Planned create target already exists: ${entry.file}`);
        }
        previous.set(entry.file, null);
      }
      const temp = durableTempWrite(memoryDir, entry.file, entry.content);
      pending.push({ ...entry, target, temp });
    }

    for (const entry of pending) {
      if (options.beforeInstall) options.beforeInstall(entry);
      if (replaceFiles.has(entry.file)) {
        assertNoLinksInExistingPath(entry.target);
        const stat = lstatIfPresent(entry.target);
        if (!stat || !stat.isFile() || stat.isSymbolicLink() || fileDigest(entry.target) !== expectedDigests.get(entry.file)) {
          throw new Error(`Authorized replacement target drifted immediately before install: ${entry.file}`);
        }
        replaceFile(entry.temp, entry.target);
      } else {
        assertNoLinksInExistingPath(entry.target);
        if (lstatIfPresent(entry.target)) {
          throw new Error(`Planned create target appeared immediately before install: ${entry.file}`);
        }
        installNewFile(entry.temp, entry.target);
        installed.push(entry);
        fs.unlinkSync(entry.temp);
        continue;
      }
      installed.push(entry);
    }

    for (const entry of installed) {
      if (fileDigest(entry.target) !== bufferDigest(entry.content)) {
        throw new Error(`Post-write verification failed for ${entry.file}.`);
      }
    }
  } catch (error) {
    const rollbackErrors = [];
    const rolledBack = [];
    for (const entry of installed.reverse()) {
      try {
        const original = previous.get(entry.file);
        const currentStat = lstatIfPresent(entry.target);
        if (!currentStat || !currentStat.isFile() || currentStat.isSymbolicLink() || fileDigest(entry.target) !== bufferDigest(entry.content)) {
          throw new Error('installed target changed before rollback; refusing to clobber it');
        }
        if (original === null) {
          fs.unlinkSync(entry.target);
        } else {
          const restoreTemp = durableTempWrite(memoryDir, entry.file, original, 'restore');
          fs.renameSync(restoreTemp, entry.target);
        }
        rolledBack.push(entry.file);
      } catch (rollbackError) {
        rollbackErrors.push(`${entry.file}: ${rollbackError.message}`);
      }
    }
    for (const entry of pending) {
      const tempStat = lstatIfPresent(entry.temp);
      if (tempStat && tempStat.isFile() && !tempStat.isSymbolicLink()) {
        try { fs.unlinkSync(entry.temp); } catch (cleanupError) {
          rollbackErrors.push(`${path.basename(entry.temp)}: ${cleanupError.message}`);
        }
      }
    }
    const unresolved = rollbackErrors.length > 0 ? rollbackErrors.join(', ') : 'none';
    throw new Error(
      `Atomic memory update failed: ${error.message}. ` +
      `Partial-state report: installed=[${installed.map(entry => entry.file).join(', ')}]; ` +
      `rolled-back=[${rolledBack.join(', ')}]; unresolved=[${unresolved}]`
    );
  }
}

function inspectState(memoryDir, files = desiredFiles()) {
  const normalizedDir = assertSafeMemoryPaths(memoryDir, files);
  const observedDigests = new Map();
  const existing = files.map(entry => entry.file).filter(file => {
    const target = path.join(normalizedDir, file);
    const stat = lstatIfPresent(target);
    if (!stat) return false;
    observedDigests.set(file, fileDigest(target));
    return true;
  });
  const missing = files.map(entry => entry.file).filter(file => !existing.includes(file));
  return {
    existing,
    missing,
    partial: existing.length > 0 && missing.length > 0,
    observedDigests
  };
}

function parseArgs(argv) {
  const options = { execute: false, force: false, dryRun: false, confirm: null, memoryDir: null, help: false };
  const seen = new Set();
  const mark = flag => {
    if (seen.has(flag)) throw new Error(`${flag} may be supplied only once.`);
    seen.add(flag);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') {
      mark('--execute');
      options.execute = true;
    } else if (arg === '--force') {
      mark('--force');
      options.force = true;
    } else if (arg === '--dry-run') {
      mark('--dry-run');
      options.dryRun = true;
    } else if (arg === '--confirm') {
      mark('--confirm');
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
        throw new Error('--confirm requires the exact phrase printed by the preview.');
      }
      options.confirm = argv[++i];
    } else if (arg.startsWith('--confirm=')) {
      mark('--confirm');
      const value = arg.slice('--confirm='.length);
      if (!value) throw new Error('--confirm requires the exact phrase printed by the preview.');
      options.confirm = value;
    } else if (arg === '--memory-dir') {
      mark('--memory-dir');
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
        throw new Error('--memory-dir requires a path.');
      }
      options.memoryDir = argv[++i];
    } else if (arg.startsWith('--memory-dir=')) {
      mark('--memory-dir');
      const value = arg.slice('--memory-dir='.length);
      if (!value) throw new Error('--memory-dir requires a path.');
      options.memoryDir = value;
    } else if (arg === '--help' || arg === '-h') {
      mark('--help');
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.help && argv.length !== 1) throw new Error('--help cannot be combined with other arguments.');
  if (options.dryRun && (options.execute || options.confirm !== null)) {
    throw new Error('--dry-run cannot be combined with --execute or --confirm.');
  }
  if (options.confirm !== null && !options.execute) {
    throw new Error('--confirm is valid only with --execute.');
  }
  return options;
}

function buildMemoryPlan(memoryDir, files, state, force) {
  const normalizedDir = normalizeAbsolute(memoryDir);
  let effect = 'initial-create';
  if (state.existing.length > 0) effect = force ? 'force-replace' : 'blocked-existing';
  else if (force) effect = 'invalid-force-without-existing-targets';

  const targets = files.map(entry => {
    const target = normalizeAbsolute(path.join(normalizedDir, entry.file));
    const exists = state.existing.includes(entry.file);
    return {
      action: exists ? 'replace' : 'create',
      currentSha256: exists ? state.observedDigests.get(entry.file) : null,
      desiredSha256: bufferDigest(entry.content),
      file: entry.file,
      target
    };
  }).sort((left, right) => {
    const leftPath = comparisonPath(left.target);
    const rightPath = comparisonPath(right.target);
    return leftPath < rightPath ? -1 : (leftPath > rightPath ? 1 : 0);
  });

  const payload = {
    version: 1,
    operation: 'init-memory',
    effect,
    memoryDirectory: normalizedDir,
    checkpointRoot: effect === 'force-replace' ? normalizeAbsolute(path.join(normalizedDir, '.backups')) : null,
    targets
  };
  const sha256 = bufferDigest(JSON.stringify(payload));
  const confirmation = (effect === 'initial-create' || effect === 'force-replace')
    ? `EXECUTE MEMORY ${effect.toUpperCase()} IN ${normalizedDir} FOR ${targets.length} FILES PLAN SHA256 ${sha256}`
    : null;
  return { confirmation, payload, sha256 };
}

function printPlan(plan, state, logger = console) {
  logger.log(`Memory directory: ${plan.payload.memoryDirectory}`);
  logger.log(`Mode: preview only (${plan.payload.effect})`);
  logger.log(`Plan SHA256: ${plan.sha256}`);
  if (state.partial) {
    logger.log(`Partial initialization detected: ${state.existing.length}/${plan.payload.targets.length} target files exist.`);
  }
  logger.log('Target files:');
  for (const target of plan.payload.targets) {
    logger.log(`  ${target.action.padEnd(7)} ${target.target}  desired-sha256=${target.desiredSha256}`);
  }
  if (plan.confirmation) logger.log(`Required confirmation: ${plan.confirmation}`);
}

function assertPlanState(plan, files) {
  const memoryDir = assertSafeMemoryPaths(plan.payload.memoryDirectory, files);
  for (const target of plan.payload.targets) {
    const stat = lstatIfPresent(target.target);
    if (target.action === 'create') {
      if (stat) throw new Error(`Plan drift: create target now exists: ${target.file}`);
    } else {
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Plan drift: replacement target is no longer a regular file: ${target.file}`);
      }
      if (fileDigest(target.target) !== target.currentSha256) {
        throw new Error(`Plan drift: replacement content changed: ${target.file}`);
      }
    }
  }
  return memoryDir;
}

function verifyDesiredReadback(plan) {
  for (const target of plan.payload.targets) {
    const stat = lstatIfPresent(target.target);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || fileDigest(target.target) !== target.desiredSha256) {
      throw new Error(`Verified readback failed for ${target.file}.`);
    }
  }
}

function executeMemoryPlan(plan, files, dependencies = {}) {
  const createdDirectories = [];
  let backupDir = null;
  try {
    if (dependencies.beforeFirstWrite) dependencies.beforeFirstWrite(plan);
    assertPlanState(plan, files);
    mkdirSafeRecursive(plan.payload.memoryDirectory, createdDirectories);
    assertPlanState(plan, files);

    const replaceTargets = plan.payload.targets.filter(target => target.action === 'replace');
    const replaceFiles = new Set(replaceTargets.map(target => target.file));
    const expectedDigests = new Map(replaceTargets.map(target => [target.file, target.currentSha256]));

    if (replaceTargets.length > 0) {
      if (dependencies.beforeBackup) dependencies.beforeBackup(plan);
      assertPlanState(plan, files);
      backupDir = createVerifiedBackup(
        plan.payload.memoryDirectory,
        replaceTargets.map(target => target.file),
        expectedDigests,
        dependencies.now || new Date()
      );
      if (dependencies.afterBackup) dependencies.afterBackup(plan, backupDir);
      assertPlanState(plan, files);
    }

    writeFilesAtomically(plan.payload.memoryDirectory, files, {
      beforeInstall: dependencies.beforeInstall,
      installFile: dependencies.installFile,
      installNewFile: dependencies.installNewFile,
      replaceFiles,
      expectedDigests
    });
    verifyDesiredReadback(plan);
    return { backupDir };
  } catch (error) {
    const directoryRollbackErrors = [];
    for (const directory of createdDirectories.reverse()) {
      try {
        if (lstatIfPresent(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
      } catch (rollbackError) {
        directoryRollbackErrors.push(`${directory}: ${rollbackError.message}`);
      }
    }
    const detail = directoryRollbackErrors.length > 0
      ? ` Directory rollback unresolved=[${directoryRollbackErrors.join(', ')}]`
      : '';
    throw new Error(`${error.message}${detail}`);
  }
}

function run(argv = process.argv.slice(2), env = process.env, cwd = process.cwd(), dependencies = {}) {
  const logger = dependencies.logger || console;
  const options = parseArgs(argv);
  if (options.help) {
    logger.log('Usage: node scripts/init-memory.js [--memory-dir PATH] [--force] [--execute --confirm "EXACT PHRASE"]');
    logger.log('Default behavior is preview-only. Existing files additionally require --force.');
    return 0;
  }

  const memoryDir = resolveMemoryDir(options, env, cwd);
  const files = desiredFiles();
  const state = inspectState(memoryDir, files);
  const plan = buildMemoryPlan(memoryDir, files, state, options.force);
  printPlan(plan, state, logger);

  if (!options.execute) {
    if (plan.payload.effect === 'blocked-existing') {
      logger.log('Existing targets make this plan read-only. Preview again with --force to prepare a checkpointed replacement.');
    } else if (plan.payload.effect === 'invalid-force-without-existing-targets') {
      logger.log('--force is not valid when no memory target exists; use the initial-create plan.');
    }
    logger.log('No files changed.');
    return 0;
  }

  if (!plan.confirmation) {
    logger.error('Refusing execution because the resolved plan is not executable. No files changed.');
    return 2;
  }
  if (options.confirm !== plan.confirmation) {
    logger.error('Exact confirmation mismatch. Confirmation is case- and whitespace-sensitive. No files changed.');
    return 2;
  }

  const result = executeMemoryPlan(plan, files, dependencies);
  if (result.backupDir) logger.log(`Verified backup: ${result.backupDir}`);
  logger.log(`Verified: ${files.length} memory files installed with matching SHA256 readback.`);
  if (result.backupDir) logger.log('Previous state remains available in the verified backup directory.');
  return 0;
}

function main() {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`init-memory.js: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  buildMemoryPlan,
  desiredFiles,
  encodeProjectRoot,
  findRepositoryRoot,
  inspectState,
  parseArgs,
  resolveMemoryDir,
  run,
  validateProjectKey
};
