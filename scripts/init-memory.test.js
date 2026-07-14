#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

const SCRIPT = path.join(__dirname, 'init-memory.js');
const {
  buildMemoryPlan,
  desiredFiles,
  encodeProjectRoot,
  inspectState,
  parseArgs,
  resolveMemoryDir,
  run,
  validateProjectKey
} = require('./init-memory');

const silentLogger = { log() {}, error() {} };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-init-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runCli(memoryDir, ...args) {
  return spawnSync(process.execPath, [SCRIPT, '--memory-dir', memoryDir, ...args], {
    encoding: 'utf8',
    env: { ...process.env }
  });
}

function extractConfirmation(output) {
  const match = output.match(/^Required confirmation: (.+)$/m);
  assert.ok(match, `Expected an exact confirmation in output:\n${output}`);
  assert.match(match[1], /^EXECUTE MEMORY (?:INITIAL-CREATE|FORCE-REPLACE) IN .+ FOR 6 FILES PLAN SHA256 [a-f0-9]{64}$/);
  return match[1];
}

function preview(memoryDir, ...args) {
  const result = runCli(memoryDir, ...args);
  assert.strictEqual(result.status, 0, result.stderr);
  return { confirmation: extractConfirmation(result.stdout), result };
}

function initialize(memoryDir) {
  const { confirmation } = preview(memoryDir);
  const result = runCli(memoryDir, '--execute', '--confirm', confirmation);
  assert.strictEqual(result.status, 0, result.stderr);
  return confirmation;
}

function inProcessPlan(memoryDir, force = false) {
  const files = desiredFiles();
  return buildMemoryPlan(memoryDir, files, inspectState(memoryDir, files), force);
}

test('default mode previews every target and performs no filesystem write', t => {
  const memoryDir = path.join(fixture(t), 'memory');
  const result = runCli(memoryDir);

  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /preview only \(initial-create\)/);
  assert.match(result.stdout, /Plan SHA256: [a-f0-9]{64}/);
  assert.match(result.stdout, /MEMORY\.md/);
  extractConfirmation(result.stdout);
  assert.strictEqual(fs.existsSync(memoryDir), false);
});

test('missing, generic, wrong-case, and whitespace-modified confirmations cause zero writes', t => {
  const memoryDir = path.join(fixture(t), 'memory');
  const { confirmation } = preview(memoryDir);
  const attempts = [
    ['--execute'],
    ['--execute', '--confirm', 'yes'],
    ['--execute', '--confirm', confirmation.toLowerCase()],
    ['--execute', '--confirm', `${confirmation} `],
    ['--execute', '--confirm', ` ${confirmation}`]
  ];

  for (const args of attempts) {
    const result = runCli(memoryDir, ...args);
    assert.strictEqual(result.status, 2, `${args.join(' ')}\n${result.stderr}`);
    assert.strictEqual(fs.existsSync(memoryDir), false, `Rejected attempt wrote for: ${args.join(' ')}`);
  }
});

test('the exact initial-create phrase installs the target set once', t => {
  const memoryDir = path.join(fixture(t), 'memory');
  const confirmation = initialize(memoryDir);
  const targets = fs.readdirSync(memoryDir).filter(name => name.endsWith('.md')).sort();
  assert.strictEqual(targets.length, 6);
  const before = new Map(targets.map(name => [name, fs.readFileSync(path.join(memoryDir, name))]));

  const repeated = runCli(memoryDir, '--execute', '--confirm', confirmation);
  assert.strictEqual(repeated.status, 2);
  assert.deepStrictEqual(
    new Map(targets.map(name => [name, fs.readFileSync(path.join(memoryDir, name))])),
    before
  );
  assert.deepStrictEqual(fs.readdirSync(memoryDir).filter(name => name.endsWith('.md')).sort(), targets);
});

test('existing and partial memory remain read-only until a force plan is exactly authorized', t => {
  const root = fixture(t);
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(memoryDir);
  const partialFile = path.join(memoryDir, 'user_role.md');
  fs.writeFileSync(partialFile, 'operator-owned marker\n', 'utf8');

  const previewResult = runCli(memoryDir);
  assert.strictEqual(previewResult.status, 0, previewResult.stderr);
  assert.match(previewResult.stdout, /Partial initialization detected: 1\/6/);
  assert.doesNotMatch(previewResult.stdout, /Required confirmation:/);

  const executeResult = runCli(memoryDir, '--execute', '--confirm', 'yes');
  assert.strictEqual(executeResult.status, 2);
  assert.strictEqual(fs.readFileSync(partialFile, 'utf8'), 'operator-owned marker\n');
  assert.deepStrictEqual(fs.readdirSync(memoryDir), ['user_role.md']);
});

test('force replacement requires its own exact plan and creates a verified checkpoint', t => {
  const memoryDir = path.join(fixture(t), 'memory');
  initialize(memoryDir);
  const ownedFile = path.join(memoryDir, 'user_role.md');
  fs.writeFileSync(ownedFile, 'operator-owned marker\n', 'utf8');

  const { confirmation } = preview(memoryDir, '--force');
  const rejected = runCli(memoryDir, '--force', '--execute', '--confirm', `${confirmation} `);
  assert.strictEqual(rejected.status, 2);
  assert.strictEqual(fs.readFileSync(ownedFile, 'utf8'), 'operator-owned marker\n');
  assert.strictEqual(fs.existsSync(path.join(memoryDir, '.backups')), false);

  const result = runCli(memoryDir, '--force', '--execute', '--confirm', confirmation);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified backup:/);
  assert.doesNotMatch(fs.readFileSync(ownedFile, 'utf8'), /operator-owned marker/);

  const backupRoot = path.join(memoryDir, '.backups');
  const backups = fs.readdirSync(backupRoot);
  assert.strictEqual(backups.length, 1);
  assert.strictEqual(
    fs.readFileSync(path.join(backupRoot, backups[0], 'user_role.md'), 'utf8'),
    'operator-owned marker\n'
  );
});

test('an injected install failure rolls back installed targets and reports partial state', t => {
  const memoryDir = path.join(fixture(t), 'memory');
  initialize(memoryDir);
  const first = path.join(memoryDir, 'user_role.md');
  const second = path.join(memoryDir, 'project_voip_migration.md');
  fs.writeFileSync(first, 'original one\n', 'utf8');
  fs.writeFileSync(second, 'original two\n', 'utf8');
  const plan = inProcessPlan(memoryDir, true);

  let installs = 0;
  assert.throws(() => run([
    '--memory-dir', memoryDir,
    '--force',
    '--execute',
    '--confirm', plan.confirmation
  ], process.env, process.cwd(), {
    logger: silentLogger,
    installFile(from, to) {
      installs += 1;
      if (installs === 2) throw new Error('simulated interruption');
      fs.renameSync(from, to);
    }
  }), /simulated interruption[\s\S]*Partial-state report/);

  assert.strictEqual(fs.readFileSync(first, 'utf8'), 'original one\n');
  assert.strictEqual(fs.readFileSync(second, 'utf8'), 'original two\n');
  assert.strictEqual(fs.readdirSync(memoryDir).some(name => name.endsWith('.tmp')), false);
});

test('a concurrent create is preserved and causes rollback instead of clobber', t => {
  const memoryDir = path.join(fixture(t), 'memory');
  const plan = inProcessPlan(memoryDir);
  const concurrentTarget = path.join(memoryDir, 'project_alarm_upgrade.md');

  assert.throws(() => run([
    '--memory-dir', memoryDir,
    '--execute',
    '--confirm', plan.confirmation
  ], process.env, process.cwd(), {
    logger: silentLogger,
    beforeInstall(entry) {
      if (entry.file === 'project_alarm_upgrade.md') {
        fs.writeFileSync(concurrentTarget, 'concurrent owner content\n', 'utf8');
      }
    }
  }), /appeared immediately before install[\s\S]*Partial-state report/);

  assert.strictEqual(fs.readFileSync(concurrentTarget, 'utf8'), 'concurrent owner content\n');
  for (const entry of desiredFiles()) {
    if (entry.file !== 'project_alarm_upgrade.md') {
      assert.strictEqual(fs.existsSync(path.join(memoryDir, entry.file)), false);
    }
  }
});

test('force execution detects drift after backup and never installs over the changed target', t => {
  const memoryDir = path.join(fixture(t), 'memory');
  initialize(memoryDir);
  const target = path.join(memoryDir, 'user_role.md');
  fs.writeFileSync(target, 'pre-plan value\n', 'utf8');
  const plan = inProcessPlan(memoryDir, true);

  assert.throws(() => run([
    '--memory-dir', memoryDir,
    '--force',
    '--execute',
    '--confirm', plan.confirmation
  ], process.env, process.cwd(), {
    logger: silentLogger,
    afterBackup() {
      fs.writeFileSync(target, 'concurrent drift\n', 'utf8');
    }
  }), /Plan drift: replacement content changed/);

  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'concurrent drift\n');
  assert.strictEqual(fs.readdirSync(memoryDir).some(name => name.endsWith('.tmp')), false);
});

test('symbolic-link or junction memory paths are rejected without touching the referent', t => {
  const root = fixture(t);
  const referent = path.join(root, 'referent');
  const memoryDir = path.join(root, 'memory-link');
  fs.mkdirSync(referent);
  fs.writeFileSync(path.join(referent, 'marker.txt'), 'unchanged\n', 'utf8');
  try {
    fs.symlinkSync(referent, memoryDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip(`Link creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const result = runCli(memoryDir);
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /symbolic-link or junction\/reparse/);
  assert.deepStrictEqual(fs.readdirSync(referent), ['marker.txt']);
  assert.strictEqual(fs.readFileSync(path.join(referent, 'marker.txt'), 'utf8'), 'unchanged\n');
});

test('repository-derived keys include the full stable path', () => {
  assert.notStrictEqual(
    encodeProjectRoot(path.join('C:', 'one', 'repo')),
    encodeProjectRoot(path.join('D:', 'two', 'repo'))
  );
});

test('PROJECT_KEY accepts only a bounded slug and cannot escape the project root', () => {
  assert.strictEqual(validateProjectKey('aegis_public-1'), 'aegis_public-1');
  for (const unsafe of ['../escape', '..', '.', '/absolute', '\\absolute', 'C:\\escape', 'nested/path', 'nested\\path', '-leading']) {
    assert.throws(() => resolveMemoryDir({}, { PROJECT_KEY: unsafe }), /PROJECT_KEY must be a simple/);
  }
  assert.throws(() => validateProjectKey('x'.repeat(129)), /PROJECT_KEY must be a simple/);
});

test('strict argument parsing rejects value-smuggling, duplicates, and detached confirmations', () => {
  for (const args of [
    ['--force=false'],
    ['--execute=false'],
    ['--execute', 'false'],
    ['--force', '--force'],
    ['--memory-dir', 'one', '--memory-dir', 'two'],
    ['--confirm', 'value'],
    ['--dry-run', '--execute'],
    ['--memory-dir', '--force']
  ]) {
    assert.throws(() => parseArgs(args));
  }
});
