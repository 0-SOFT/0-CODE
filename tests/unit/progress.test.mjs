import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { captureSnapshot, assessProgress, escalationDirective } from '../../core/progress.mjs';

// A temporary git repository with a single commit (real git, no mocks).
function mkGitDir() {
  const dir = mkdtempSync(join(tmpdir(), 'progress-test-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '.');
  git('config', 'user.email', 't@t.local');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'v1\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'init');
  return { dir, git, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

test('captureSnapshot/assessProgress: no changes → no progress', () => {
  const g = mkGitDir();
  try {
    const a = captureSnapshot({ cwd: g.dir });
    const b = captureSnapshot({ cwd: g.dir });
    const r = assessProgress(a, b);
    assert.equal(r.progressed, false);
    assert.equal(r.evidence.length, 0);
  } finally { g.cleanup(); }
});

test('assessProgress: a working-tree edit → progress', () => {
  const g = mkGitDir();
  try {
    const a = captureSnapshot({ cwd: g.dir });
    writeFileSync(join(g.dir, 'a.txt'), 'v2\n');
    const b = captureSnapshot({ cwd: g.dir });
    const r = assessProgress(a, b);
    assert.equal(r.progressed, true);
    assert.ok(r.evidence.some(e => /working tree/.test(e)));
  } finally { g.cleanup(); }
});

test('assessProgress: a new commit → progress (git HEAD)', () => {
  const g = mkGitDir();
  try {
    const a = captureSnapshot({ cwd: g.dir });
    writeFileSync(join(g.dir, 'a.txt'), 'v2\n');
    g.git('add', 'a.txt');
    g.git('commit', '-q', '-m', 'next');
    const b = captureSnapshot({ cwd: g.dir });
    const r = assessProgress(a, b);
    assert.equal(r.progressed, true);
    assert.ok(r.evidence.some(e => /git/.test(e)));
  } finally { g.cleanup(); }
});

test('assessProgress: a change to the STATE file → progress', () => {
  const g = mkGitDir();
  try {
    const st = join(g.dir, 'STATE.md');
    writeFileSync(st, '---\niteration: 0\n---\n');
    const a = captureSnapshot({ cwd: g.dir, stateFile: st });
    writeFileSync(st, '---\niteration: 1\n---\n');
    const b = captureSnapshot({ cwd: g.dir, stateFile: st });
    const r = assessProgress(a, b);
    assert.equal(r.progressed, true);
    assert.ok(r.evidence.some(e => /STATE/.test(e)));
  } finally { g.cleanup(); }
});

test('captureSnapshot: a directory without git → null fields, no crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'progress-nogit-'));
  try {
    const s = captureSnapshot({ cwd: dir });
    assert.equal(s.gitHead, null);
    assert.equal(s.treeHash, null);
    assert.equal(s.stateHash, null);
    const r = assessProgress(s, captureSnapshot({ cwd: dir }));
    assert.equal(r.progressed, false);
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

test('escalationDirective: carries the original prompt and the demand to execute', () => {
  const d = escalationDirective('do X', 2);
  assert.ok(d.includes('do X'));
  assert.ok(/SUPERVISOR ESCALATION/.test(d));
  assert.ok(/2/.test(d));
});
