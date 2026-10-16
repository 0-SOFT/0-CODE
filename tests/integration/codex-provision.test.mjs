import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexBackend, CODEX_INSTRUCTIONS_MAX_BYTES } from '../../core/backends/codex.mjs';
import { getBackend } from '../../core/backend-factory.mjs';
import { provisionCodex, parseProvisionArgs } from '../../tools/provision-codex.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';

const scratch = process.env.FRAMEWORK_TEST_TMPDIR || tmpdir();
const stream = readFileSync(new URL('../fixtures/codex/0.160.1-ok.jsonl', import.meta.url), 'utf8');
function fixture(t) {
  mkdirSync(scratch, { recursive: true });
  const root = realpathSync.native(mkdtempSync(join(scratch, 'codex-provision-test-')));
  t.after(() => cleanupTempDir(root));
  const targetDir = join(root, 'project'), personal = join(root, 'personal'), config = join(root, 'config'), homeDir = join(root, 'owned');
  for (const path of [targetDir, personal, config]) mkdirSync(path);
  writeFileSync(join(targetDir, 'CLAUDE.md'), '# Target project instructions\n');
  writeFileSync(join(personal, 'config.toml'), 'personal-marker');
  writeFileSync(join(personal, 'auth.json'), 'fixture-login');
  const manifest = { schema_version: 1, servers: [{ name: 'local', type: 'stdio', command: 'node', args: ['echo.js'],
    env: { API_KEY: '${TOKEN}' }, secrets: ['TOKEN'] }] };
  writeFileSync(join(config, 'mcp-manifest.example.json'), JSON.stringify(manifest));
  writeFileSync(join(config, '.env'), 'TOKEN=fixture-mcp-token\nCODEX_API_KEY=fixture-api-key\nNODE_OPTIONS=host-control-fixture\n');
  return { root, targetDir, personal, homeDir, env: { CODEX_HOME: personal }, manifest };
}

test('provision uses target instructions and credential references; a fresh backend reloads env at execution', async t => {
  const f = fixture(t);
  const result = await provisionCodex(f);
  assert.deepEqual(result.registered, ['local']);
  assert.match(readFileSync(join(f.targetDir, 'AGENTS.md'), 'utf8'), /<!-- BEGIN AUTONOMOUS FRAMEWORK -->\n# Target project instructions\n/);
  assert.equal(existsSync(join(f.homeDir, 'auth.json')), false, 'the API key does not import the saved login');
  for (const name of ['config.toml', 'framework-mcp.json']) {
    const text = readFileSync(join(f.homeDir, name), 'utf8');
    assert.ok(!text.includes('fixture-mcp-token')); assert.ok(!text.includes('fixture-api-key'));
  }
  let launched;
  const backend = new CodexBackend({ env: f.env, homeDir: f.homeDir,
    envFiles: [join(f.root, 'config', '.env'), join(f.root, '.env')], command: { bin: 'fixture', args: [] },
    inspect: (_bin, args, options) => {
      assert.deepEqual(args, ['--version']); assert.equal(options.env.CODEX_API_KEY, 'fixture-api-key');
      return { status: 0, stdout: 'codex-cli 0.162.0' };
    },
    launch: async (_bin, args, options) => { launched = { args, env: options.env }; return { status: 0, stdout: stream }; } });
  assert.equal((await backend.checkEngine({ cwd: f.targetDir })).auth, 'api-key');
  assert.equal((await backend.runTurn({ cwd: f.targetDir, prompt: 'fixture turn' })).ok, true);
  assert.equal(launched.env.TOKEN, 'fixture-mcp-token'); assert.equal(launched.env.CODEX_HOME, f.homeDir);
  assert.equal(launched.env.NODE_OPTIONS, undefined); assert.ok(!JSON.stringify(launched.args).includes('fixture-mcp-token'));
  assert.deepEqual(f.env, { CODEX_HOME: f.personal });
  assert.deepEqual((await backend.ensureReady({ cwd: f.targetDir })).mcp.registered, ['local']);
  unlinkSync(join(f.root, 'config', '.env'));
  const missing = await backend.ensureReady({ cwd: f.targetDir });
  assert.deepEqual(missing.mcp.registered, []); assert.match(missing.mcp.reasons.local, /secrets missing/);
  assert.equal(readFileSync(join(f.personal, 'config.toml'), 'utf8'), 'personal-marker');
  assert.equal(readFileSync(join(f.personal, 'auth.json'), 'utf8'), 'fixture-login');
});

test('dry-run leaves project, external home and login untouched and accepts an absent target', async t => {
  const f = fixture(t);
  const before = readdirSync(f.targetDir);
  const result = await provisionCodex({ ...f, dryRun: true });
  assert.deepEqual(result.registered, ['local']); assert.equal(existsSync(f.homeDir), false);
  assert.deepEqual(readdirSync(f.targetDir), before);
  const targetDir = join(f.root, 'not-created');
  const absent = await provisionCodex({ ...f, targetDir, content: '# Preview instructions', dryRun: true });
  assert.equal(absent.dryRun, true); assert.equal(existsSync(targetDir), false); assert.equal(existsSync(f.homeDir), false);
  assert.equal(readFileSync(join(f.personal, 'auth.json'), 'utf8'), 'fixture-login');
});

test('oversized instructions, malformed manifest and missing instructions refuse before installing files', async t => {
  const f = fixture(t);
  await assert.rejects(provisionCodex({ ...f, env: { ...f.env, CODEX_INSTRUCTIONS_MAX_BYTES: '32768' },
    content: 'x'.repeat(CODEX_INSTRUCTIONS_MAX_BYTES + 1) }), /configured limit/);
  assert.equal(existsSync(f.homeDir), false); assert.equal(existsSync(join(f.targetDir, 'AGENTS.md')), false);
  await assert.rejects(provisionCodex({ ...f, instructionsPath: join(f.root, 'absent') }), /Project instructions are missing/);
  writeFileSync(join(f.root, 'config', 'mcp-manifest.example.json'), '{');
  await assert.rejects(provisionCodex(f), /Could not read/);
  writeFileSync(join(f.root, 'config', 'mcp-manifest.example.json'), JSON.stringify({ schema_version: 1, servers: {} }));
  await assert.rejects(provisionCodex(f), /manifest|iterable/i);
  assert.equal(existsSync(f.homeDir), false);
});

test('independent owned login is preserved and installation never copies personal login', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'config', '.env'), 'TOKEN=fixture-mcp-token');
  await provisionCodex(f);
  assert.equal(existsSync(join(f.homeDir, 'auth.json')), false);
  writeFileSync(join(f.homeDir, 'auth.json'), 'independent-login');
  writeFileSync(join(f.personal, 'auth.json'), 'changed-personal-login');
  await provisionCodex(f);
  assert.equal(readFileSync(join(f.homeDir, 'auth.json'), 'utf8'), 'independent-login');
});

test('foreign managed home refuses before writing project instructions', async t => {
  const f = fixture(t);
  mkdirSync(f.homeDir); writeFileSync(join(f.homeDir, 'framework-owner.json'), '{}');
  await assert.rejects(provisionCodex(f), /different project|owner marker/);
  assert.equal(existsSync(join(f.targetDir, 'AGENTS.md')), false);
  assert.deepEqual(readdirSync(f.homeDir), ['framework-owner.json']);
});

test('unreadable or invalid selected environment blocks execution while the dollar guard runs first', async t => {
  const f = fixture(t);
  let calls = 0;
  const file = join(f.root, 'config', '.env');
  const backend = new CodexBackend({ env: f.env, homeDir: f.homeDir, envFiles: [file],
    command: { bin: 'fixture', args: [] }, inspect: () => { calls++; }, launch: async () => { calls++; } });
  writeFileSync(file, 'CODEX_API_KEY="secret-fixture');
  const refused = await backend.runTurn({ cwd: f.targetDir, prompt: 'fixture turn' });
  assert.equal(refused.ok, false); assert.match(refused.error, /Invalid quoted/);
  assert.ok(!refused.error.includes('secret-fixture')); assert.equal(calls, 0); assert.equal(existsSync(f.homeDir), false);
  assert.equal((await backend.checkEngine({ cwd: f.targetDir })).protectionFailed, true);
  const budget = await backend.runTurn({ cwd: f.targetDir, prompt: 'fixture turn', maxBudgetUsd: 1 });
  assert.equal(budget.unsupportedBudget, true); assert.equal(calls, 0);
});

test('factory supplies env files only to Codex and argument parsing rejects typos and missing values', () => {
  const backend = getBackend('codex', { env: {}, envFiles: ['config.env'] });
  assert.deepEqual(backend.envFiles, ['config.env']);
  assert.equal(getBackend('claude', { env: {}, envFiles: ['config.env'] }).id, 'claude');
  assert.deepEqual(parseProvisionArgs(['--target', 'project', '--home', 'owned', '--instructions', 'CLAUDE.md', '--manifest', 'mcp.json', '--dry-run']),
    { targetDir: 'project', homeDir: 'owned', instructionsPath: 'CLAUDE.md', manifestPath: 'mcp.json', dryRun: true });
  for (const args of [['--target'], ['--target', '--dry-run'], ['--dr-run']]) assert.throws(() => parseProvisionArgs(args), /missing value/);
});
