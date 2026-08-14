import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeBackend } from '../../core/backends/claude.mjs';

function tmp() { return mkdtempSync(join(tmpdir(), 'adapter-')); }

// --- Claude ---

test('ClaudeBackend.installInstructions → CLAUDE.md', async () => {
  const d = tmp();
  try {
    const r = await new ClaudeBackend().installInstructions({ targetDir: d, content: 'CONTENT' });
    assert.equal(readFileSync(join(d, 'CLAUDE.md'), 'utf8'), 'CONTENT');
    assert.ok(r.written[0].endsWith('CLAUDE.md'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('ClaudeBackend.applyPermissions → .claude/settings.json + merge/dedupe', async () => {
  const d = tmp();
  try {
    const b = new ClaudeBackend();
    await b.applyPermissions({ policy: { allow: ['Bash(git *)'], deny: ['Bash(rm *)'] }, targetDir: d });
    await b.applyPermissions({ policy: { allow: ['Bash(git *)', 'Bash(ls)'] }, targetDir: d }); // a repeated call must not duplicate anything
    const s = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(s.permissions.allow.sort(), ['Bash(git *)', 'Bash(ls)']); // deduplication
    assert.deepEqual(s.permissions.deny, ['Bash(rm *)']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('ClaudeBackend.guardCommand + id', () => {
  const b = new ClaudeBackend();
  assert.equal(b.id, 'claude');
  assert.ok(b.guardCommand('git push --force'));
  assert.equal(b.guardCommand('git status'), null);
});
