#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function trackedMarkdown() {
  return execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', '*.md'], { cwd: ROOT })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function withoutFencedCode(content) {
  let fence = null;
  return content.split(/\r?\n/).map((line) => {
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`);
      if (closing.test(line)) fence = null;
      return '';
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (opening) {
      fence = { char: opening[1][0], length: opening[1].length };
      return '';
    }
    return line;
  }).join('\n');
}

function linkTarget(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('<')) {
    const end = trimmed.indexOf('>');
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  return trimmed.split(/\s+/, 1)[0];
}

test('relative Markdown file links resolve inside the repository', () => {
  const missing = [];
  for (const file of trackedMarkdown()) {
    const content = withoutFencedCode(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    const links = content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g);
    for (const match of links) {
      let target = linkTarget(match[1]);
      if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      target = target.split('#', 1)[0].split('?', 1)[0];
      if (!target || path.isAbsolute(target)) continue;

      let decoded;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        missing.push(`${file}: malformed link encoding`);
        continue;
      }

      const absolute = path.resolve(ROOT, path.dirname(file), decoded);
      const relativeToRoot = path.relative(ROOT, absolute);
      if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) continue;
      if (!fs.existsSync(absolute)) missing.push(`${file} -> ${target}`);
    }
  }
  assert.deepStrictEqual(missing, [], `Missing local links:\n${missing.join('\n')}`);
});

test('PowerShell casts and invocations inside fenced code are not parsed as Markdown links', () => {
  const source = [
    '```powershell',
    '$hash = [string](Get-FileHash -LiteralPath $path).Hash',
    '```',
    '[real link](README.md)',
    '',
  ].join('\n');
  const visible = withoutFencedCode(source);
  assert.doesNotMatch(visible, /Get-FileHash/);
  assert.match(visible, /\[real link\]\(README\.md\)/);
});
