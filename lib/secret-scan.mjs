#!/usr/bin/env node
// secret-scan.mjs — look for real credentials in the files that could actually reach a commit.
//
// The emphasis is on "could actually reach a commit". The previous form of this check grepped a
// directory tree wholesale, which meant it read config/.env — a file that by design holds live
// values on every working machine, is ignored by git and is excluded from publication. The suite
// was therefore red wherever the framework is used and green only where it is not, and a
// permanently red suite teaches people to ignore red.
//
// The fix strengthens the claim rather than muting it. Instead of excluding one known filename, the
// scan asks git which files it would stage: `git ls-files --cached --others --exclude-standard`
// returns everything in the index plus untracked files that no ignore rule covers. Measured on this
// repository, that is 511 files against 512 on disk — the single difference being config/.env.
// A secret in a TRACKED file is still found; that direction is what the check exists for.
//
// Usage:  node lib/secret-scan.mjs [path...]     paths default to the repository root
// Exit:   0 nothing found, 1 findings printed to stdout, 2 usage or git failure.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Credential shapes with a distinctive prefix and a fixed alphabet. Deliberately narrow: a scanner
// that flags every long random string gets switched off within a week.
export const SECRET_PATTERNS = [
  { name: 'GitHub token', re: /ghp_[A-Za-z0-9]{36}/ },
  { name: 'GitHub fine-grained token', re: /github_pat_[A-Za-z0-9_]{22,}/ },
  { name: 'Anthropic key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenRouter key', re: /sk-or-v1-[A-Za-z0-9]{32,}/ },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{20,}/ },
];

// An explicitly masked candidate. Labels/comments elsewhere on a line cannot exempt a key.
// Short masks and ${VAR} references do not match a credential shape in the first place.
export const PLACEHOLDER = /^(?:(?:ghp_|github_pat_|sk-ant-(?:api\d+-)?|sk-or-v1-|AKIA|xox[baprs]-)?x{4,})$/i;

// Anything git would put in a commit: the index, plus untracked files no ignore rule covers.
// Ignored paths are absent by construction — no filename is special-cased here, which is why
// adding a new secret-bearing file to the ignore policy also removes it from this scan.
export function scannableFiles(root, paths = []) {
  const r = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...paths],
    { cwd: root, encoding: 'utf8' },
  );
  if (r.status !== 0) return null;          // not a work tree, or git is unavailable
  return String(r.stdout || '').split('\n').filter(Boolean);
}

export function findSecrets(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  const patterns = SECRET_PATTERNS.map(p => ({ ...p, re: new RegExp(p.re.source, p.re.flags + 'g') }));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const p of patterns) {
      for (const m of line.matchAll(p.re)) {
        if (!PLACEHOLDER.test(m[0])) out.push({ pattern: p.name, line: i + 1, match: m[0] });
      }
    }
  }
  return out;
}

// Never print a live credential: a scanner that echoes what it finds turns every CI log into the
// leak it was meant to prevent.
export function mask(secret) {
  const s = String(secret);
  const head = s.slice(0, Math.min(8, s.length));
  return `${head}${'*'.repeat(Math.max(3, s.length - head.length))}`;
}

export function scanPaths(root, paths = []) {
  const files = scannableFiles(root, paths);
  if (files === null) return null;
  const findings = [];
  for (const file of files) {
    let text;
    try { text = readFileSync(join(root, ...file.split('/'))); }
    catch { continue; }                                   // vanished between listing and reading
    if (text.includes(0)) continue;                       // binary, as grep -I would skip
    for (const f of findSecrets(text.toString('utf8'))) findings.push({ file, ...f });
  }
  return findings;
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const findings = scanPaths(root, process.argv.slice(2));
  if (findings === null) {
    process.stdout.write('secret-scan: not a git work tree — nothing could be staged from here\n');
    process.exit(2);
  }
  for (const f of findings) {
    process.stdout.write(`${f.file}:${f.line}: ${f.pattern} ${mask(f.match)}\n`);
  }
  process.exit(findings.length ? 1 : 0);
}
