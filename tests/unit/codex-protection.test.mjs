import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPermissionsBlock, LEGACY_FRAMEWORK_DENY } from '../../core/permissions-policy.mjs';
import { destructiveReason } from '../../core/safety.mjs';
import { decidePermission, resolveMode } from '../../core/permission-decision.mjs';
import { compileCodexRules, buildCodexHooks } from '../../core/backends/codex-policy.mjs';
import { evaluateCodexHook, runCodexHook } from '../../core/backends/codex-hook.mjs';
import { CodexHome } from '../../core/backends/codex-home.mjs';
import { CodexBackend } from '../../core/backends/codex.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';

const scratch = process.env.FRAMEWORK_TEST_TMPDIR || tmpdir();
const event = (command, tool_name = 'Bash') => JSON.stringify({
  hook_event_name: 'PreToolUse', tool_name, tool_input: { command },
});
function fixture(t) {
  mkdirSync(scratch, { recursive: true });
  const base = mkdtempSync(join(scratch, 'codex-protection-test-'));
  t.after(() => cleanupTempDir(base));
  const project = join(base, 'project'), home = join(base, 'owned'), personal = join(base, 'personal');
  mkdirSync(project); mkdirSync(personal);
  return { base, project, home, personal, env: { CODEX_HOME: personal } };
}
const denied = r => r?.hookSpecificOutput?.permissionDecision === 'deny';

test('every shared denial is mapped, and five embedded masks retain explicit losses', () => {
  const source = { deny: [...LEGACY_FRAMEWORK_DENY] }, before = structuredClone(source);
  const r = compileCodexRules(source);
  assert.deepEqual(source, before);
  assert.deepEqual(r.mapping.map(m => m.rule), LEGACY_FRAMEWORK_DENY);
  assert.equal(r.mapping.length, 8);
  assert.equal(r.mapping.filter(m => m.status === 'translated').length, 3);
  assert.equal(r.dropped.length, 5);
  assert.ok(r.dropped.every(m => m.kind === 'partial' && m.reason.includes('globs') && m.represented.length));
  assert.ok(r.mapping.every(m => m.prefixes.length));
  assert.match(r.rules, /decision="forbidden"/);
  assert.doesNotMatch(r.rules, /decision="(?:allow|prompt)"/);
});

test('translation never bans ordinary push or all recursive local deletions', () => {
  const r = compileCodexRules({ deny: [...LEGACY_FRAMEWORK_DENY] });
  const prefixes = r.mapping.flatMap(m => m.prefixes);
  for (const argv of [['git', 'push', 'origin', 'feature'], ['rm', '-rf', 'build'],
    ['rm', '-rf', '/workspace/project/build'], ['sudo', 'rm', '-rf', 'build']]) {
    assert.ok(prefixes.every(p => !p.every((token, i) => argv[i] === token)), argv.join(' '));
  }
  const force = r.mapping.find(m => m.rule === 'Bash(git push --force*)');
  assert.equal(force.status, 'partial');
  assert.ok(force.prefixes.some(p => p.at(-1) === '--force'));
  assert.ok(force.prefixes.every(p => !p.every((token, i) => ['git', 'push', '--force-with-lease'][i] === token)));
  // The shared detector deliberately permits the lease form since v1.11.0. The wider
  // settings glob does not authorize inventing a second semantic detector here.
  assert.equal(destructiveReason('git push --force-with-lease owned-trap'), null);
});

test('unsupported forms are dropped with source and reason, malformed policy refuses', () => {
  const forms = ['Read', 'Bash(git push "$REMOTE")', 'Bash(git status; node task.mjs)',
    'Bash(* --force)', 'Bash(rm * /)', 'Bash()', 'Bash(   )', 'Bash(node ?)', 'Bash(git\npush)'];
  const r = compileCodexRules({ deny: forms });
  assert.equal(r.dropped.length, forms.length);
  assert.deepEqual(r.dropped.map(m => m.rule), forms);
  assert.ok(r.dropped.every(m => m.reason.length > 20 && m.represented.length === 0));
  for (const policy of [null, {}, { deny: 'git' }, { deny: [1] }]) {
    assert.throws(() => compileCodexRules(policy), /deny array/);
  }
  assert.equal(compileCodexRules({ deny: [] }).mapping.length, 0);
});

test('duplicate policy entries do not duplicate native rules, trailing argv wildcard remains narrow', () => {
  const r = compileCodexRules({ deny: ['Bash(git push -f *)', 'Bash(git push -f *)'] });
  assert.equal(r.mapping.length, 2); assert.equal(r.dropped.length, 0);
  assert.equal(r.rules.split('prefix_rule(').length - 1, 1);
  assert.deepEqual(r.mapping[0].prefixes, [['git', 'push', '-f']]);
});

test('the hook shares all four semantic prohibitions and permits routine commands', () => {
  for (const cmd of ['rm -rf /', 'format C:', 'taskkill /IM node.exe /F',
    'git push --force owned-trap']) {
    assert.ok(denied(evaluateCodexHook(event(cmd), decidePermission)), cmd);
  }
  for (const cmd of ['git push owned-trap feature', 'git push --force-with-lease owned-trap',
    'git push --force-if-includes owned-trap', 'rm -rf build', 'node --test', 'git status']) {
    assert.equal(denied(evaluateCodexHook(event(cmd), decidePermission)), false, cmd);
  }
  assert.ok(denied(evaluateCodexHook(event('git push --force owned-trap', 'exec_command'), decidePermission)));
  assert.ok(denied(evaluateCodexHook(event('git push --force owned-trap', 'shell_command'), decidePermission)));
  assert.equal(denied(evaluateCodexHook(event('literal rm -rf / in a patch', 'apply_patch'), decidePermission)), false);
  assert.equal(denied(evaluateCodexHook(event('non-shell MCP argument', 'mcp__echo__call'), decidePermission)), false);
});

test('malformed hook payload, missing command and broken detector all deny without echoing secrets', () => {
  for (const input of ['', '{', 'null', '[]', '{}', JSON.stringify({ tool_name: 'Bash' }),
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: '', tool_input: {} }),
    event(''), event('   '), event(null)]) {
    assert.ok(denied(evaluateCodexHook(input, decidePermission)));
  }
  for (const detector of [undefined, () => undefined, () => '', () => false,
    () => { throw new Error('TEST_ONLY_SECRET_VALUE'); }]) {
    const result = evaluateCodexHook(event('git status'), detector);
    assert.ok(denied(result)); assert.doesNotMatch(JSON.stringify(result), /TEST_ONLY_SECRET_VALUE/);
  }
});

test('wrapper failures and prohibitions produce supported deny JSON with exit 0, routine input stays empty', async () => {
  for (const options of [
    { read: () => { throw new Error('input unavailable'); }, loadDetector: async () => ({ decidePermission, resolveMode }) },
    { read: () => event('git status'), loadDetector: async () => { throw new Error('import unavailable'); } },
    { read: () => '{', loadDetector: async () => ({ decidePermission, resolveMode }) },
    { read: () => '{}', loadDetector: async () => ({ decidePermission, resolveMode }) },
    { read: () => event(''), loadDetector: async () => ({ decidePermission, resolveMode }) },
    { read: () => event('git status'), loadDetector: async () => ({}) },
    { read: () => event('git status'), loadDetector: async () => ({ resolveMode, decidePermission() { throw new Error('TEST_ONLY_SECRET'); } }) },
    { read: () => event('git push --force owned-trap'), loadDetector: async () => ({ decidePermission, resolveMode }) },
  ]) {
    let stdout = '', stderr = '';
    const code = await runCodexHook({ ...options, write: s => { stdout += s; }, writeError: s => { stderr += s; } });
    const parsed = JSON.parse(stdout);
    assert.equal(code, 0); assert.ok(denied(parsed));
    assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.ok(parsed.hookSpecificOutput.permissionDecisionReason.trim());
    assert.equal(stderr, parsed.hookSpecificOutput.permissionDecisionReason + '\n');
    assert.equal(stdout.trim().split(/\r?\n/).length, 1);
    assert.doesNotMatch(stdout + stderr, /TEST_ONLY_SECRET/);
  }
  let stdout = '';
  assert.equal(await runCodexHook({ read: () => event('git status'), loadDetector: async () => ({ decidePermission, resolveMode }),
    write: s => { stdout += s; }, writeError: () => { throw new Error('unexpected error'); } }), 0);
  // output_parser.rs rejects permissionDecision:allow without updatedInput.
  assert.equal(stdout, '');
});

test('hook commands quote literal paths and the Windows payload forwards UTF-8 stdin', t => {
  const f = fixture(t), hookFile = join(f.home, "guard's script.mjs");
  const r = buildCodexHooks({ hookFile });
  const handler = r.hooks.PreToolUse[0].hooks[0];
  assert.equal(r.hooks.PreToolUse[0].matcher, '*'); assert.equal(handler.timeout, 15);
  assert.ok(handler.command.includes("'\\''"));
  const script = Buffer.from(/-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(handler.commandWindows)[1], 'base64').toString('utf16le');
  assert.ok(script.includes("guard''s script.mjs")); assert.match(script, /UTF8Encoding/);
  assert.match(script, /ReadToEnd\(\)/); assert.ok(script.endsWith('exit $LASTEXITCODE'));
  assert.match(handler.commandWindows, /^[A-Za-z]:\/.*powershell\.exe /);
  assert.doesNotMatch(handler.commandWindows, /; exit \$LASTEXITCODE$/);
  assert.throws(() => buildCodexHooks({ hookFile: 'relative.mjs' }), /absolute/);
  assert.throws(() => buildCodexHooks({ hookFile, powershellPath: 'powershell.exe' }), /absolute/);
});

test('permission installation dry-run leaves project, external home and login source untouched', async t => {
  const f = fixture(t); writeFileSync(join(f.personal, 'auth.json'), '{"TEST_ONLY":"login"}\n');
  const fail = () => { throw new Error('dry-run must not launch CLI'); };
  const b = new CodexBackend({ env: f.env, homeDir: f.home, launch: fail, inspect: fail });
  const before = readdirSync(f.base);
  const r = await b.applyPermissions({ targetDir: f.project, dryRun: true });
  assert.equal(r.applied, false); assert.equal(r.dropped.length, 0); assert.deepEqual(r.restored, []);
  assert.deepEqual(readdirSync(f.base), before); assert.deepEqual(readdirSync(f.project), []);
  assert.equal(readFileSync(join(f.personal, 'auth.json'), 'utf8'), '{"TEST_ONLY":"login"}\n');
});

test('invalid explicit permission policy refuses before creating external state', async t => {
  const f = fixture(t), b = new CodexBackend({ env: f.env, homeDir: f.home });
  const before = readdirSync(f.base);
  for (const policy of [null, { deny: [1] }]) {
    await assert.rejects(b.applyPermissions({ targetDir: f.project, policy }), /deny array/);
  }
  assert.deepEqual(readdirSync(f.base), before);
});

test('tampered runtime, manifest, rules and detector restore from private host snapshots', t => {
  const f = fixture(t), workspaceCore = join(f.project, 'core'); mkdirSync(workspaceCore);
  const safetySource = join(workspaceCore, 'safety.mjs'), hookSource = join(workspaceCore, 'hook.mjs');
  writeFileSync(safetySource, readFileSync(new URL('../../core/safety.mjs', import.meta.url)));
  writeFileSync(hookSource, readFileSync(new URL('../../core/backends/codex-hook.mjs', import.meta.url)));
  const h = new CodexHome({ env: f.env, homeDir: f.home, safetySource, hookSource });
  const policy = buildPermissionsBlock();
  const first = h.prepareProtection({ cwd: f.project, policy });
  const files = [first.safetyFile, first.hookFile, first.hooksFile, first.rulesFile];
  const expected = files.map(file => readFileSync(file));
  for (const file of files) writeFileSync(file, 'TAMPERED\n');
  writeFileSync(safetySource, 'export function destructiveReason() { return null; }\n');
  writeFileSync(hookSource, 'process.exit(0);\n');
  policy.deny.length = 0; first.mapping.length = 0; first.dropped.length = 0;
  const second = h.prepareProtection({ cwd: f.project });
  assert.deepEqual(new Set(second.restored), new Set(files));
  assert.equal(second.mapping.length, 0); assert.equal(second.dropped.length, 0);
  files.forEach((file, i) => assert.deepEqual(readFileSync(file), expected[i]));
  assert.deepEqual(h.prepareProtection({ cwd: f.project }).restored, []);
});

test('copied external hook returns supported deny JSON with exit 0 without workspace sources or detector', t => {
  const f = fixture(t), h = new CodexHome({ env: f.env, homeDir: f.home });
  const r = h.prepareProtection({ cwd: f.project });
  for (const [input, shouldDeny] of [[event('git push --force owned-trap'), true], [event('git status'), false], ['{', true]]) {
    const child = spawnSync(process.execPath, [r.hookFile], { cwd: f.project, input, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    if (shouldDeny) { assert.ok(denied(JSON.parse(child.stdout))); assert.ok(child.stderr.trim()); }
    else { assert.equal(child.stdout, ''); assert.equal(child.stderr, ''); }
  }
  unlinkSync(r.safetyFile);
  const failed = spawnSync(process.execPath, [r.hookFile], { cwd: f.project, input: event('git status'), encoding: 'utf8' });
  assert.equal(failed.status, 0); assert.ok(denied(JSON.parse(failed.stdout))); assert.ok(failed.stderr.trim());
  assert.deepEqual(readdirSync(f.project), []);
});

test('structured denial survives the complete native outer shell without relying on exit 2', t => {
  const f = fixture(t), h = new CodexHome({ env: f.env,
    homeDir: join(f.base, "owned ' \u0434\u043e\u043c") });
  const r = h.prepareProtection({ cwd: f.project });
  const handler = JSON.parse(readFileSync(r.hooksFile, 'utf8')).hooks.PreToolUse[0].hooks[0];
  const windows = /^(?:"([^"]+)"|(\S+)) (.+)$/.exec(handler.commandWindows);
  const bin = process.platform === 'win32' ? windows[1] || windows[2] : '/bin/sh';
  // Exercise Codex's outer shell, rather than only the encoded inner shell.
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', handler.commandWindows] : ['-c', handler.command];
  const child = spawnSync(bin, args, { cwd: f.project, input: event('git push --force owned-trap'), encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr); assert.ok(denied(JSON.parse(child.stdout)));
  const allowed = spawnSync(bin, args, { cwd: f.project, input: event('git status'), encoding: 'utf8', timeout: 10000 });
  assert.equal(allowed.status, 0, allowed.stderr); assert.equal(allowed.stdout, '');
  const malformed = spawnSync(bin, args, { cwd: f.project, input: '{', encoding: 'utf8', timeout: 10000 });
  assert.equal(malformed.status, 0, malformed.stderr); assert.ok(denied(JSON.parse(malformed.stdout)));
  if (process.platform === 'win32') {
    // A real OS control establishes why deny JSON plus the old exit 2 was lost:
    // the outer PowerShell returns 1, and Codex does not parse JSON on that status.
    const legacy = join(r.home, 'guard', 'backends', 'legacy-exit.mjs');
    writeFileSync(legacy, 'process.stdout.write(' + JSON.stringify(child.stdout)
      + '); process.stderr.write("synthetic denial\\n"); process.exitCode = 2;\n');
    const command = buildCodexHooks({ hookFile: legacy }).hooks.PreToolUse[0].hooks[0].commandWindows;
    const converted = spawnSync(bin, ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: f.project, input: event('git push --force owned-trap'), encoding: 'utf8', timeout: 10000,
    });
    assert.equal(converted.status, 1, converted.stderr);
    assert.ok(denied(JSON.parse(converted.stdout)));
  }
  unlinkSync(r.safetyFile);
  const missing = spawnSync(bin, args, { cwd: f.project, input: event('git status'), encoding: 'utf8', timeout: 10000 });
  assert.equal(missing.status, 0, missing.stderr); assert.ok(denied(JSON.parse(missing.stdout)));
  assert.deepEqual(readdirSync(f.project), []);
});
