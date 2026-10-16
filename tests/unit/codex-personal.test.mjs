import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexBackend, validateCodexInstructions, assessCodexVersion } from '../../core/backends/codex.mjs';
import { buildCodexConfiguration, validateCodexRuntimeOptions } from '../../core/backends/codex-config.mjs';
import { cloudCodexMcpOverrides } from '../../core/backends/codex-mcp.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';

function fixture(t) {
  const root = process.env.FRAMEWORK_TEST_TMPDIR || tmpdir(); mkdirSync(root, { recursive: true });
  const base = mkdtempSync(join(root, 'codex-personal-'));
  t.after(() => cleanupTempDir(base));
  const project = join(base, 'project'), personal = join(base, 'personal'), stateDir = join(base, 'guard-state');
  mkdirSync(project); mkdirSync(personal);
  writeFileSync(join(personal, 'config.toml'), 'model="owner-model"\nmodel_reasoning_effort="xhigh"\nservice_tier="fast"\n');
  // A synthetic file, never an owner's login.
  writeFileSync(join(personal, 'auth.json'), 'SYNTHETIC AUTH SENTINEL\n');
  return { project, personal, stateDir, env: { CODEX_HOME: personal } };
}

test('default preparation uses personal execution home and preserves every personal file', async t => {
  const f = fixture(t), before = new Map(readdirSync(f.personal).map(name => [name, readFileSync(join(f.personal, name))]));
  const backend = new CodexBackend(f), first = await backend.ensureReady({ cwd: f.project });
  assert.equal(first.mode, 'personal'); assert.equal(first.executionHome, f.personal); assert.equal(first.auth, 'personal');
  assert.notEqual(first.home, first.executionHome);
  assert.equal(existsSync(first.configFile), false); assert.equal(existsSync(first.instructionsFile), false);
  assert.match(first.overrides.join('\n'), /hooks\.PreToolUse=.*codex-hook/);
  assert.doesNotMatch(first.overrides.join('\n'), /permissions\.framework|windows\.sandbox|trust_level|approval_policy|model_reasoning_effort|(?:^|\n)model=/);
  assert.deepEqual((await backend.ensureReady({ cwd: f.project })).restored, []);
  assert.deepEqual(readdirSync(f.personal), [...before.keys()]);
  for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(f.personal, name)), bytes);
});

test('managed account is explicit and allow-all leaves framework hooks disabled idempotently', async t => {
  const f = fixture(t);
  const backend = new CodexBackend({ ...f, env: { ...f.env, CODEX_HOME_MODE: 'managed', SAFETY_GUARD_MODE: 'allow-all' } });
  const first = await backend.ensureReady({ cwd: f.project });
  assert.equal(first.mode, 'managed'); assert.equal(first.executionHome, first.home);
  assert.ok(existsSync(first.configFile));
  assert.doesNotMatch(first.overrides.join('\n'), /features\.|hooks\./);
  assert.deepEqual(JSON.parse(readFileSync(first.hooksFile, 'utf8')), { hooks: {} });
  assert.deepEqual((await backend.ensureReady({ cwd: f.project })).restored, []);
  assert.equal(readFileSync(join(f.personal, 'auth.json'), 'utf8'), 'SYNTHETIC AUTH SENTINEL\n');
});

test('personal and project instructions above 32 KiB receive a sufficient native budget', async t => {
  const f = fixture(t), personal = '\u041b\u0438\u0447\u043d\u044b\u0435 \u043f\u0440\u0430\u0432\u0438\u043b\u0430\n'.repeat(1000),
    project = '\u041f\u0440\u0430\u0432\u0438\u043b\u0430 \u043f\u0440\u043e\u0435\u043a\u0442\u0430\n'.repeat(2000);
  writeFileSync(join(f.personal, 'AGENTS.md'), personal); writeFileSync(join(f.project, 'AGENTS.md'), project);
  const ready = await new CodexBackend(f).ensureReady({ cwd: f.project });
  const bytes = Buffer.byteLength(personal) + Buffer.byteLength(project);
  assert.equal(ready.instructions.totalBytes, bytes);
  assert.ok(Number(ready.overrides.find(value => value.startsWith('project_doc_max_bytes=')).split('=')[1]) >= bytes);
  assert.throws(() => validateCodexInstructions(f.project, { personalHome: f.personal, maxBytes: bytes - 1 }), /configured limit/);
  const strict = new CodexBackend({ ...f, env: { ...f.env, CODEX_INSTRUCTIONS_MAX_BYTES: '32768' } });
  await assert.rejects(strict.ensureReady({ cwd: f.project }), /configured limit/);
});

test('sandbox-only configuration gives read-only roots read access and never forces full-access trust', t => {
  const f = fixture(t);
  const full = buildCodexConfiguration({ project: f.project, platform: 'win32', env: {} });
  assert.doesNotMatch(full.content, /permissions\.framework|windows\.sandbox|trust_level/);
  const readonly = buildCodexConfiguration({ project: f.project, sandbox: 'read-only', platform: 'win32', env: {} });
  assert.match(readonly.content, /":workspace_roots"=\{"\."="read"\}/);
  assert.match(readonly.content, /(?:^|[,{])"?trust_level"?="untrusted"/);
});

test('generic -c options retain owner controls while quoted guard replacements are rejected', () => {
  for (const key of ['"hooks".PreToolUse', 'features."hooks"', 'execpolicy.path', 'rules']) {
    assert.throws(() => validateCodexRuntimeOptions({ config: [`${key}=false`] }), /cannot replace/);
  }
  const config = ['service_tier="fast"', 'model="owner"', 'features.experimental_feature=true', 'approval_policy="on-request"'];
  assert.deepEqual(validateCodexRuntimeOptions({ config }), config);
  assert.deepEqual(validateCodexRuntimeOptions({ config: ['hooks.PreToolUse=[]'], bypassHookTrust: false, guardEnabled: false }), ['hooks.PreToolUse=[]']);
});

test('cloud policy disables only owner Telegram in an effective personal MCP list', () => {
  const servers = [
    { name: 'memory', transport: { type: 'stdio', command: 'memory.exe', env_vars: [] } },
    { name: 'owner-session', transport: { type: 'stdio', command: 'owner.exe', env_vars: ['TELEGRAM_SESSION_STRING'] } },
    { name: 'telegram-bot', transport: { type: 'stdio', command: 'notify.exe', env_vars: ['TELEGRAM_BOT_TOKEN'] } },
    { name: 'github', transport: { type: 'http', url: 'https://example.test', bearer_token_env_var: 'GITHUB_TOKEN' } },
  ];
  assert.deepEqual(cloudCodexMcpOverrides(JSON.stringify(servers)), ['mcp_servers.owner-session.enabled=false']);
  assert.throws(() => cloudCodexMcpOverrides('not JSON'), /Could not inspect/);
  assert.throws(() => cloudCodexMcpOverrides('{}'), /Could not inspect/);
});

test('an older engine warns by default and fails only in explicitly strict mode', () => {
  const loose = assessCodexVersion('codex-cli 0.161.0');
  assert.equal(loose.ok, true); assert.match(loose.notes.join(' '), /differs from verified/);
  assert.equal(assessCodexVersion('codex-cli 0.161.0', { strict: true }).ok, false);
});
