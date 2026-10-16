import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isOwnerTelegramMcp, cloudMcpManifest, withoutOwnerTelegramEnvironment } from '../../lib/cloud-mcp-policy.mjs';
import { generateCodexMcp } from '../../core/backends/codex-mcp.mjs';
import { loadCodexEnvironment } from '../../lib/codex-env.mjs';
import { CodexHome } from '../../core/backends/codex-home.mjs';
import { CodexBackend } from '../../core/backends/codex.mjs';
import { provisionCodex, parseProvisionArgs } from '../../tools/provision-codex.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';

const owner = { name: 'owner_alias', type: 'stdio', command: 'node', args: ['owner-marker.mjs'],
  secrets: ['TELEGRAM_SESSION_STRING'], env: { TELEGRAM_SESSION_STRING: '${TELEGRAM_SESSION_STRING}' } };
const normal = { name: 'memory', type: 'stdio', command: 'node', args: ['memory-marker.mjs'] };
const bot = { name: 'telegram_bot', type: 'stdio', command: 'node', secrets: ['TELEGRAM_BOT_TOKEN'],
  env: { TELEGRAM_BOT_TOKEN: '${TELEGRAM_BOT_TOKEN}' } };
const environment = { CODEX_API_KEY: 'fixture-api-key', TELEGRAM_SESSION_STRING: 'fixture-user-session',
  TELEGRAM_API_ID: 'fixture-user-id', TELEGRAM_API_HASH: 'fixture-user-hash', TELEGRAM_BOT_TOKEN: 'fixture-bot-token' };
const manifest = servers => ({ schema_version: 1, servers });
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'cloud-mcp-128-'));
  t.after(() => cleanupTempDir(base));
  const project = join(base, 'project'), user = join(base, 'test-user'), home = join(base, 'owned');
  mkdirSync(project); mkdirSync(user);
  return { base, project, home, user, env: { ...environment, CODEX_HOME: join(user, 'personal-reserved') } };
}

test('owner aliases and direct destination credentials are excluded while bot notifications survive', () => {
  assert.equal(isOwnerTelegramMcp(owner), true);
  assert.equal(isOwnerTelegramMcp({ ...normal, env: { telegram_api_hash: 'fixture-literal' } }), true);
  assert.equal(isOwnerTelegramMcp({ ...normal, args: ['${TELEGRAM_API_ID}'] }), true);
  assert.equal(isOwnerTelegramMcp({ ...normal, command: '/tools/telegram-mcp' }), true);
  assert.equal(isOwnerTelegramMcp({ ...normal, name: 'Telegram' }), true);
  assert.equal(isOwnerTelegramMcp(bot), false);
  assert.equal(isOwnerTelegramMcp(normal), false);
  assert.deepEqual(cloudMcpManifest(manifest([owner, bot, normal])).servers, [bot, normal]);
  assert.equal(cloudMcpManifest(manifest([owner]), false).servers[0], owner);
});

test('clearing process credentials alone is insufficient: the fixture file restores them without cloud mode', t => {
  const f = fixture(t), file = join(f.base, '.env');
  writeFileSync(file, 'TELEGRAM_SESSION_STRING=fixture-file-session\nTELEGRAM_API_ID=fixture-file-id\nTELEGRAM_API_HASH=fixture-file-hash\nCODEX_API_KEY=fixture-file-api\n');
  const names = ['TELEGRAM_SESSION_STRING', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'CODEX_API_KEY'];
  const plain = loadCodexEnvironment([file], {}, names);
  assert.equal(plain.TELEGRAM_SESSION_STRING, 'fixture-file-session');
  const cloud = loadCodexEnvironment([file], { FRAMEWORK_CLOUD_MODE: '1', telegram_api_hash: 'fixture-exported-hash' }, names);
  assert.equal(cloud.CODEX_API_KEY, 'fixture-file-api');
  for (const key of [...names.slice(0, 3), 'telegram_api_hash']) assert.equal(cloud[key], undefined);
  assert.equal(withoutOwnerTelegramEnvironment(environment).TELEGRAM_BOT_TOKEN, 'fixture-bot-token');
});

test('Codex cloud compilation rejects before credential lookup and never serializes the owner registration', () => {
  const source = manifest([owner, bot, normal]);
  const plain = generateCodexMcp(source, environment);
  assert.deepEqual(plain.registered, ['owner_alias', 'telegram_bot', 'memory']);
  const cloud = generateCodexMcp(source, { ...environment, FRAMEWORK_CLOUD_MODE: '1' });
  assert.deepEqual(cloud.registered, ['telegram_bot', 'memory']);
  assert.deepEqual(cloud.skipped, ['owner_alias']);
  assert.match(cloud.reasons.owner_alias, /cloud mode/);
  assert.ok(!cloud.override.includes('owner_alias'));
  assert.ok(!JSON.stringify(cloud).includes(environment.TELEGRAM_SESSION_STRING));
  const absent = generateCodexMcp(manifest([owner]), { FRAMEWORK_CLOUD_MODE: '1' });
  assert.match(absent.reasons.owner_alias, /cloud mode/);
  assert.doesNotMatch(absent.reasons.owner_alias, /secrets missing/);
});

test('cloud conversion removes the old alias even when the new manifest contains only another server', t => {
  const f = fixture(t);
  const initial = new CodexHome({ env: f.env, homeDir: f.home, userHome: f.user });
  initial.registerMcp(manifest([owner, normal]), f.env, { cwd: f.project });
  assert.match(readFileSync(join(f.home, 'framework-mcp.json'), 'utf8'), /owner_alias/);
  const cloud = new CodexHome({ env: { ...f.env, FRAMEWORK_CLOUD_MODE: '1' }, homeDir: f.home, userHome: f.user });
  cloud.registerMcp(manifest([normal]), { ...f.env, FRAMEWORK_CLOUD_MODE: '1' }, { cwd: f.project });
  const registry = JSON.parse(readFileSync(join(f.home, 'framework-mcp.json'), 'utf8'));
  assert.equal(registry.cloud_mode, true);
  assert.deepEqual(registry.servers.map(server => server.name), ['memory']);
  assert.doesNotMatch(readFileSync(join(f.home, 'config.toml'), 'utf8'), /owner_alias/);
  const restored = new CodexHome({ env: f.env, homeDir: f.home, userHome: f.user });
  const next = restored.prepareExecution({ cwd: f.project, apiKey: f.env.CODEX_API_KEY, mcpEnv: f.env });
  assert.equal(next.cloudMode, true, 'the managed marker survives a fresh process without the environment flag');
  assert.deepEqual(next.mcp.registered, ['memory']);
  assert.equal(next.executionEnv, undefined, 'public preparation results never contain the credential environment');
  assert.ok(!restored.environmentNames({ cwd: f.project }).includes('TELEGRAM_SESSION_STRING'));
  restored.registerMcp(manifest([owner]), f.env, { cwd: f.project });
  assert.doesNotMatch(readFileSync(join(f.home, 'framework-mcp.json'), 'utf8'), /owner_alias/);
});

test('Codex cloud provision does not reload owner credentials from config/.env', async t => {
  const f = fixture(t), root = join(f.base, 'framework');
  mkdirSync(join(root, 'config'), { recursive: true });
  const manifestPath = join(root, 'config', 'mcp-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest([owner, normal])));
  writeFileSync(join(root, 'config', '.env'), 'TELEGRAM_SESSION_STRING=fixture-owner-in-file\n');
  const plainEnv = { CODEX_HOME: f.env.CODEX_HOME, CODEX_API_KEY: f.env.CODEX_API_KEY };
  assert.equal(parseProvisionArgs(['--cloud']).cloudMode, true);
  const result = await provisionCodex({ root, targetDir: f.project, manifestPath, content: 'Fixture instructions.',
    homeDir: f.home, env: plainEnv, cloudMode: true });
  assert.deepEqual(result.registered, ['memory']);
  assert.deepEqual(result.skipped, ['owner_alias']);
  assert.match(result.reasons.owner_alias, /cloud mode/);
  assert.doesNotMatch(readFileSync(join(f.home, 'framework-mcp.json'), 'utf8'), /owner_alias|fixture-owner-in-file/);
});

test('restored cloud mode removes owner environment before the fake CLI process is launched', async t => {
  const f = fixture(t);
  new CodexHome({ env: { ...f.env, FRAMEWORK_CLOUD_MODE: '1' }, homeDir: f.home, userHome: f.user })
    .registerMcp(manifest([normal]), { ...f.env, FRAMEWORK_CLOUD_MODE: '1' }, { cwd: f.project });
  let launches = 0;
  const backend = new CodexBackend({ env: f.env, homeDir: f.home, command: { bin: 'test-only-no-cli', args: [] },
    launch: async (_bin, args, options) => {
      launches++;
      assert.equal(options.env.TELEGRAM_SESSION_STRING, undefined);
      assert.equal(options.env.TELEGRAM_API_ID, undefined);
      assert.equal(options.env.TELEGRAM_API_HASH, undefined);
      assert.equal(options.env.TELEGRAM_BOT_TOKEN, 'fixture-bot-token');
      assert.ok(args.every(argument => !argument.includes('owner_alias')));
      return { cleanupRefused: true, stdout: '', stderr: 'fixture cleanup boundary' };
    } });
  const result = await backend.runTurn({ cwd: f.project, prompt: 'Fixture prompt.' });
  assert.equal(launches, 1);
  assert.equal(result.cleanupRefused, true);
});

test('sticky cloud provision identifies excluded variables before parsing a malformed owner credential', async t => {
  const f = fixture(t), root = join(f.base, 'framework');
  mkdirSync(join(root, 'config'), { recursive: true });
  const manifestPath = join(root, 'config', 'mcp-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest([owner])));
  writeFileSync(join(root, 'config', '.env'), 'TELEGRAM_SESSION_STRING="fixture-unclosed\n');
  const baseEnv = { CODEX_HOME: f.env.CODEX_HOME, CODEX_API_KEY: f.env.CODEX_API_KEY };
  new CodexHome({ env: { ...baseEnv, FRAMEWORK_CLOUD_MODE: '1' }, homeDir: f.home, userHome: f.user })
    .registerMcp(manifest([normal]), { ...baseEnv, FRAMEWORK_CLOUD_MODE: '1' }, { cwd: f.project });
  const registryBefore = readFileSync(join(f.home, 'framework-mcp.json'), 'utf8');
  const opts = { root, targetDir: f.project, manifestPath, content: 'Fixture instructions.', homeDir: f.home, env: baseEnv };
  const preview = await provisionCodex({ ...opts, dryRun: true });
  assert.equal(preview.cloudMode, true);
  assert.deepEqual(preview.skipped, ['owner_alias']);
  assert.match(preview.reasons.owner_alias, /cloud mode/);
  assert.equal(readFileSync(join(f.home, 'framework-mcp.json'), 'utf8'), registryBefore);
  const installed = await provisionCodex(opts);
  assert.equal(installed.cloudMode, true);
  assert.deepEqual(installed.skipped, ['owner_alias']);
  assert.doesNotMatch(readFileSync(join(f.home, 'framework-mcp.json'), 'utf8'), /owner_alias/);
  const ordinaryHome = join(f.base, 'ordinary-owned');
  await assert.rejects(provisionCodex({ ...opts, homeDir: ordinaryHome, dryRun: true }), /Invalid quoted Codex environment variable/);
});
