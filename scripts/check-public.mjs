import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// A small pre-commit guard. Synthetic fixtures and all staged files also need human review.
const files = execFileSync('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACM'])
  .toString()
  .split('\0')
  .filter(Boolean);
const forbidden =
  /(^|\/)(node_modules|\.data|playwright-report|test-results|coverage|dist)(\/|$)|(^|\/)\.env(?:\..+)?$|\.(sqlite(?:-wal|-shm)?|db|log)$/;
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/,
];
const problems = [];
for (const file of files) {
  if (file !== '.env.example' && forbidden.test(file))
    problems.push(`${file}: runtime or environment artifact`);
  const content = execFileSync('git', ['show', `:${file}`], { maxBuffer: 5 * 1024 * 1024 });
  if (!content.includes(0) && patterns.some((pattern) => pattern.test(content.toString())))
    problems.push(`${file}: possible credential pattern`);
}
function inspectDist(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) inspectDist(path);
    else if (
      /\.(js|html|css|map)$/.test(path) &&
      /TRANSLATION_API_KEY|TRANSLATION_API_URL|ALLOW_REAL_TRANSLATION|Authorization:|Bearer /.test(
        readFileSync(path, 'utf8'),
      )
    )
      problems.push(`${path}: server configuration or authentication code in client build`);
  }
}
if (existsSync('dist')) inspectDist('dist');
else problems.push('dist: build required before public-content check');
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else
  console.info(
    `PASS: ${files.length} staged files checked; no known credential patterns/runtime artifacts; client build contains no server provider configuration.`,
  );
