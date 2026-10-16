import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexHome } from '../../core/backends/codex-home.mjs';
import { OpenCodeBackend } from '../../core/backends/opencode.mjs';
import { writeJsonConfig, readJsonConfig } from '../../lib/json-config.mjs';
import { holdWindowsReadLock } from '../helpers/windows-file-lock.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'file-publication-'));
  const project = join(base, 'project'), home = join(base, 'owned'); mkdirSync(project);
  t.after(() => cleanupTempDir(base));
  return { base, project, home };
}
const windows = { skip: process.platform !== 'win32' };

test('Codex restores the captured configuration through a brief real Windows reader lock', windows, async t => {
  const f = fixture(t);
  const host = new CodexHome({ homeDir: f.home, userHome: join(f.base, 'personal'), env: {} });
  const ready = host.prepareExecution({ cwd: f.project });
  const expected = readFileSync(ready.configFile); writeFileSync(ready.configFile, 'damaged');
  const reader = await holdWindowsReadLock(ready.configFile);
  try {
    const restored = host.prepareExecution({ cwd: f.project });
    assert.ok(restored.restored.includes(ready.configFile));
    assert.deepEqual(readFileSync(ready.configFile), expected);
  } finally { reader.release(); await reader.closed; }
});

test('OpenCode restores its external detector through a brief real Windows reader lock', windows, async t => {
  const f = fixture(t), host = new OpenCodeBackend();
  const ready = await host.ensureReady({ cwd: f.project, home: f.home });
  const expected = readFileSync(ready.safetyFile); writeFileSync(ready.safetyFile, 'damaged');
  const reader = await holdWindowsReadLock(ready.safetyFile);
  try {
    await host.ensureReady({ cwd: f.project, home: f.home });
    assert.deepEqual(readFileSync(ready.safetyFile), expected);
  } finally { reader.release(); await reader.closed; }
});

test('JSON publication keeps the complete new object through a brief real Windows reader lock', windows, async t => {
  const f = fixture(t), file = join(f.project, 'config.json'); writeJsonConfig(file, { old: true });
  const reader = await holdWindowsReadLock(file);
  try {
    writeJsonConfig(file, { new: 'complete', nested: { value: 42 } });
    assert.deepEqual(readJsonConfig(file), { new: 'complete', nested: { value: 42 } });
  } finally { reader.release(); await reader.closed; }
});
