#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

const SCRIPT = path.join(__dirname, 'security-audit.js');
const {
  buildWritePlan,
  parseArgs,
  renderReport,
  run
} = require('./security-audit');

const silentLogger = { log() {}, error() {} };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-security-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runCli(cwd, args = [], envOverrides = {}) {
  return spawnSync(process.execPath, [SCRIPT, '--standalone-private', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      TENANT: '[@Aegion_DOMAIN]',
      AUDITOR: '[AUDITOR_NAME]',
      ...envOverrides
    }
  });
}

function extractConfirmation(output) {
  const match = output.match(/^Required confirmation: (.+)$/m);
  assert.ok(match, `Expected confirmation in output:\n${output}`);
  assert.match(match[1], /^WRITE SECURITY AUDIT TARGET .+ CONTENT SHA256 [a-f0-9]{64}$/);
  return match[1];
}

function extractTarget(output) {
  const match = output.match(/^Report target: (.+)$/m);
  assert.ok(match, `Expected normalized target in output:\n${output}`);
  return match[1];
}

function preview(cwd, args = [], envOverrides = {}) {
  const result = runCli(cwd, args, envOverrides);
  assert.strictEqual(result.status, 0, result.stderr);
  return {
    confirmation: extractConfirmation(result.stdout),
    target: extractTarget(result.stdout),
    result
  };
}

function exactWrite(root, targetName, dependencies = {}) {
  const target = path.join(root, targetName);
  const report = renderReport();
  const plan = buildWritePlan(root, target, report, { standalonePrivate: true });
  return {
    target,
    report,
    plan,
    invoke() {
      return run([
        '--output', path.basename(target),
        '--standalone-private',
        '--write',
        '--confirm', plan.confirmation
      ], root, {
        logger: silentLogger,
        ...dependencies
      });
    }
  };
}

test('default execution computes a target-bound preview and writes nothing', t => {
  const root = fixture(t);
  const { confirmation, target, result } = preview(root);

  assert.match(result.stdout, /Mode: preview only/);
  assert.match(result.stdout, /Content SHA256: [a-f0-9]{64}/);
  assert.strictEqual(path.dirname(target), root);
  assert.ok(confirmation.includes(target));
  assert.deepStrictEqual(fs.readdirSync(root), []);
});

test('a non-Git directory requires explicit standalone-private mode', t => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      TENANT: '[@Aegion_DOMAIN]',
      AUDITOR: '[AUDITOR_NAME]'
    }
  });

  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /requires explicit --standalone-private/);
  assert.deepStrictEqual(fs.readdirSync(root), []);
});

test('standalone-private cannot bypass a broken Git worktree probe', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, '.git'));

  const result = runCli(root);
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /Git metadata is present but worktree status could not be proved/);
  assert.deepStrictEqual(fs.readdirSync(root), ['.git']);
});

test('missing, generic, wrong-case, and whitespace-modified confirmations cause zero writes', t => {
  const root = fixture(t);
  const { confirmation } = preview(root);
  const attempts = [
    ['--write'],
    ['--write', '--confirm', 'yes'],
    ['--write', '--confirm', confirmation.toLowerCase()],
    ['--write', '--confirm', `${confirmation} `],
    ['--write', '--confirm', ` ${confirmation}`]
  ];

  for (const args of attempts) {
    const result = runCli(root, args);
    assert.strictEqual(result.status, 2, `${args.join(' ')}\n${result.stderr}`);
    assert.deepStrictEqual(fs.readdirSync(root), [], `Rejected write left state for: ${args.join(' ')}`);
  }
});

test('the exact target/content phrase creates one verified report and never overwrites it', t => {
  const root = fixture(t);
  const { confirmation, target } = preview(root);
  const written = runCli(root, ['--write', '--confirm', confirmation]);

  assert.strictEqual(written.status, 0, written.stderr);
  assert.match(written.stdout, /Verified report written once:/);
  assert.deepStrictEqual(fs.readdirSync(root), [path.basename(target)]);
  const before = fs.readFileSync(target);

  const repeated = runCli(root, ['--write', '--confirm', confirmation]);
  assert.strictEqual(repeated.status, 2);
  assert.match(repeated.stdout, /never overwrites an existing report/);
  assert.deepStrictEqual(fs.readFileSync(target), before);
  assert.deepStrictEqual(fs.readdirSync(root), [path.basename(target)]);
});

test('content drift invalidates an otherwise exact target confirmation before any write', t => {
  const root = fixture(t);
  const { confirmation } = preview(root, [], { AUDITOR: '[AUDITOR_NAME]' });
  const result = runCli(
    root,
    ['--write', '--confirm', confirmation],
    { AUDITOR: '[ADMIN_NAME]' }
  );

  assert.strictEqual(result.status, 2, result.stderr);
  assert.match(result.stderr, /Exact confirmation mismatch/);
  assert.deepStrictEqual(fs.readdirSync(root), []);
});

test('an existing owner file blocks writing even when an earlier exact phrase is replayed', t => {
  const root = fixture(t);
  const { confirmation, target } = preview(root);
  fs.writeFileSync(target, 'operator-owned report\n', 'utf8');

  const result = runCli(root, ['--write', '--confirm', confirmation]);
  assert.strictEqual(result.status, 2, result.stderr);
  assert.match(result.stdout, /never overwrites an existing report/);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'operator-owned report\n');
  assert.deepStrictEqual(fs.readdirSync(root), [path.basename(target)]);
});

test('output paths outside the resolved working directory are rejected without writes', t => {
  const root = fixture(t);
  const escapedName = `escape-${path.basename(root)}.md`;
  const escaped = path.join(path.dirname(root), escapedName);
  const result = runCli(root, ['--output', path.join('..', escapedName)]);

  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /must remain inside the resolved working directory/);
  assert.strictEqual(fs.existsSync(escaped), false);
  assert.deepStrictEqual(fs.readdirSync(root), []);
});

test('non-Markdown and Git-metadata targets are rejected without report writes', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, '.git'));

  const wrongType = runCli(root, ['--output', 'audit.txt']);
  assert.strictEqual(wrongType.status, 1);
  assert.match(wrongType.stderr, /must be a Markdown/);

  const metadata = runCli(root, ['--output', path.join('.git', 'security-audit-metadata.md')]);
  assert.strictEqual(metadata.status, 1);
  assert.match(metadata.stderr, /must not be inside Git metadata/);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, '.git')), []);
});

test('symbolic-link or junction output parents are rejected without touching the referent', t => {
  const root = fixture(t);
  const referent = path.join(root, 'referent');
  const linked = path.join(root, 'linked');
  fs.mkdirSync(referent);
  fs.writeFileSync(path.join(referent, 'marker.txt'), 'unchanged\n', 'utf8');
  try {
    fs.symlinkSync(referent, linked, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip(`Link creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const result = runCli(root, ['--output', path.join('linked', 'security-audit-report.md')]);
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /symbolic-link or junction\/reparse/);
  assert.deepStrictEqual(fs.readdirSync(referent), ['marker.txt']);
  assert.strictEqual(fs.readFileSync(path.join(referent, 'marker.txt'), 'utf8'), 'unchanged\n');
});

test('a target created after temp preparation wins the race and is never clobbered', t => {
  const root = fixture(t);
  const target = path.join(root, 'security-audit-race-report.md');
  const report = renderReport();
  const plan = buildWritePlan(root, target, report, { standalonePrivate: true });

  assert.throws(() => run([
    '--output', path.basename(target),
    '--standalone-private',
    '--write',
    '--confirm', plan.confirmation
  ], root, {
    logger: silentLogger,
    beforeInstall() {
      fs.writeFileSync(target, 'concurrent owner report\n', 'utf8');
    }
  }), /appeared before install[\s\S]*Partial-state report/);

  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'concurrent owner report\n');
  assert.deepStrictEqual(fs.readdirSync(root), ['security-audit-race-report.md']);
});

test('write, fsync, and close failures clean ignored invocation-owned temps with exact partial state', t => {
  const root = fixture(t);
  for (const failurePoint of ['write', 'fsync', 'close']) {
    const target = path.join(root, `security-audit-${failurePoint}-report.md`);
    const report = renderReport();
    const plan = buildWritePlan(root, target, report, { standalonePrivate: true });
    const fileSystem = Object.create(fs);
    if (failurePoint === 'write') {
      fileSystem.writeFileSync = () => { throw new Error('injected write failure'); };
    } else if (failurePoint === 'fsync') {
      fileSystem.fsyncSync = () => { throw new Error('injected fsync failure'); };
    } else {
      let closeCalls = 0;
      fileSystem.closeSync = descriptor => {
        closeCalls += 1;
        if (closeCalls === 1) throw new Error('injected close failure');
        return fs.closeSync(descriptor);
      };
    }

    assert.throws(() => run([
      '--output', path.basename(target),
      '--standalone-private',
      '--write',
      '--confirm', plan.confirmation
    ], root, {
      logger: silentLogger,
      fileSystem
    }), new RegExp(`injected ${failurePoint} failure[\\s\\S]*target=not installed by this invocation; temp=removed; unresolved=\\[none\\]`));

    assert.deepStrictEqual(fs.readdirSync(root), []);
  }

  const ignoredTemp = '.security-audit-write-report.md.1234.abcdef.tmp';
  const ignored = spawnSync('git', ['check-ignore', '--quiet', '--', ignoredTemp], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8'
  });
  assert.strictEqual(ignored.status, 0, ignored.stderr);
});

test('install failure removes only the identity-bound invocation temp', t => {
  const root = fixture(t);
  const fileSystem = Object.create(fs);
  fileSystem.linkSync = () => { throw new Error('injected install failure'); };
  const attempt = exactWrite(root, 'security-audit-install-report.md', { fileSystem });

  assert.throws(
    attempt.invoke,
    /injected install failure[\s\S]*target=not installed by this invocation; temp=removed; unresolved=\[none\]/
  );
  assert.deepStrictEqual(fs.readdirSync(root), []);
});

test('post-install read-back failure rolls back the identity-bound target', t => {
  const root = fixture(t);
  const targetName = 'security-audit-readback-report.md';
  const target = path.join(root, targetName);
  const fileSystem = Object.create(fs);
  let targetReads = 0;
  fileSystem.readFileSync = value => {
    if (path.resolve(value) === path.resolve(target) && targetReads++ === 0) {
      throw new Error('injected readback failure');
    }
    return fs.readFileSync(value);
  };
  const attempt = exactWrite(root, targetName, { fileSystem });

  assert.throws(
    attempt.invoke,
    /injected readback failure[\s\S]*target=rolled back; temp=removed; unresolved=\[none\]/
  );
  assert.deepStrictEqual(fs.readdirSync(root), []);
});

test('rollback unlink failure preserves the installed report and reports unresolved state', t => {
  const root = fixture(t);
  const targetName = 'security-audit-rollback-report.md';
  const target = path.join(root, targetName);
  const fileSystem = Object.create(fs);
  let targetReads = 0;
  fileSystem.readFileSync = value => {
    if (path.resolve(value) === path.resolve(target) && targetReads++ === 0) {
      throw new Error('injected readback failure');
    }
    return fs.readFileSync(value);
  };
  fileSystem.unlinkSync = value => {
    if (path.resolve(value) === path.resolve(target)) {
      throw new Error('injected rollback unlink failure');
    }
    return fs.unlinkSync(value);
  };
  const attempt = exactWrite(root, targetName, { fileSystem });

  assert.throws(
    attempt.invoke,
    /injected readback failure[\s\S]*target=installed or changed; unresolved; temp=removed; unresolved=\[target: injected rollback unlink failure\]/
  );
  assert.deepStrictEqual(fs.readdirSync(root), [targetName]);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), attempt.report);
});

test('temp cleanup failure preserves the invocation temp and reports its exact unresolved state', t => {
  const root = fixture(t);
  const fileSystem = Object.create(fs);
  fileSystem.writeFileSync = () => { throw new Error('injected write failure'); };
  fileSystem.unlinkSync = value => {
    if (path.basename(value).endsWith('.tmp')) {
      throw new Error('injected temp cleanup failure');
    }
    return fs.unlinkSync(value);
  };
  const attempt = exactWrite(root, 'security-audit-cleanup-report.md', { fileSystem });

  assert.throws(
    attempt.invoke,
    /injected write failure[\s\S]*target=not installed by this invocation; temp=present or changed; unresolved; unresolved=\[temp: injected temp cleanup failure\]/
  );
  const remaining = fs.readdirSync(root);
  assert.strictEqual(remaining.length, 1);
  assert.match(remaining[0], /^\.security-audit-cleanup-report\.md\.\d+\.[a-f0-9]{12}\.tmp$/);
});

test('a filesystem without a stable nonzero inode fails closed and preserves the unresolved temp', t => {
  const root = fixture(t);
  const fileSystem = Object.create(fs);
  fileSystem.fstatSync = () => ({
    dev: 0n,
    ino: 0n,
    birthtimeNs: 0n,
    isFile: () => true,
    isSymbolicLink: () => false
  });
  const attempt = exactWrite(root, 'security-audit-degenerate-identity-report.md', { fileSystem });

  assert.throws(
    attempt.invoke,
    /does not expose a stable nonzero filesystem identity[\s\S]*temp=present or changed; unresolved/
  );
  const remaining = fs.readdirSync(root);
  assert.strictEqual(remaining.length, 1);
  assert.match(remaining[0], /^\.security-audit-degenerate-identity-report\.md\.\d+\.[a-f0-9]{12}\.tmp$/);
});

test('a concurrently replaced temp is preserved when its filesystem identity changes', t => {
  const root = fixture(t);
  let replacementPath;
  let originalPath;
  const attempt = exactWrite(root, 'security-audit-temp-identity-report.md', {
    beforeInstall(_plan, { tempPath }) {
      replacementPath = tempPath;
      originalPath = `${tempPath}.original`;
      fs.renameSync(tempPath, originalPath);
      fs.writeFileSync(tempPath, 'concurrent replacement\n', 'utf8');
    }
  });

  assert.throws(
    attempt.invoke,
    /Invocation-owned temp filesystem identity changed[\s\S]*temp=present or changed; unresolved/
  );
  assert.strictEqual(fs.readFileSync(replacementPath, 'utf8'), 'concurrent replacement\n');
  assert.strictEqual(fs.readFileSync(originalPath, 'utf8'), attempt.report);
  assert.strictEqual(fs.existsSync(attempt.target), false);
});

test('a concurrently replaced target is preserved even when its content matches the report', t => {
  const root = fixture(t);
  const targetName = 'security-audit-target-identity-report.md';
  let originalPath;
  const attempt = exactWrite(root, targetName, {
    afterInstall(plan) {
      originalPath = `${plan.target}.original`;
      fs.renameSync(plan.target, originalPath);
      fs.writeFileSync(plan.target, attempt.report, 'utf8');
    }
  });

  assert.throws(
    attempt.invoke,
    /Installed report filesystem identity changed[\s\S]*target=installed or changed; unresolved/
  );
  assert.strictEqual(fs.readFileSync(attempt.target, 'utf8'), attempt.report);
  assert.strictEqual(fs.readFileSync(originalPath, 'utf8'), attempt.report);
});

test('a Git worktree rejects trackable report targets and accepts only ignored safe names while requiring the generated temp to be ignored', t => {
  const root = fixture(t);
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
  if (initialized.error && initialized.error.code === 'ENOENT') {
    t.skip('Git is unavailable; the strict filename boundary remains covered.');
    return;
  }
  assert.strictEqual(initialized.status, 0, initialized.stderr);

  const trackable = runCli(root, ['--output', 'security-audit-private.md']);
  assert.strictEqual(trackable.status, 1);
  assert.match(trackable.stderr, /must be Git-ignored/);

  fs.writeFileSync(path.join(root, '.gitignore'), 'security-audit-*.md\n', 'utf8');
  const ignored = runCli(root, ['--output', 'security-audit-private.md']);
  assert.strictEqual(ignored.status, 0, ignored.stderr);
  assert.match(ignored.stdout, /Mode: preview only/);

  const tempTrackable = runCli(root, [
    '--output', 'security-audit-private.md',
    '--write',
    '--confirm', extractConfirmation(ignored.stdout)
  ]);
  assert.strictEqual(tempTrackable.status, 1);
  assert.match(tempTrackable.stderr, /must be Git-ignored/);
  assert.deepStrictEqual(fs.readdirSync(root).sort(), ['.git', '.gitignore']);

  fs.writeFileSync(
    path.join(root, '.gitignore'),
    'security-audit-*.md\n.security-audit-*.md.*.tmp\n',
    'utf8'
  );
  const fullyIgnored = runCli(root, ['--output', 'security-audit-private.md']);
  assert.strictEqual(fullyIgnored.status, 0, fullyIgnored.stderr);
  const written = runCli(root, [
    '--output', 'security-audit-private.md',
    '--write',
    '--confirm', extractConfirmation(fullyIgnored.stdout)
  ]);
  assert.strictEqual(written.status, 0, written.stderr);
  assert.deepStrictEqual(
    fs.readdirSync(root).sort(),
    ['.git', '.gitignore', 'security-audit-private.md']
  );
});

test('Git ignore drift before or after installation fails closed without a trackable report', t => {
  const root = fixture(t);
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
  if (initialized.error && initialized.error.code === 'ENOENT') {
    t.skip('Git is unavailable; ignore-drift handling requires an actual worktree.');
    return;
  }
  assert.strictEqual(initialized.status, 0, initialized.stderr);
  const ignorePath = path.join(root, '.gitignore');
  const fullIgnore = 'security-audit-*.md\n.security-audit-*.md.*.tmp\n';
  const tempOnlyIgnore = '.security-audit-*.md.*.tmp\n';

  for (const hookName of ['beforeInstall', 'afterInstall']) {
    fs.writeFileSync(ignorePath, fullIgnore, 'utf8');
    const targetName = `security-audit-ignore-drift-${hookName}.md`;
    const dependencies = {
      [hookName]() {
        fs.writeFileSync(ignorePath, tempOnlyIgnore, 'utf8');
      }
    };
    const attempt = exactWrite(root, targetName, dependencies);

    assert.throws(attempt.invoke, /must be Git-ignored[\s\S]*Partial-state report/);
    assert.strictEqual(fs.existsSync(attempt.target), false);
    assert.deepStrictEqual(
      fs.readdirSync(root).filter(name => name.endsWith('.tmp')),
      []
    );
  }
});

test('custom trackable-style filenames are rejected before any report write', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'docs'));
  const result = runCli(root, ['--output', path.join('docs', 'audit.md')]);
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /filename must match security-audit-/);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'docs')), []);
});

test('strict argument parsing rejects boolean values, duplicates, and detached confirmations', () => {
  for (const args of [
    ['--write=false'],
    ['--write', 'false'],
    ['--write', '--write'],
    ['--output', 'one.md', '--output', 'two.md'],
    ['--standalone-private=false'],
    ['--standalone-private', '--standalone-private'],
    ['--confirm', 'value'],
    ['--output', '--write'],
    ['--help', '--write']
  ]) {
    assert.throws(() => parseArgs(args));
  }
});
