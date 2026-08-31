// tests/integration/bootstrap-install.test.mjs — what the installer PROMISES against what it does.
//
// Both claims below come from a live incident (target project ST0NKS-S, framework 1.7.0):
//   - the installer announced "The Ralph Loop is now active" after being run inside an already
//     running Claude Code session, where the hooks it had just written could not possibly be
//     loaded — Claude Code reads .claude/settings.json at session start;
//   - the installer replaced the project's own .gitignore, and the rule hiding a file of root
//     passwords disappeared from the ACTIVE file. A backup was taken, so nothing was lost, but the
//     next commit picked up the secrets.
//
// Every check runs the real bootstrap.sh into a temporary directory and reads the result, because
// the question is what the installer does, not what its source says.
//
// RED on purpose until v1.8.0: bootstrap.sh prints the success line unconditionally and copies
// .gitignore over whatever was there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BOOTSTRAP = join(ROOT, 'bootstrap.sh');

// A rule a real project had and the framework's template does not: the exact shape of the line
// whose loss put root passwords into a commit.
const PRIVATE_RULE = 'docs/userdocs/VPS.md';

function install(target, extraEnv = {}) {
  const r = spawnSync('bash', [BOOTSTRAP, target], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function mkTarget() {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-'));
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

test('bootstrap: an install INSIDE a running session does not claim the loop is active', () => {
  const t = mkTarget();
  try {
    // CLAUDECODE=1 is what a live Claude Code session actually exports — measured, not assumed.
    // (CLAUDE_PROJECT_DIR, the other candidate, is substituted into hook commands and is NOT
    // present in the environment of a command the session runs.)
    const r = install(t.dir, { CLAUDECODE: '1' });
    assert.equal(r.status, 0, 'the install itself succeeds — only its final message is at issue');
    assert.doesNotMatch(
      r.out, /Ralph Loop is now active/,
      'the hooks were written to a file the running session already read; the loop is NOT active',
    );
    assert.match(
      r.out, /restart/i,
      'the installer must say the session has to be restarted before the loop runs',
    );
    // Being present is not enough. A live run of the first attempt showed the warning printed in
    // the middle of the summary, with three more sections scrolling past underneath it — true and
    // useless. The one thing the reader must not miss has to be the last thing they see.
    const tail = r.out.trimEnd().split(/\r?\n/).slice(-8).join('\n');
    assert.match(
      tail, /ATTENTION|NOT RUNNING/i,
      'the warning must be the LAST block of output, not buried above PM2 and toolset notes',
    );
  } finally { t.cleanup(); }
});

test('bootstrap: an install OUTSIDE a session still reports the loop as active', () => {
  const t = mkTarget();
  try {
    // The warning must be conditional. Removing the success line everywhere would trade one wrong
    // message for another.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_SESSION_ID;
    const r = spawnSync('bash', [BOOTSTRAP, t.dir], { encoding: 'utf8', env });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    assert.equal(r.status, 0);
    assert.match(out, /Ralph Loop is now active/);
  } finally { t.cleanup(); }
});

test("bootstrap: a rule in the project's own .gitignore survives the install", () => {
  const t = mkTarget();
  try {
    writeFileSync(join(t.dir, '.gitignore'), `# project rules\n${PRIVATE_RULE}\n`, 'utf8');
    install(t.dir);

    // The ACTIVE file, not the backup: a rule that lives only in .gitignore.bak protects nothing.
    const active = readFileSync(join(t.dir, '.gitignore'), 'utf8');
    assert.ok(
      active.split(/\r?\n/).includes(PRIVATE_RULE),
      `${PRIVATE_RULE} vanished from the active .gitignore — this is how a file of root passwords ` +
      'reached a commit in the incident that prompted v1.8.0',
    );
    // And the framework's own protection must have arrived alongside it, not instead of it.
    assert.match(active, /^\.env$/m, 'the framework rules must be merged in, not skipped');
  } finally { t.cleanup(); }
});

test('bootstrap: merging is idempotent — a second install duplicates nothing', () => {
  const t = mkTarget();
  try {
    writeFileSync(join(t.dir, '.gitignore'), `${PRIVATE_RULE}\n`, 'utf8');
    install(t.dir);
    install(t.dir);
    const lines = readFileSync(join(t.dir, '.gitignore'), 'utf8').split(/\r?\n/).filter(Boolean);
    const dupes = lines.filter((l, i) => !l.startsWith('#') && lines.indexOf(l) !== i);
    assert.deepEqual(dupes, [], `repeated install duplicated: ${dupes.join(', ')}`);
  } finally { t.cleanup(); }
});

test('bootstrap: files it OVERWRITES are named in the summary, not buried in it', () => {
  const t = mkTarget();
  try {
    // A framework artefact, deliberately: since v1.8.0 .gitignore and .gitattributes are merged and
    // never replaced, so they can no longer stand in for "a file that gets overwritten". The claim
    // under test is unchanged — what is replaced must be named — only the fixture had to move to a
    // file the installer still replaces.
    mkdirSync(join(t.dir, 'lib'), { recursive: true });
    writeFileSync(join(t.dir, 'lib', 'yaml-mini.mjs'), '// an older copy\n', 'utf8');
    const r = install(t.dir);
    // Not "is the word 'overwrite' somewhere in 150 lines of output" — is there a summary block a
    // reader cannot scroll past.
    assert.match(
      r.out, /overwritten|replaced/i,
      'the installer must summarise which existing files it replaced',
    );
  } finally { t.cleanup(); }
});
