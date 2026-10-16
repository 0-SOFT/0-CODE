import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEngineSettings, parseDuration, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS } from '../../core/engine-settings.mjs';
import { buildClaudeArgs } from '../../core/backends/claude.mjs';
import { buildOpenCodeArgs } from '../../core/backends/opencode.mjs';
import { loadEngineSettingsEnvironment, mcpEnvironmentNames } from '../../lib/codex-env.mjs';
import { parseArgs } from '../../core/supervisor.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';

test('all engines retain their own model and effort with the same operational defaults', () => {
  for (const id of ['claude', 'codex', 'opencode']) {
    const result = resolveEngineSettings(id, {}, {});
    assert.equal(result.model, undefined);
    assert.equal(result.effort, undefined);
    assert.equal(result.idleTimeoutMs, 99 * 60000);
    assert.equal(result.timeoutMs, 9999 * 3600000);
    assert.equal(result.networkRetries, Infinity);
  }
  assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 99 * 60000);
  assert.equal(DEFAULT_TURN_TIMEOUT_MS, 9999 * 3600000);
  const codex = resolveEngineSettings('codex', {}, {});
  assert.equal(codex.sandbox, 'danger-full-access');
  assert.equal(codex.homeMode, 'personal');
  assert.equal(codex.instructionsMaxBytes, undefined);
});

test('network retries use the common priority, explicit zero stops and malformed settings refuse', () => {
  for (const id of ['claude', 'codex', 'opencode']) {
    assert.equal(resolveEngineSettings(id, {}, { AGENT_NETWORK_RETRIES: '7' }).networkRetries, 7);
    assert.equal(resolveEngineSettings(id, { networkRetries: 0 }, { AGENT_NETWORK_RETRIES: '7' }).networkRetries, 0);
    for (const value of ['-1', '1.5', 'Infinity', 'bad']) assert.throws(() => resolveEngineSettings(id, {}, { AGENT_NETWORK_RETRIES: value }));
  }
  assert.equal(parseArgs(['--network-retries', '0']).networkRetries, 0);
  assert.equal(parseArgs(['--network-retries', '7']).networkRetries, 7);
  for (const value of ['-1', '1.5', 'Infinity', 'bad']) assert.ok(parseArgs(['--network-retries', value]).error);
  assert.ok(parseArgs(['--network-retries']).error);
});

test('explicit parameters beat environment and zero is an intentional timeout setting', () => {
  const variables = { claude: ['CLAUDE_MODEL', 'CLAUDE_EFFORT'], codex: ['CODEX_MODEL', 'CODEX_REASONING_EFFORT'],
    opencode: ['OPENCODE_MODEL', 'OPENCODE_VARIANT'] };
  for (const [id, [modelKey, effortKey]] of Object.entries(variables)) {
    const env = { [modelKey]: 'personal-model', [effortKey]: 'xhigh', AGENT_IDLE_TIMEOUT_MS: '12', AGENT_TURN_TIMEOUT_MS: '24' };
    const fromEnv = resolveEngineSettings(id, {}, env);
    assert.equal(fromEnv.model, 'personal-model'); assert.equal(fromEnv.effort, 'xhigh');
    const chosen = resolveEngineSettings(id, { model: 'chosen', effort: 'high', timeoutMs: 0, idleTimeoutMs: 0 }, env);
    assert.equal(chosen.model, 'chosen'); assert.equal(chosen.effort, 'high');
    assert.equal(chosen.timeoutMs, 0); assert.equal(chosen.idleTimeoutMs, 0);
  }
});

test('Claude and OpenCode arguments omit unset flags and transmit selected engine options', () => {
  const claude = buildClaudeArgs({ prompt: 'work' }, {}), open = buildOpenCodeArgs({}, {});
  assert.equal(claude.includes('--model'), false); assert.equal(claude.includes('--effort'), false);
  assert.equal(claude.includes('--strict-mcp-config'), false);
  assert.equal(open.includes('-m'), false); assert.equal(open.includes('--variant'), false);
  const strict = buildClaudeArgs({ effort: 'high' }, { CLAUDE_STRICT_MCP: '1', CLAUDE_EFFORT: 'low' });
  assert.equal(strict[strict.indexOf('--effort') + 1], 'high'); assert.ok(strict.includes('--strict-mcp-config'));
  assert.equal(buildClaudeArgs({ strictMcp: false }, { CLAUDE_STRICT_MCP: '1' }).includes('--strict-mcp-config'), false);
  const variant = buildOpenCodeArgs({}, { OPENCODE_VARIANT: 'xhigh' });
  assert.equal(variant[variant.indexOf('--variant') + 1], 'xhigh');
});

test('Codex storage and strict settings require explicit selection', () => {
  assert.equal(resolveEngineSettings('codex', {}, { FRAMEWORK_CODEX_HOME: '/owned' }).homeMode, 'managed');
  assert.equal(resolveEngineSettings('codex', {}, { CODEX_HOME_MODE: 'managed' }).homeMode, 'managed');
  const selected = resolveEngineSettings('codex', { sandbox: 'read-only', instructionsMaxBytes: 512, strictVersion: true },
    { CODEX_SANDBOX: 'workspace-write', CODEX_INSTRUCTIONS_MAX_BYTES: '256' });
  assert.equal(selected.sandbox, 'read-only'); assert.equal(selected.instructionsMaxBytes, 512);
  assert.equal(selected.strictVersion, true);
  for (const env of [{ CODEX_SANDBOX: 'typo' }, { CODEX_HOME_MODE: 'typo' },
    { CODEX_HOME_MODE: 'personal', FRAMEWORK_CODEX_HOME: '/owned' }, { CODEX_STRICT_VERSION: 'typo' },
    { CODEX_INSTRUCTIONS_MAX_BYTES: '-1' }, { AGENT_IDLE_TIMEOUT_MS: 'Infinity' }]) {
    assert.throws(() => resolveEngineSettings('codex', {}, env));
  }
  assert.throws(() => resolveEngineSettings('claude', {}, { CLAUDE_STRICT_MCP: 'typo' }));
});

test('the duration parser and supervisor CLI preserve large settings and reject malformed values', () => {
  assert.equal(parseDuration('99m'), 99 * 60000); assert.equal(parseDuration('9999h'), 9999 * 3600000);
  assert.equal(parseDuration('1.5s'), 1500); assert.equal(parseDuration('12ms'), 12);
  assert.equal(parseDuration('12'), 12000); assert.equal(parseDuration('0'), 0);
  const options = parseArgs(['--effort', 'xhigh', '--sandbox', 'danger-full-access', '--idle-timeout', '99m', '--turn-timeout', '9999h']);
  assert.equal(options.effort, 'xhigh'); assert.equal(options.sandbox, 'danger-full-access');
  assert.equal(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS); assert.equal(options.timeoutMs, DEFAULT_TURN_TIMEOUT_MS);
  for (const argv of [['--effort'], ['--sandbox', 'wrong'], ['--idle-timeout', 'wrong'], ['--turn-timeout'], ['--turn-timeout', '-1']]) {
    assert.ok(parseArgs(argv).error, JSON.stringify(argv));
  }
  for (const value of ['-1', 'NaN', 'Infinity', '1d', '0.00001ms', '9007199254740992h']) assert.throws(() => parseDuration(value));
});

test('settings files are read literally with exported values first and launch variables excluded', t => {
  const base = process.env.FRAMEWORK_TEST_TMPDIR || tmpdir(); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'engine-settings-')); t.after(() => cleanupTempDir(dir));
  const file = join(dir, '.env');
  writeFileSync(file, 'CLAUDE_EFFORT=high\nOPENCODE_VARIANT=xhigh\nCODEX_MODEL="owner-model"\nFRAMEWORK_CODEX_HOME=/owned\nSAFETY_GUARD_MODE=confirm\nNODE_OPTIONS=arbitrary\nCODEX_HOME=/foreign\nTOKEN=secret-fixture\n');
  const env = loadEngineSettingsEnvironment([file], { CLAUDE_EFFORT: 'low' });
  assert.equal(env.CLAUDE_EFFORT, 'low'); assert.equal(env.OPENCODE_VARIANT, 'xhigh');
  assert.equal(env.CODEX_MODEL, 'owner-model'); assert.equal(env.FRAMEWORK_CODEX_HOME, '/owned');
  assert.equal(env.SAFETY_GUARD_MODE, 'confirm');
  assert.equal(env.CODEX_HOME, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.TOKEN, undefined);
  assert.equal(mcpEnvironmentNames({ servers: [{ secrets: ['FRAMEWORK_CODEX_HOME'] }] }).includes('FRAMEWORK_CODEX_HOME'), false);
});
