import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { CodexBackend } from '../../core/backends/codex.mjs';
import { generateCodexMcp } from '../../core/backends/codex-mcp.mjs';
import { launchMcp } from '../../core/backends/codex-mcp-launch.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
import { writeNpmNodeShim } from '../helpers/npm-shim.mjs';

const scratch = process.env.FRAMEWORK_TEST_TMPDIR || tmpdir();
function fixture(t, env = {}) {
  mkdirSync(scratch, { recursive: true });
  const base = mkdtempSync(join(scratch, 'codex-mcp-test-'));
  t.after(() => cleanupTempDir(base));
  const project = join(base, 'project'), personal = join(base, 'personal'), home = join(base, 'owned');
  mkdirSync(project); mkdirSync(personal);
  const options = { homeDir: home, env: { ...env, CODEX_HOME: personal } };
  return { base, project, personal, home, options, backend: new CodexBackend(options) };
}
const manifest = servers => ({ schema_version: 1, servers });
const local = { name: 'local', type: 'stdio', command: 'node', args: ['echo.js'],
  env: { API_KEY: '${TOKEN}' }, secrets: ['TOKEN'] };

test('registration rejects secret aliases and literals while a reference reaches the real server', async t => {
  const secret = 'fixture-private-alias-value';
  const f = fixture(t, { TOKEN: secret, PUBLIC: secret });
  const server = join(f.project, 'server.cjs');
  writeFileSync(server, 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.env.DEST).digest("hex"))');
  const bad = [
    { name: 'alias', type: 'stdio', command: process.execPath, args: ['${PUBLIC}'], secrets: ['TOKEN'] },
    { name: 'literal', type: 'stdio', command: process.execPath, env: { VALUE: secret }, secrets: ['TOKEN'] },
    { name: 'fallback', type: 'stdio', command: process.execPath, env: { VALUE: '${ABSENT:-' + secret + '}' }, secrets: ['TOKEN'] },
  ];
  const good = { name: 'valid', type: 'stdio', command: process.execPath, args: [server],
    env: { DEST: '${PUBLIC}' }, secrets: ['TOKEN'] };
  const ready = await f.backend.registerMcp(manifest([...bad, good]), f.options.env, { targetDir: f.project });
  assert.deepEqual(ready.registered, ['valid']);
  assert.deepEqual(ready.skipped, bad.map(s => s.name));
  for (const file of [ready.configFile, join(ready.home, 'framework-mcp.json')]) {
    assert.ok(!readFileSync(file, 'utf8').includes(secret));
  }
  const generated = generateCodexMcp(manifest([good]), f.options.env, { launcherFile: ready.launcherFile });
  const entry = generated.mcp.valid;
  assert.ok(!JSON.stringify(entry).includes(secret));
  const actual = spawnSync(entry.command, entry.args, { env: f.options.env, cwd: f.project, encoding: 'utf8', windowsHide: true });
  assert.equal(actual.status, 0, actual.stderr);
  assert.equal(actual.stdout, createHash('sha256').update(secret).digest('hex'));
});

test('registration survives a new backend and restores its captured files without serializing secrets', async t => {
  const f = fixture(t);
  const credential = 'fixture-mcp-credential';
  const r = await f.backend.registerMcp(manifest([local]), { TOKEN: credential }, { targetDir: f.project });
  assert.deepEqual(r.registered, ['local']);
  const stateFile = join(f.home, 'framework-mcp.json');
  const managedFiles = [r.configFile, stateFile, r.launcherFile, join(f.home, 'guard', 'backends', 'cli-launch.mjs')];
  const original = managedFiles.map(file => readFileSync(file, 'utf8'));
  for (const text of original) assert.ok(!text.includes(credential));
  assert.equal(existsSync(join(f.personal, 'config.toml')), false);
  const next = new CodexBackend({ ...f.options, env: { ...f.options.env, TOKEN: credential } });
  const ready = await next.ensureReady({ cwd: f.project });
  assert.deepEqual(ready.mcp.registered, ['local']);
  for (const file of managedFiles) writeFileSync(file, 'damaged');
  const restored = await next.ensureReady({ cwd: f.project });
  assert.equal(restored.mcp.registered.length, 1);
  assert.deepEqual(managedFiles.map(file => readFileSync(file, 'utf8')), original);
  const missing = await next.ensureReady({ cwd: f.project, env: f.options.env });
  assert.deepEqual(missing.mcp.registered, []);
  assert.match(missing.mcp.reasons.local, /secrets missing/);
  assert.doesNotMatch(readFileSync(r.configFile, 'utf8'), /mcp_servers\./);
  const returned = await next.ensureReady({ cwd: f.project });
  assert.deepEqual(returned.mcp.registered, ['local']);
  assert.deepEqual((await f.backend.ensureReady({ cwd: f.project })).mcp.registered, ['local'],
    'the registration environment remains available to this backend instance');
  assert.deepEqual((await f.backend.applyPermissions({ targetDir: f.project })).mcp.registered, ['local']);
});

test('reprovision removes skipped manifest entries and preserves registrations absent from it', async t => {
  const f = fixture(t, { TOKEN: 'fixture-token' });
  const kept = { name: 'kept', type: 'http', url: 'http://127.0.0.1:1234/mcp' };
  await f.backend.registerMcp(manifest([local, kept]), f.options.env, { targetDir: f.project });
  const result = await f.backend.registerMcp(manifest([local]), {}, { targetDir: f.project });
  assert.deepEqual(result.skipped, ['local']);
  const persisted = JSON.parse(readFileSync(join(f.home, 'framework-mcp.json'), 'utf8'));
  assert.deepEqual(persisted.servers.map(s => s.name), ['kept']);
  assert.deepEqual(result.mcp.registered, ['kept']);
});

test('MCP dry-run neither imports login, creates files nor changes the active registration', async t => {
  const f = fixture(t, { TOKEN: 'fixture-token' });
  writeFileSync(join(f.personal, 'auth.json'), '{"fixture":"not-a-real-login"}');
  const before = readdirSync(f.base).sort();
  const result = await f.backend.registerMcp(manifest([local]), f.options.env,
    { targetDir: f.project, dryRun: true });
  assert.deepEqual(result.registered, ['local']);
  assert.deepEqual(readdirSync(f.base).sort(), before);
  assert.equal(existsSync(f.home), false);
  await f.backend.registerMcp(manifest([]), f.options.env, { targetDir: f.project, importAuth: false });
  const file = join(f.home, 'framework-mcp.json'), original = readFileSync(file, 'utf8');
  await f.backend.registerMcp(manifest([local]), f.options.env, { targetDir: f.project, dryRun: true });
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.deepEqual((await f.backend.ensureReady({ cwd: f.project, importAuth: false })).mcp.registered, []);
});

test('damaged registration and a foreign owner fail before any CLI call', async t => {
  const f = fixture(t, { TOKEN: 'fixture-token' });
  await f.backend.registerMcp(manifest([local]), f.options.env, { targetDir: f.project });
  writeFileSync(join(f.home, 'framework-mcp.json'), 'invalid JSON');
  let calls = 0;
  const next = new CodexBackend({ ...f.options, inspect() { calls++; }, launch() { calls++; } });
  const result = await next.checkEngine({ cwd: f.project });
  assert.equal(result.protectionFailed, true);
  assert.equal(calls, 0);
  writeFileSync(join(f.home, 'framework-owner.json'), '{}');
  await assert.rejects(next.registerMcp(manifest([]), f.options.env, { targetDir: f.project }), /owner marker/);
});

test('real managed launchers deliver distinct remapped credentials and refuse a missing one', async t => {
  const f = fixture(t, { FIRST: 'fixture-first-credential', SECOND: 'fixture-second-credential' });
  const args = ['-e', 'console.log(require("node:crypto").createHash("sha256").update(process.env.API_KEY).digest("hex"))'];
  const servers = ['FIRST', 'SECOND'].map(source => ({ name: source.toLowerCase(), type: 'stdio',
    command: process.execPath, args, env: { API_KEY: `\${${source}}` }, secrets: [source] }));
  const ready = await f.backend.registerMcp(manifest(servers), f.options.env, { targetDir: f.project });
  const gen = generateCodexMcp(manifest(servers), f.options.env, { launcherFile: ready.launcherFile });
  for (const [name, entry] of Object.entries(gen.mcp)) {
    const actual = spawnSync(entry.command, entry.args, { env: f.options.env, cwd: f.project, encoding: 'utf8', windowsHide: true });
    assert.equal(actual.status, 0, actual.stderr);
    assert.equal(actual.stdout.trim(), createHash('sha256').update(f.options.env[name.toUpperCase()]).digest('hex'));
    assert.ok(!entry.args.join(' ').includes(f.options.env[name.toUpperCase()]));
  }
  const entry = gen.mcp.first;
  const missing = spawnSync(entry.command, entry.args, { env: { FIRST: '' }, cwd: f.project, encoding: 'utf8', windowsHide: true });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /environment is invalid/);
});

test('Windows managed MCP launcher starts a standard npm shim with remapped environment and intact argv',
  { skip: process.platform !== 'win32' }, async t => {
    const f = fixture(t, { FIXTURE_KEY: 'fixture-windows-credential' });
    mkdirSync(join(f.project, 'node_modules', 'fixture'), { recursive: true });
    const marker = join(f.project, 'mcp-proof.json');
    writeFileSync(join(f.project, 'node_modules', 'fixture', 'cli.mjs'),
      'import fs from "node:fs"; import crypto from "node:crypto"; fs.writeFileSync(process.argv[2],JSON.stringify({args:process.argv.slice(3),digest:crypto.createHash("sha256").update(process.env.DEST).digest("hex")}))');
    const shim = join(f.project, 'fixture.cmd');
    writeNpmNodeShim(shim);
    const values = ['quote" & echo AUDIT129_INJECTED & rem "', '%USERNAME%', 'space \\', ''];
    const spec = { name: 'windows', type: 'stdio', command: shim, args: [marker, ...values],
      env: { DEST: '${FIXTURE_KEY}' }, secrets: ['FIXTURE_KEY'] };
    const ready = await f.backend.registerMcp(manifest([spec]), f.options.env, { targetDir: f.project });
    const entry = generateCodexMcp(manifest([spec]), f.options.env, { launcherFile: ready.launcherFile }).mcp.windows;
    const result = spawnSync(entry.command, entry.args, { env: f.options.env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '', 'no extra command ran');
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { args: values,
      digest: createHash('sha256').update(f.options.env.FIXTURE_KEY).digest('hex') });
  });

test('launcher completion and spawn errors detach the signal handlers', async t => {
  const f = fixture(t);
  const before = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => process.listenerCount(signal));
  const oldExitCode = process.exitCode;
  try {
    const marker = join(f.project, 'child-proof.txt');
    const child = launchMcp({ command: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"done")', marker], refs: {}, required: [] });
    await once(child, 'exit');
    assert.equal(readFileSync(marker, 'utf8'), 'done');
    assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => process.listenerCount(signal)), before);
    const broken = launchMcp({ command: 'nonexistent-codex-mcp-fixture-command', args: [], refs: {}, required: [] });
    await once(broken, 'error');
    assert.equal(process.exitCode, 1);
    assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => process.listenerCount(signal)), before);
  } finally { process.exitCode = oldExitCode; }
});
