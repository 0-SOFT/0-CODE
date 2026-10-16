import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CodexHome } from '../../core/backends/codex-home.mjs';
import { OpenCodeBackend } from '../../core/backends/opencode.mjs';
import { ClaudeBackend } from '../../core/backends/claude.mjs';
import { LEGACY_FRAMEWORK_DENY, buildPermissionsBlock } from '../../core/permissions-policy.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';

function fixture(t) {
  const base = process.env.FRAMEWORK_TEST_TMPDIR || tmpdir(); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'guard-modes-')); t.after(() => cleanupTempDir(dir));
  const project = join(dir, 'project'), home = join(dir, 'home'), personal = join(dir, 'personal');
  for (const path of [project, home, personal]) mkdirSync(path);
  return { dir, project, home, personal, log: join(dir, 'audit.jsonl') };
}

test('three actual guard entrypoints share every mode, confirmation and routine-command decision', async t => {
  const f = fixture(t), env = { ...process.env, CODEX_HOME: f.personal, SAFETY_GUARD_LOG: f.log };
  const codex = new CodexHome({ env, homeDir: join(f.dir, 'codex') }).prepareProtection({ cwd: f.project });
  await new OpenCodeBackend().ensureReady({ cwd: f.project, home: f.home });
  const plugin = pathToFileURL(join(f.home, '.config', 'opencode', 'plugins', 'safety-guard.js')).href;
  const pluginRunner = join(f.dir, 'plugin-runner.mjs');
  writeFileSync(pluginRunner, `import {readFileSync} from 'node:fs';
    const {SafetyGuard}=await import(${JSON.stringify(plugin)});
    const e=JSON.parse(readFileSync(0,'utf8'));
    try {await (await SafetyGuard())['tool.execute.before']({tool:'bash'},{args:e.tool_input});}
    catch(error){console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:error.message}}));}
  `);
  const entrypoints = [new URL('../../hooks/safety-guard.mjs', import.meta.url), codex.hookFile, pluginRunner];
  const reason = 'owned disposable branch checked before intentional replacement';
  const cases = [
    ['rm -rf /', 'hard'], ['format C:', 'hard'], ['taskkill /IM node.exe /F', 'hard'],
    [`rm -rf / # safety-guard: confirmed ${reason}`, 'hard'],
    ['git push --force local-trap feature', 'force'],
    [`git push --force local-trap feature # safety-guard: confirmed ${reason}`, 'confirmed'],
    ['git clean -fdx', 'advisory'], ['rm -rf ./build', 'routine'], ['rm -rf /workspace/project/build', 'routine'],
    ['taskkill /PID 12345 /T /F', 'routine'], ['git push origin feature', 'routine'],
    ['format /?', 'routine'], ['cmd /c "format /?"', 'routine'],
    ['Remove-Item -LiteralPath "C:/work/project/build" -Recurse -Force', 'routine'],
    ['Stop-Process -Id 12345', 'routine'], ['bash -c "rm -rf ./build"', 'routine'],
    [JSON.parse(readFileSync(new URL('../fixtures/powershell-here-data.json', import.meta.url), 'utf8')).command, 'routine'],
    ["@'\nrm -rf /\n'@ | iex", 'hard'],
    ["@'\nformat C:\n'@ | pwsh", 'hard'],
    ["@'\nexample\n'@ | node; format C:", 'hard'],
  ];
  for (const mode of ['arbiter', 'guard-only', 'confirm', 'allow-all', 'typo']) {
    for (const [command, kind] of cases) {
      const expected = mode !== 'allow-all' && (kind === 'hard' || kind === 'force' || (mode === 'confirm' && kind === 'advisory'));
      const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
      for (const entry of entrypoints) {
        const result = spawnSync(process.execPath, [entry instanceof URL ? entry.pathname.replace(/^\/(\w:)/, '$1') : entry],
          { cwd: f.project, input, encoding: 'utf8', windowsHide: true, env: { ...env, SAFETY_GUARD_MODE: mode } });
        assert.equal(result.status, 0, result.stderr);
        const output = result.stdout.trim() ? JSON.parse(result.stdout) : null;
        assert.equal(output?.hookSpecificOutput?.permissionDecision === 'deny', expected, `${entry}: ${mode}, ${command}`);
        if (kind === 'force' && expected) assert.match(output.hookSpecificOutput.permissionDecisionReason, /safety-guard: confirmed/);
      }
    }
  }
  const entries = readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(entries.filter(e => / rule confirmed by the agent /.test(e.reason)).length >= 9);
  assert.ok(entries.some(e => e.mode === 'allow-all'));
  assert.ok(entries.every(e => /^[a-f0-9]{64}$/.test(e.command_sha256)));
  assert.ok(entries.every(e => !Object.hasOwn(e, 'command')));
  assert.deepEqual(buildPermissionsBlock().deny, []);
});

test('project migration removes only former framework deny rules and preserves unrelated owner settings', async t => {
  const f = fixture(t), claudeDir = join(f.project, '.claude'); mkdirSync(claudeDir);
  const file = join(claudeDir, 'settings.json');
  const own = 'Bash(owner-protected-command)';
  writeFileSync(file, JSON.stringify({ model: 'owner-model', permissions: { deny: [...LEGACY_FRAMEWORK_DENY, own] },
    hooks: { Stop: [] } }));
  await new ClaudeBackend({ env: {} }).ensureReady({ cwd: f.project });
  const claude = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(claude.permissions.deny, [own]); assert.equal(claude.model, 'owner-model');
  assert.deepEqual(claude.hooks, { Stop: [] });
  writeFileSync(join(f.project, 'opencode.json'), JSON.stringify({ model: 'owner-model', permission: {
    bash: { '*': 'allow', 'rm -rf /*': 'deny', 'git push --force*': 'deny', 'owner-protected-command': 'deny' } } }));
  const backend = new OpenCodeBackend({ env: {} });
  await backend.ensureReady({ cwd: f.project, home: f.home });
  const open = JSON.parse(readFileSync(join(f.project, 'opencode.json'), 'utf8'));
  assert.deepEqual(open.permission.bash, { '*': 'allow', 'owner-protected-command': 'deny' });
  assert.equal(open.model, 'owner-model');
  assert.deepEqual((await backend.ensureReady({ cwd: f.project, home: f.home })).restored, []);
});
