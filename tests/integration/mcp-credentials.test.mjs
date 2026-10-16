import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { generateOpenCodeMcp, OpenCodeBackend } from '../../core/backends/opencode.mjs';
import { ClaudeBackend } from '../../core/backends/claude.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';

const credential = 'fixture-declared-private-value';
const manifest = servers => ({ schema_version: 1, servers });

test('both private registries skip missing required values and deliver an explicit fallback', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-required-reference-'));
  t.after(() => cleanupTempDir(root));
  const script = join(root, 'server.cjs'); writeFileSync(script, 'process.stdout.write(process.env.PORT)');
  const servers = [
    { name: 'required-env', command: process.execPath, env: { API_KEY: '${MISSING}' } },
    { name: 'required-header', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${MISSING}' } },
    { name: 'optional', command: process.execPath, args: [script], source: 'custom-tool', env: { PORT: '${PORT:-50419}' } },
  ];
  for (const [id, backend] of [['claude', new ClaudeBackend()], ['opencode', new OpenCodeBackend()]]) {
    const project = join(root, id); mkdirSync(project);
    const configFile = join(project, '.claude.json');
    const result = await backend.registerMcp(manifest(servers), {}, { targetDir: project, configFile });
    assert.deepEqual(result.registered, ['optional']);
    assert.deepEqual(result.skipped, ['required-env', 'required-header']);
    const config = JSON.parse(readFileSync(id === 'claude' ? configFile : join(project, 'opencode.json'), 'utf8'));
    const entry = id === 'claude' ? config.mcpServers.optional : config.mcp.optional;
    const child = spawnSync(id === 'claude' ? entry.command : entry.command[0], id === 'claude' ? entry.args : entry.command.slice(1),
      { env: id === 'claude' ? entry.env : entry.environment, encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, '50419');
  }
});

test('OpenCode refuses declared credentials in a command, argument or URL', () => {
  for (const field of ['command', 'argument', 'url']) {
    const server = field === 'url' ? { name: 'private', type: 'http', url: 'https://example.test/${PRIVATE_KEY}' }
      : { name: 'private', type: 'stdio', command: field === 'command' ? '${PRIVATE_KEY}' : 'node',
        args: field === 'argument' ? ['${PRIVATE_KEY}'] : [] };
    server.secrets = ['PRIVATE_KEY'];
    const result = generateOpenCodeMcp(manifest([server]), { PRIVATE_KEY: credential });
    assert.deepEqual(result.skipped, ['private']);
    assert.match(result.reasons.private, /secret.*command|secret.*argument|secret.*URL/);
    assert.ok(!JSON.stringify(result).includes(credential));
  }
});

test('Claude registration never sends a credential as argv and delivers it through server environment', async t => {
  const root = mkdtempSync(join(tmpdir(), 'claude-mcp-credential-'));
  t.after(() => cleanupTempDir(root));
  const configFile = join(root, '.claude.json'), script = join(root, 'server.mjs');
  writeFileSync(configFile, JSON.stringify({ ownerPreference: true, mcpServers: { own: { command: 'own' } } }));
  writeFileSync(script, 'import c from "node:crypto";process.stdout.write(JSON.stringify({args:process.argv.slice(2),digest:c.createHash("sha256").update(process.env.DEST).digest("hex")}))');
  const args = ['a"b', '%USERNAME%', 'trailing \\'];
  const result = await new ClaudeBackend({ env: {} }).registerMcp(manifest([{ name: 'fixture', type: 'stdio',
    command: process.execPath, args: [script, '${LABEL}', ...args], env: { DEST: '${PRIVATE_KEY}' }, secrets: ['PRIVATE_KEY'] }]),
    { PRIVATE_KEY: credential, LABEL: 'ordinary"value' }, { configFile });
  assert.deepEqual(Array.from(result.registered), ['fixture']);
  const saved = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(saved.ownerPreference, true);
  assert.equal(saved.mcpServers.own.command, 'own');
  const entry = saved.mcpServers.fixture;
  assert.ok(!JSON.stringify(entry.args).includes(credential), 'the actual server argv must not contain its credential');
  const child = spawnSync(entry.command, entry.args, { env: entry.env, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { args: ['ordinary"value', ...args],
    digest: createHash('sha256').update(credential).digest('hex') });
});

test('OpenCode rejects invalid transport input and accounts for a special dictionary key', () => {
  const result = generateOpenCodeMcp(manifest([
    { name: 'empty', type: 'stdio', command: '' },
    { name: 'file', type: 'http', url: 'file:///unwanted' },
    { name: '__proto__', type: 'stdio', command: 'node' },
  ]), {});
  assert.deepEqual(result.skipped, ['empty', 'file']);
  assert.ok(Object.hasOwn(result.mcp, '__proto__'));
  assert.equal(result.mcp.__proto__.command[0], 'node');
});
