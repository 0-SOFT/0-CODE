import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCodeBackend } from '../../core/backends/opencode.mjs';
import { ClaudeBackend } from '../../core/backends/claude.mjs';
import { CodexBackend } from '../../core/backends/codex.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const scratch = join(dirname(repo.replace(/[\\/]$/, '')), 'scratch', 'tmp'); mkdirSync(scratch, { recursive: true });
function fixture(t) { const root = mkdtempSync(join(scratch, 'preservation-')); t.after(() => cleanupTempDir(root)); return root; }
test('all three instruction adapter entrypoints preserve exact project prefix bytes and repeat without writes', async t => {
  for (const [Backend, filename] of [[ClaudeBackend, 'CLAUDE.md'], [OpenCodeBackend, 'AGENTS.md'], [CodexBackend, 'AGENTS.md']]) {
    const root = fixture(t), file = join(root, filename), before = Buffer.from('# Own rules\r\nPreserve trailing spaces  \r\n\r\n');
    writeFileSync(file, before);
    const adapter = new Backend(); await adapter.installInstructions({ targetDir: root, content: 'Cycle one' });
    const initial = readFileSync(file); assert.ok(initial.subarray(0, before.length).equals(before));
    assert.deepEqual((await adapter.installInstructions({ targetDir: root, content: 'Cycle one' })).written, []);
    await adapter.installInstructions({ targetDir: root, content: 'Cycle two' });
    const refreshed = readFileSync(file); assert.ok(refreshed.subarray(0, before.length).equals(before));
    assert.equal(refreshed.includes(Buffer.from('Cycle one')), false); assert.ok(refreshed.includes(Buffer.from('Cycle two')));
    writeFileSync(file, '<!-- BEGIN AUTONOMOUS FRAMEWORK -->\nbroken');
    const damaged = readFileSync(file);
    await assert.rejects(adapter.installInstructions({ targetDir: root, content: 'new' }), /markers/);
    assert.deepEqual(readFileSync(file), damaged);
  }
});
test('OpenCode MCP never replaces or removes a project server, and preserves bytes when nothing can be added', async t => {
  const root = fixture(t), file = join(root, 'opencode.json');
  const before = '{ "model":"mine", "mcp": { "same": {"type":"local", "command":["my-server"]} } }\r\n';
  writeFileSync(file, before);
  const adapter = new OpenCodeBackend(), manifest = { servers: [{ name: 'same', command: 'foreign-server' }] };
  const repeated = await adapter.registerMcp(manifest, {}, { targetDir: root });
  assert.deepEqual(repeated.preserved, ['same']); assert.deepEqual(repeated.registered, []);
  assert.equal(readFileSync(file, 'utf8'), before);
  await adapter.registerMcp({ servers: [{ name: 'same', command: 'foreign-server', secrets: ['UNSET'] }] }, {}, { targetDir: root });
  assert.equal(readFileSync(file, 'utf8'), before);
  const added = await adapter.registerMcp({ servers: [{ name: 'other', command: 'new-server' }] }, {}, { targetDir: root });
  assert.deepEqual(added.registered, ['other']);
  const config = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(config.mcp.same.command, ['my-server']); assert.deepEqual(config.mcp.other.command, ['new-server']);
});
test('an invalid MCP block refuses before altering any project bytes', async t => {
  const root = fixture(t), file = join(root, 'opencode.json'); writeFileSync(file, '{"mcp":[]}');
  await assert.rejects(new OpenCodeBackend().registerMcp({ servers: [{ name: 'x', command: 'x' }] }, {}, { targetDir: root }), /MCP block/);
  assert.equal(readFileSync(file, 'utf8'), '{"mcp":[]}');
});
