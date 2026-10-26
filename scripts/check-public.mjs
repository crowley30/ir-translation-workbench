import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Limited known-pattern guard, not an exhaustive secret or personal-data audit.
// Scan published HEAD, the complete index and working files even with an empty index diff.
// --base REF also checks each changed committed snapshot in REF..HEAD, not only its final diff.
const forbidden =
  /(^|\/)(node_modules|\.data|playwright-report|test-results|coverage|dist)(\/|$)|(^|\/)\.env(?:\..+)?$|\.(sqlite(?:[-.].*)?|db|log)$/;
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/,
];
const serverPatterns =
  /TRANSLATION_API_KEY|TRANSLATION_API_URL|ALLOW_REAL_TRANSLATION|Authorization:|Bearer /;
const maxBytes = 10 * 1024 * 1024;
const counts = { head: 0, index: 0, worktree: 0, history: 0, commits: 0, clientBuild: 0 };
const problems = [];
let root;
let base;
let head;

function git(args) {
  return execFileSync('git', args, {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function names(args) {
  return git(args).toString().split('\0').filter(Boolean);
}
function inspectContent(label, content) {
  if (content.byteLength > maxBytes) {
    problems.push(`${label}: exceeds 10 MiB scan limit; manual review required`);
    return;
  }
  // Search binary content too: readable credentials may be embedded in an otherwise binary file.
  if (patterns.some((pattern) => pattern.test(content.toString('utf8'))))
    problems.push(`${label}: possible credential pattern`);
}
function inspectFile(label, file, content) {
  if (file !== '.env.example' && forbidden.test(file))
    problems.push(`${label}: runtime or environment artifact`);
  inspectContent(label, content);
}
function tree(ref) {
  return names(['ls-tree', '-r', '-z', ref]).map((entry) => {
    const tab = entry.indexOf('\t');
    const [mode, type, sha] = entry.slice(0, tab).split(' ');
    return { mode, type, sha, file: entry.slice(tab + 1) };
  });
}
function inspectTree(ref, kind, selected) {
  for (const { type, sha, file } of tree(ref)) {
    if (selected && !selected.has(file)) continue;
    const label = `${kind} ${ref.slice(0, 12)}:${JSON.stringify(file)}`;
    if (type !== 'blob') {
      problems.push(`${label}: unsupported Git object; manual review required`);
      continue;
    }
    counts[kind]++;
    inspectFile(label, file, git(['cat-file', 'blob', sha]));
  }
}
function inspectDist(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      problems.push(`${JSON.stringify(path)}: client build symlink; manual review required`);
    } else if (entry.isDirectory()) inspectDist(path);
    else {
      counts.clientBuild++;
      const content = readFileSync(path);
      inspectContent(`client build ${JSON.stringify(path)}`, content);
      if (/\.(js|html|css|map)$/.test(path) && serverPatterns.test(content.toString('utf8')))
        problems.push(
          `${JSON.stringify(path)}: server configuration or authentication code in client build`,
        );
    }
  }
}

try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--base'))
    throw new Error('usage: node scripts/check-public.mjs [--base REF]');
  root = git(['rev-parse', '--show-toplevel']).toString().trim();
  head = git(['rev-parse', '--verify', 'HEAD^{commit}']).toString().trim();
  if (args.length) {
    // Resolve user input before passing the resulting object ID to later Git commands.
    base = git(['rev-parse', '--verify', '--end-of-options', `${args[1]}^{commit}`])
      .toString()
      .trim();
    git(['merge-base', '--is-ancestor', base, head]);
  }
  inspectTree(head, 'head');

  for (const entry of names(['ls-files', '--stage', '-z'])) {
    const tab = entry.indexOf('\t');
    const [, sha, stage] = entry.slice(0, tab).split(' ');
    const file = entry.slice(tab + 1);
    const label = `index:${JSON.stringify(file)}`;
    if (stage !== '0') {
      problems.push(`${label}: unresolved merge; manual review required`);
      continue;
    }
    counts.index++;
    inspectFile(label, file, git(['cat-file', 'blob', sha]));
  }

  const workingFiles = new Set(
    names(['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
  );
  for (const file of workingFiles) {
    const path = resolve(root, file);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue; // A deletion remains covered by HEAD/index snapshots.
      throw error;
    }
    const label = `worktree:${JSON.stringify(file)}`;
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      problems.push(`${label}: unsupported working file; manual review required`);
      continue;
    }
    counts.worktree++;
    if (stat.size > maxBytes) {
      problems.push(`${label}: exceeds 10 MiB scan limit; manual review required`);
      continue;
    }
    // Read only a symlink's stored target, never content outside the repository.
    inspectFile(
      label,
      file,
      stat.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path),
    );
  }

  if (base) {
    const commits = git(['rev-list', '--reverse', `${base}..${head}`])
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
    counts.commits = commits.length;
    for (const commit of commits) {
      const changed = new Set(
        names([
          'diff-tree',
          '--root',
          '-m',
          '--no-commit-id',
          '--name-only',
          '-r',
          '-z',
          '--no-renames',
          '--diff-filter=ACMRT',
          commit,
        ]),
      );
      inspectTree(commit, 'history', changed);
    }
  }

  const dist = join(root, 'dist');
  if (!existsSync(dist)) problems.push('dist: build required before public-content check');
  else if (lstatSync(dist).isSymbolicLink())
    problems.push('dist: client build symlink; manual review required');
  else inspectDist(dist);
  if (counts.clientBuild === 0)
    problems.push(
      'dist: no client build files scanned; build required before public-content check',
    );
  if (counts.head + counts.index + counts.worktree + counts.history === 0)
    problems.push('no repository files scanned; refusing an empty-scope success');

  console.info(
    `Reviewed HEAD ${head}; ${base ? `commit range ${base}..${head}` : 'no historical range requested (use --base REF)'}.`,
  );
  console.info(
    `File snapshots: HEAD=${counts.head}, index=${counts.index}, worktree=${counts.worktree}, history=${counts.history} across ${counts.commits} commits; client build=${counts.clientBuild}.`,
  );
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  } else {
    console.info(
      'PASS: reviewed snapshots contain no matched known credential patterns/runtime artifacts; client build contains no matched server provider configuration. Manual sensitive-data review remains required.',
    );
  }
} catch (error) {
  // Do not print Git stderr or file content: a bad ref or failure may contain sensitive input.
  console.error(
    error.message?.startsWith('usage:')
      ? error.message
      : 'Public-content check could not complete; no success reported. Check repository, base ref, and readable file size.',
  );
  process.exitCode = 1;
}
