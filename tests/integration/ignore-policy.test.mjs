// tests/integration/ignore-policy.test.mjs — the ignore policy is ONE statement, and it must hold
// in BOTH trees: this working repository and the published one generated from
// templates/gitignore.public.
//
// Why behaviour and not text: a line `opencode.json` sitting in a file and a path that git actually
// refuses to stage are different claims. Only the second one protects anything. v1.7.0 learned this
// the expensive way — where instructions and behaviour disagree, behaviour wins — so every check
// here asks git, never grep.
//
// Written RED in v1.7.1 before any code: the working .gitignore carried none of the secret-bearing
// entries and .playwright-mcp/ was missing from both trees. They are the version's acceptance, so
// they were led to green by the implementation and never edited to fit it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// Paths that must never reach git in ANY tree, and why each one is on the list:
//   opencode.json   — tools/provision-opencode.mjs reads config/.env and inlines REAL secret
//                     values (MCP keys, session strings) into it;
//   AGENTS.md       — generated from CLAUDE.md, machine-local;
//   .opencode/      — generated backend state, machine-local;
//   .playwright-mcp/— page snapshots left behind by the Playwright MCP server; in this repository
//                     they turned out to belong to an unrelated project entirely.
const SECRET_BEARING = [
  'opencode.json',
  'AGENTS.md',
  '.opencode/state.json',
  '.playwright-mcp/page.yml',
];

// `git check-ignore` refuses to report a TRACKED path as ignored. --no-index asks the question we
// actually mean here: does a rule cover this path? Whether the path is also stuck in the index is a
// separate defect, asserted separately below.
function ruleCovers(cwd, path) {
  const r = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', path], { cwd, encoding: 'utf8' });
  return r.status === 0;
}

function isTracked(cwd, path) {
  const r = spawnSync('git', ['ls-files', '--error-unmatch', '--', path], { cwd, encoding: 'utf8' });
  return r.status === 0;
}

// Asking about one representative filename would let real tracked files hide behind a name nobody
// happens to use: .playwright-mcp/ holds page-<timestamp>.yml, never page.yml. Ask about the
// pathspec instead, and let git enumerate whatever is actually in the index underneath it.
function trackedUnder(cwd, pathspec) {
  const r = spawnSync('git', ['ls-files', '--', pathspec], { cwd, encoding: 'utf8' });
  return String(r.stdout || '').split('\n').filter(Boolean);
}

test('ignore policy: the WORKING tree refuses every secret-bearing path', () => {
  const uncovered = SECRET_BEARING.filter(p => !ruleCovers(ROOT, p));
  assert.deepEqual(
    uncovered, [],
    `the working .gitignore does not cover: ${uncovered.join(', ')}. ` +
    'Provisioning writes opencode.json with live secret values next to these rules; ' +
    'without them one `git add .` publishes the keys.',
  );
});

test('ignore policy: the PUBLISHED tree refuses every secret-bearing path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ignore-public-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    copyFileSync(join(ROOT, 'templates', 'gitignore.public'), join(dir, '.gitignore'));
    const uncovered = SECRET_BEARING.filter(p => !ruleCovers(dir, p));
    assert.deepEqual(
      uncovered, [],
      `templates/gitignore.public does not cover: ${uncovered.join(', ')}`,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ignore policy: the two trees agree — neither protects what the other does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ignore-parity-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    copyFileSync(join(ROOT, 'templates', 'gitignore.public'), join(dir, '.gitignore'));
    const drift = SECRET_BEARING
      .map(p => ({ path: p, working: ruleCovers(ROOT, p), published: ruleCovers(dir, p) }))
      .filter(r => r.working !== r.published);
    assert.deepEqual(
      drift, [],
      'the ignore policy is stored twice and the copies disagree: ' +
      drift.map(d => `${d.path} (working=${d.working}, published=${d.published})`).join('; '),
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ignore policy: no secret-bearing path is stuck in the index', () => {
  const pathspecs = ['opencode.json', 'AGENTS.md', '.opencode', '.playwright-mcp'];
  const tracked = pathspecs.flatMap(p => trackedUnder(ROOT, p));
  assert.deepEqual(
    tracked, [],
    `already tracked, so an ignore rule alone will not help: ${tracked.join(', ')}. ` +
    'These need `git rm -r --cached`.',
  );
});

test('ignore policy: config/.env is ignored and absent from the index', () => {
  assert.ok(ruleCovers(ROOT, 'config/.env'), 'config/.env is not covered by any ignore rule');
  assert.ok(!isTracked(ROOT, 'config/.env'), 'config/.env is tracked — it holds live secrets');
});

// The sanitisation gate moved to tests/{unit,integration}/secret-scan.test.mjs in v1.7.1: once
// lib/secret-scan.mjs gave the rule a callable home, the claim could be asserted directly instead
// of by running the whole 40-second smoke suite from inside the test suite. Both directions are
// now proven in isolation, which the coarse end-to-end run never did.
