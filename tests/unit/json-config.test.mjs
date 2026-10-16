import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJsonConfig, writeJsonConfig } from '../../lib/json-config.mjs';
import { ClaudeBackend } from '../../core/backends/claude.mjs';
import { OpenCodeBackend } from '../../core/backends/opencode.mjs';
import { registerClaudeMcp } from '../../core/backends/claude-mcp.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'json-configuration-'));
  t.after(() => cleanupTempDir(root)); return root;
}

test('missing JSON gets a fallback; atomic publication preserves content and leaves no staging files', t => {
  const root = fixture(t), file = join(root, 'nested', 'settings.json');
  assert.deepEqual(readJsonConfig(file, { custom: true }), { custom: true });
  const config = { user: 'preference', hooks: { Stop: [{ command: 'custom' }] } };
  writeJsonConfig(file, config);
  assert.deepEqual(readJsonConfig(file), config);
  assert.deepEqual(readdirSync(join(root, 'nested')), ['settings.json']);
  assert.throws(() => writeJsonConfig(join(root, 'invalid.json'), []), /must contain an object/);
  assert.equal(existsSync(join(root, 'invalid.json')), false);
});

test('malformed, non-object and non-file settings are refused without replacing original data', async t => {
  const root = fixture(t), file = join(root, 'settings.json');
  for (const content of ['{ unfinished', 'null', '[]']) {
    writeFileSync(file, content);
    assert.throws(() => readJsonConfig(file), /original preserved/);
    assert.equal(readFileSync(file, 'utf8'), content);
  }
  const directory = join(root, 'directory.json'); mkdirSync(directory);
  writeFileSync(join(directory, 'user.txt'), 'user data');
  assert.throws(() => readJsonConfig(directory), /ordinary file/);
  assert.throws(() => writeJsonConfig(directory, {}), /ordinary file/);
  assert.equal(readFileSync(join(directory, 'user.txt'), 'utf8'), 'user data');
});

test('both adapters refuse damaged permission configuration and preserve exact bytes', async t => {
  const root = fixture(t);
  for (const [backend, relative] of [[new ClaudeBackend(), '.claude/settings.json'], [new OpenCodeBackend(), 'opencode.json']]) {
    const file = join(root, relative); mkdirSync(join(file, '..'), { recursive: true });
    for (const content of ['{ user setting not finished', 'null', '[]']) {
      writeFileSync(file, content);
      await assert.rejects(backend.applyPermissions({ targetDir: root, policy: { allow: [], deny: [] } }), /original preserved/);
      assert.equal(readFileSync(file, 'utf8'), content);
    }
  }
});

test('Claude dry-run and duplicate registration preserve registry; corrupt registry or mcp map fails intact', t => {
  const root = fixture(t), file = join(root, '.claude.json');
  const manifest = { servers: [{ name: '__proto__', command: 'node' }] };
  assert.deepEqual(registerClaudeMcp(manifest, {}, { configFile: file, dryRun: true }).registered, ['__proto__']);
  assert.equal(existsSync(file), false);
  assert.deepEqual(registerClaudeMcp(manifest, {}, { configFile: file }).registered, ['__proto__']);
  const before = readFileSync(file, 'utf8');
  const duplicate = registerClaudeMcp(manifest, {}, { configFile: file });
  assert.deepEqual(duplicate.skipped, ['__proto__']);
  assert.equal(duplicate.reasons.__proto__, 'already registered');
  assert.equal(readFileSync(file, 'utf8'), before);
  for (const content of ['{ corrupt', '{"mcpServers":[]}']) {
    writeFileSync(file, content);
    assert.throws(() => registerClaudeMcp(manifest, {}, { configFile: file }), /preserved/);
    assert.equal(readFileSync(file, 'utf8'), content);
  }
});
