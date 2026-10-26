import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const scanner = resolve(import.meta.dirname, 'check-public.mjs');
const syntheticToken = ['gh', 'p_', 'S'.repeat(36)].join('');

function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'ir-public-scan-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: directory, stdio: 'pipe' }).toString().trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'Synthetic Scanner Test');
    git('config', 'user.email', 'synthetic@example.invalid');
    writeFileSync(join(directory, '.gitignore'), 'dist/\n');
    writeFileSync(join(directory, 'README.md'), 'Synthetic test content.');
    git('add', '.');
    git('commit', '-qm', 'Synthetic baseline');
    mkdirSync(join(directory, 'dist'));
    writeFileSync(join(directory, 'dist', 'index.html'), '<p>Synthetic local build</p>');
    const scan = (...args) =>
      spawnSync(process.execPath, [scanner, ...args], { cwd: directory, encoding: 'utf8' });
    run({ directory, git, scan });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('empty staged diff still scans HEAD, index and working files', () => {
  fixture(({ git, scan }) => {
    assert.equal(git('diff', '--cached', '--name-only'), '');
    const result = scan();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /HEAD=2, index=2, worktree=2/);
  });
});

test('rejects synthetic credential in tracked worktree when staging is empty', () => {
  fixture(({ directory, git, scan }) => {
    writeFileSync(join(directory, 'README.md'), syntheticToken);
    assert.equal(git('diff', '--cached', '--name-only'), '');
    const result = scan();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /worktree:.*possible credential pattern/);
    assert.ok(!result.stderr.includes(syntheticToken));
  });
});

test('checks complete staged snapshots even after worktree cleanup', () => {
  fixture(({ directory, git, scan }) => {
    writeFileSync(join(directory, 'README.md'), syntheticToken);
    git('add', 'README.md');
    writeFileSync(join(directory, 'README.md'), 'Synthetic clean worktree.');
    const result = scan();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /index:.*possible credential pattern/);
  });
});

test('checks nonignored untracked intended files and runtime artifacts', () => {
  fixture(({ directory, scan }) => {
    writeFileSync(join(directory, 'untracked.txt'), syntheticToken);
    writeFileSync(join(directory, 'data.sqlite'), 'Synthetic runtime data.');
    const result = scan();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /untracked\.txt.*possible credential pattern/);
    assert.match(result.stderr, /data\.sqlite.*runtime or environment artifact/);
  });
});

test('base range scans intermediate committed blobs removed before HEAD', () => {
  fixture(({ directory, git, scan }) => {
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(directory, 'temporary.txt'), syntheticToken);
    git('add', 'temporary.txt');
    git('commit', '-qm', 'Synthetic intermediate content');
    git('rm', '-q', 'temporary.txt');
    git('commit', '-qm', 'Remove synthetic intermediate content');
    assert.equal(scan().status, 0);
    const result = scan('--base', base);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /history=1 across 2 commits/);
    assert.match(result.stderr, /history .*temporary\.txt.*possible credential pattern/);
  });
});

test('client build still requires separation from provider config and credentials', () => {
  fixture(({ directory, scan }) => {
    writeFileSync(join(directory, 'dist', 'app.js'), 'const synthetic = "TRANSLATION_API_KEY";');
    const result = scan();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /server configuration or authentication code in client build/);
  });
});

test('missing build or invalid base never reports success', () => {
  fixture(({ directory, scan }) => {
    const badBase = scan('--base', 'not-a-real-ref');
    assert.equal(badBase.status, 1);
    assert.ok(!badBase.stdout.includes('PASS:'));
    rmSync(join(directory, 'dist'), { recursive: true });
    const missingBuild = scan();
    assert.equal(missingBuild.status, 1);
    assert.match(missingBuild.stderr, /build required/);
  });
});

test('refuses success when the repository scan scope is empty', () => {
  fixture(({ directory, git, scan }) => {
    writeFileSync(join(directory, '.git', 'info', 'exclude'), 'dist/\n');
    git('rm', '-q', '.gitignore', 'README.md');
    git('commit', '-qm', 'Synthetic empty repository');
    const result = scan();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /HEAD=0, index=0, worktree=0/);
    assert.match(result.stderr, /refusing an empty-scope success/);
  });
});

test('empty dist never reports a successful client build scan', () => {
  fixture(({ directory, scan }) => {
    rmSync(join(directory, 'dist', 'index.html'));
    const result = scan();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /client build=0/);
    assert.match(result.stderr, /no client build files scanned; build required/);
    assert.ok(!result.stdout.includes('PASS:'));
  });
});
