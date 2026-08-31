// tests/integration/driver-secret-notice.test.mjs — the secrets notice, on the default driver.
//
// README, GUIDELINE and docs/failure-modes all state this without naming an engine: if a commit
// picks up a file that looks like key storage, you get a line in the log and a notification. It was
// wired into core/supervisor.mjs only. On the Claude Code driver nobody was watching — which is
// exactly where a live project committed a file holding root passwords for two servers, and only
// human eyes caught it.
//
// Found in v1.8.0 while checking whether any other promise was true for one driver out of two. It
// was the second instance of that class in the same area as the first, so it was closed in the same
// version rather than written down as a note for later.
//
// The notice BLOCKS NOTHING. That is a deliberate decision the project has held since v1.5.0: the
// ability to commit a key is preserved, and the job of this code is to inform.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STOP_HOOK = join(ROOT, 'hooks', 'ralph-loop-stop.mjs');

const STATE = `---
schema_version: 1
current_stage: 2
current_version: "1"
released_version: "0"
blockers: []
iteration: 0
max_iterations: 60
next_step_prompt: "carry on"
---

# Journal
`;

function git(dir, args) {
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function mkRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'secret-notice-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'STATE.md'), STATE, 'utf8');
  writeFileSync(join(dir, 'readme.txt'), 'start\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'initial']);
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

// One turn of the Claude Code driver. stderr is what the notice writes to.
function turn(dir) {
  const r = spawnSync(process.execPath, [STOP_HOOK], {
    input: JSON.stringify({ session_id: 'live', stop_hook_active: false }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  return { out: r.stdout || '', err: r.stderr || '' };
}

test('secrets: a committed .env is noticed by the Claude Code driver', () => {
  const p = mkRepo();
  try {
    turn(p.dir);                                   // baseline: remembers the current HEAD

    // The agent commits a file that looks like key storage — the shape of the live incident.
    writeFileSync(join(p.dir, '.env'), 'GITHUB_TOKEN=redacted\n', 'utf8');
    git(p.dir, ['add', '-f', '.env']);
    git(p.dir, ['commit', '-qm', 'work']);

    const second = turn(p.dir);
    assert.match(
      second.err, /key storage/i,
      'a commit picked up .env and the driver said nothing — the promise in README and GUIDELINE is ' +
      'stated without naming an engine',
    );
    assert.match(second.err, /\.env/, 'the notice must name the file');
  } finally { p.cleanup(); }
});

test('secrets: the notice informs and never blocks', () => {
  const p = mkRepo();
  try {
    turn(p.dir);
    writeFileSync(join(p.dir, 'id_rsa'), 'PRIVATE KEY\n', 'utf8');
    git(p.dir, ['add', '-f', 'id_rsa']);
    git(p.dir, ['commit', '-qm', 'work']);

    const second = turn(p.dir);
    assert.match(second.err, /key storage/i);
    assert.match(
      second.out, /"decision":"block"/,
      'the loop must continue: blocking a commit is a power this project has deliberately refused',
    );
  } finally { p.cleanup(); }
});

test('secrets: an ordinary commit produces no notice', () => {
  const p = mkRepo();
  try {
    turn(p.dir);
    writeFileSync(join(p.dir, 'src.mjs'), 'export const x = 1;\n', 'utf8');
    git(p.dir, ['add', '-A']);
    git(p.dir, ['commit', '-qm', 'work']);

    const second = turn(p.dir);
    assert.doesNotMatch(
      second.err, /key storage/i,
      'a warning on every commit is a warning nobody reads',
    );
  } finally { p.cleanup(); }
});
