import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { CodexBackend, CODEX_INSTRUCTIONS_MAX_BYTES, validateCodexInstructions } from '../../core/backends/codex.mjs';
import { buildCodexConfiguration, validateCodexRuntimeOptions } from '../../core/backends/codex-config.mjs';
import { canonicalCodexPath } from '../../core/backends/codex-home.mjs';
import { classifyFailure } from '../../core/turn-retry.mjs';
import { parseToml } from '../../lib/toml-mini.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';

const scratch = process.env.FRAMEWORK_TEST_TMPDIR || tmpdir();
mkdirSync(scratch, { recursive: true });
const recorded = readFileSync(new URL('../fixtures/codex/0.160.1-ok.jsonl', import.meta.url), 'utf8');
function fixture(t) {
  const base = mkdtempSync(join(scratch, 'codex-config-test-'));
  t.after(() => cleanupTempDir(base));
  const project = join(base, 'project'), personal = join(base, 'personal'), home = join(base, 'owned');
  mkdirSync(project); mkdirSync(personal);
  return { base, project, personal, home, homeDir: home,
    env: { CODEX_HOME: personal, CODEX_SANDBOX: 'workspace-write' }, command: { bin: 'recorded', args: [] } };
}

test('runtime options cannot disable managed settings or introduce an unvetted source', () => {
  for (const options of [{ sandbox: 'unknown' },
    { bypassHookTrust: false }, { config: 'x=y' }, { config: [1] },
    { config: ['hooks.PreToolUse=[]'] }, { config: ['features.hooks=false'] },
    { config: ['model_reasoning_effort="high"\nhooks.PreToolUse=[]'] }]) {
    assert.throws(() => validateCodexRuntimeOptions(options), /Invalid Codex|Codex config overrides/);
  }
  const allowed = ['model_reasoning_effort="xhigh"', 'web_search="disabled"', 'model_reasoning_summary="auto"',
    'service_tier="fast"', 'model_verbosity="high"', 'approval_policy="never"', 'profile="foreign"'];
  assert.deepEqual(validateCodexRuntimeOptions({ config: allowed }), allowed);
  assert.deepEqual(validateCodexRuntimeOptions(), []);
  for (const sandbox of ['danger-full-access', 'workspace-write', 'read-only']) assert.deepEqual(validateCodexRuntimeOptions({ sandbox }), []);
  assert.deepEqual(validateCodexRuntimeOptions({ ignoreUserConfig: true }), []);
});

test('a complete profile writes whole roots and the untrusted project key preserves literal paths', t => {
  const f = fixture(t), project = join(f.project, 'with.dot space and "quote"');
  const windows = buildCodexConfiguration({ project, sandbox: 'workspace-write', writableRoots: [f.personal, f.personal], platform: 'win32' });
  const projects=parseToml(windows.overrides.find(value=>value.startsWith('projects='))).projects;
  assert.deepEqual(Object.keys(projects),[project]);assert.equal(projects[project].trust_level,'untrusted');
  assert.ok(windows.overrides.includes('windows.sandbox="unelevated"'));
  assert.match(windows.content, /project_doc_max_bytes=32768/);
  assert.match(windows.content, /features\.unified_exec=false/);
  assert.match(windows.content, /features\.unified_exec_tty=false/);
  assert.doesNotMatch(windows.content, /project_doc_fallback_filenames|cli_auth_credentials_store/);
  assert.ok(windows.overrides.includes(`permissions.framework.workspace_roots={${JSON.stringify(f.personal)}=true}`));
  assert.doesNotMatch(buildCodexConfiguration({ project: f.project, platform: 'linux' }).content, /windows/);
  assert.throws(() => buildCodexConfiguration({ project: 'relative' }), /project path/);
  assert.throws(() => buildCodexConfiguration({ project: f.project, writableRoots: 'invalid' }), /writable roots/);
  assert.throws(() => buildCodexConfiguration({ project: f.project, writableRoots: ['relative'] }), /writable roots/);
});

test('checkEngine and runTurn restore security files before CLI calls and select only the owned home', async t => {
  const f = fixture(t), calls = [], extra = join(f.base, 'extra'); mkdirSync(extra);
  writeFileSync(join(f.personal, 'config.toml'), 'PERSONAL CONFIG\n');
  const b = new CodexBackend({ ...f,
    inspect(bin, args, opts) {
      calls.push(args);
      assert.equal(opts.env.CODEX_HOME, canonicalCodexPath(f.home));
      assert.ok(existsSync(join(f.home, 'guard', 'safety.mjs')));
      assert.match(readFileSync(join(f.home, 'config.toml'), 'utf8'), /features.hooks=true/);
      return { status: 0, stdout: args.includes('--version') ? 'codex-cli 0.162.0' : '' };
    },
    async launch(bin, args, opts) {
      assert.equal(opts.env.CODEX_HOME, canonicalCodexPath(f.home));
      assert.ok(args.includes('--dangerously-bypass-hook-trust'));
      assert.ok(!args.includes('--ignore-user-config'));
      assert.ok(args.includes('features.hooks=true'));
      assert.ok(!args.some(arg => arg.startsWith('approval_policy=')));
      assert.ok(args.includes('default_permissions="framework"'));
      assert.ok(args.includes(`permissions.framework.workspace_roots={${JSON.stringify(canonicalCodexPath(extra))}=true}`));
      assert.equal(parseToml(readFileSync(join(f.home,'config.toml'),'utf8')).projects[canonicalCodexPath(f.project)].trust_level,'untrusted');
      assert.ok(readFileSync(join(f.home, 'hooks.json'), 'utf8').includes('PreToolUse'));
      assert.ok(!readFileSync(join(f.home, 'rules', 'framework.rules'), 'utf8').includes('forbidden'));
      return { status: 0, stdout: recorded };
    } });
  const first = await b.applyPermissions({ targetDir: f.project, writableRoots: [extra] });
  first.writableRoots.length = 0;
  assert.equal((await b.checkEngine({ cwd: f.project })).ok, true);
  assert.equal(calls.length, 2);
  const expected = readFileSync(first.configFile);
  for (const file of [first.configFile, first.hooksFile, first.rulesFile]) writeFileSync(file, 'TAMPERED');
  const result = await b.runTurn({ cwd: f.project, prompt: 'recorded', config: ['model_reasoning_effort="high"'] });
  assert.equal(result.ok, true);
  assert.deepEqual(readFileSync(first.configFile), expected);
  assert.equal(readFileSync(join(f.personal, 'config.toml'), 'utf8'), 'PERSONAL CONFIG\n');
  assert.deepEqual(readdirSync(f.project), []);
});

test('invalid turn options refuse before creating home, importing login or starting CLI', async t => {
  const f = fixture(t); writeFileSync(join(f.personal, 'auth.json'), '{"TEST_ONLY":"login"}');
  let calls = 0;
  const b = new CodexBackend({ ...f, launch: async () => { calls++; } });
  for (const options of [{ config: ['hooks.PreToolUse=[]'] },
    { sandbox: 'unknown' }, { sessionId: '--last' }]) {
    const result = await b.runTurn({ cwd: f.project, prompt: 'recorded', ...options });
    assert.equal(result.ok, false);
    assert.equal(classifyFailure(result.error), 'fatal');
  }
  assert.equal(calls, 0); assert.equal(existsSync(f.home), false);
  assert.equal(readFileSync(join(f.personal, 'auth.json'), 'utf8'), '{"TEST_ONLY":"login"}');
});

test('turn argv omits unset model and effort and preserves explicit overrides', async t => {
  const f = fixture(t), calls = [];
  const backend = new CodexBackend({ ...f, async launch(bin, args) {
    calls.push(args);
    return { status: 0, stdout: recorded };
  } });
  for (const options of [{}, { model: 'gpt-6-luna' },
    { model: 'owner-model', config: ['  model_reasoning_effort = "high"', 'web_search="disabled"'] },
    { env: { ...f.env, CODEX_REASONING_EFFORT: 'xhigh' }, config: ['model_reasoning_effort="high"'] },
    { effort: 'high', env: { ...f.env, CODEX_REASONING_EFFORT: 'xhigh' }, config: ['model_reasoning_effort="low"'] }]) {
    assert.equal((await backend.runTurn({ cwd: f.project, prompt: 'recorded', ...options })).ok, true);
  }
  const model = args => args[args.indexOf('-m') + 1];
  const efforts = args => args.filter(value => /^\s*model_reasoning_effort\s*=/.test(value));
  assert.equal(calls[0].includes('-m'), false);
  assert.deepEqual(efforts(calls[0]), []);
  assert.equal(model(calls[1]), 'gpt-6-luna');
  assert.deepEqual(efforts(calls[1]), []);
  assert.equal(model(calls[2]), 'owner-model');
  assert.deepEqual(efforts(calls[2]), ['  model_reasoning_effort = "high"']);
  assert.ok(calls[2].includes('web_search="disabled"'));
  assert.deepEqual(efforts(calls[3]), ['model_reasoning_effort="high"']);
  assert.deepEqual(efforts(calls[4]), ['model_reasoning_effort="high"']);
});

test('broken security artifacts refuse both service checks and working turns before any CLI', async t => {
  const f = fixture(t); let calls = 0;
  const fail = () => { calls++; throw new Error('unprotected CLI must not start'); };
  const b = new CodexBackend({ ...f, inspect: fail, launch: fail });
  await b.ensureReady({ cwd: f.project });
  const owner = join(f.home, 'framework-owner.json'); writeFileSync(owner, 'TAMPERED OWNER');
  const engine = await b.checkEngine({ cwd: f.project });
  const turn = await b.runTurn({ cwd: f.project, prompt: 'recorded' });
  for (const result of [engine, turn]) {
    assert.equal(result.ok, false); assert.equal(classifyFailure(result.error), 'fatal');
  }
  assert.equal(engine.protectionFailed, true); assert.equal(calls, 0);
  assert.equal(classifyFailure('Invalid Codex protection: unreadable directory usage_limited'), 'fatal');
});

test('execution setup dry-run cannot restore configuration or import credentials', async t => {
  const f = fixture(t); let calls = 0;
  const b = new CodexBackend({ ...f, inspect: () => { calls++; }, launch: () => { calls++; } });
  const planned = await b.ensureReady({ cwd: f.project, dryRun: true });
  assert.equal(planned.dryRun, true); assert.equal(existsSync(f.home), false);
  assert.deepEqual(planned.restored, []); assert.equal(calls, 0);
});

test('a per-call API key avoids login checking, while subscription requires an independent owned login', async t => {
  const f = fixture(t), source = join(f.personal, 'auth.json');
  writeFileSync(source, '{"TEST_ONLY":"login"}');
  let logins = 0;
  const b = new CodexBackend({ ...f, inspect(bin, args, opts) {
    if (args.includes('login')) logins++;
    assert.equal(opts.env.CODEX_HOME, canonicalCodexPath(f.home));
    return { status: 0, stdout: args.includes('--version') ? 'codex-cli 0.162.0' : '' };
  } });
  const keyed = await b.checkEngine({ cwd: f.project, env: { ...f.env, CODEX_API_KEY: 'TEST_ONLY_KEY' } });
  assert.equal(keyed.auth, 'api-key'); assert.equal(logins, 0);
  assert.equal(existsSync(join(f.home, 'auth.json')), false);
  writeFileSync(join(f.home, 'auth.json'), '{"TEST_ONLY":"independent-login"}');
  assert.equal((await b.checkEngine({ cwd: f.project })).auth, 'saved-login');
  assert.equal(logins, 1);
  assert.equal(readFileSync(join(f.home, 'auth.json'), 'utf8'), '{"TEST_ONLY":"independent-login"}');
  assert.equal(readFileSync(source, 'utf8'), '{"TEST_ONLY":"login"}');
});

test('instructions are checked before every turn and probe instead of accepting native truncation', async t => {
  const f = fixture(t), file = join(f.project, 'AGENTS.md');
  let calls = 0;
  const backend = new CodexBackend({ ...f, env: { ...f.env, CODEX_INSTRUCTIONS_MAX_BYTES: String(CODEX_INSTRUCTIONS_MAX_BYTES) },
    launch: async () => { calls++; return { status: 0, stdout: recorded }; },
    inspect: () => { calls++; return { status: 0, stdout: 'codex-cli 0.162.0' }; } });
  writeFileSync(file, 'short instructions');
  assert.equal((await backend.runTurn({ cwd: f.project, prompt: 'first' })).ok, true);
  assert.equal(calls, 1);
  writeFileSync(file, 'x'.repeat(CODEX_INSTRUCTIONS_MAX_BYTES + 1));
  assert.match((await backend.runTurn({ cwd: f.project, prompt: 'second' })).error, /configured limit/);
  assert.equal((await backend.checkEngine({ cwd: f.project })).protectionFailed, true);
  assert.equal(calls, 1);
});

test('instruction discovery matches root-to-cwd preference and counts combined UTF-8 bytes', t => {
  const f = fixture(t), nested = join(f.project, 'nested');
  mkdirSync(join(f.project, '.git')); mkdirSync(nested);
  writeFileSync(join(f.project, 'CLAUDE.md'), 'c'.repeat(40000));
  writeFileSync(join(f.project, 'AGENTS.md'), 'a'.repeat(10000));
  writeFileSync(join(nested, 'AGENTS.md'), 'é'.repeat(12000));
  assert.throws(() => validateCodexInstructions(nested, { maxBytes: CODEX_INSTRUCTIONS_MAX_BYTES }), /configured limit/);
  assert.ok(validateCodexInstructions(nested).bytes > CODEX_INSTRUCTIONS_MAX_BYTES);
  writeFileSync(join(nested, 'AGENTS.override.md'), 'short');
  const selected = validateCodexInstructions(nested);
  assert.equal(selected.bytes, 10005);
  assert.deepEqual(selected.files, [join(f.project, 'AGENTS.md'), join(nested, 'AGENTS.override.md')]);
});

test('directories do not replace instruction files and the CLAUDE fallback is checked', t => {
  const f = fixture(t);
  mkdirSync(join(f.project, 'AGENTS.override.md'));
  writeFileSync(join(f.project, 'CLAUDE.md'), 'fallback');
  assert.equal(validateCodexInstructions(f.project).bytes, 8);
});


test('untrusted turns receive ordered, refreshed home instructions without inheriting project config', async t => {
  const f = fixture(t), nested = join(f.project, 'nested');
  mkdirSync(join(f.project, '.git')); mkdirSync(nested);
  writeFileSync(join(f.project, 'AGENTS.md'), 'ROOT_WORD. Root instructions.');
  writeFileSync(join(f.project, 'CLAUDE.md'), 'UNSELECTED_ROOT_WORD');
  writeFileSync(join(nested, 'AGENTS.md'), 'UNSELECTED_NESTED_WORD');
  const local = join(nested, 'AGENTS.override.md');
  writeFileSync(local, 'NESTED_WORD. Local instructions.');
  const selected = validateCodexInstructions(nested);
  const snapshots = [];
  const backend = new CodexBackend({ ...f, env: { ...f.env, CODEX_INSTRUCTIONS_MAX_BYTES: String(CODEX_INSTRUCTIONS_MAX_BYTES) },
    launch: async (_, args, opts) => {
    assert.equal(parseToml(args.find(value=>value.startsWith('projects='))).projects[canonicalCodexPath(nested)].trust_level,'untrusted');
    assert.equal(opts.env.CODEX_HOME, canonicalCodexPath(f.home));
    const text = readFileSync(join(f.home, 'AGENTS.override.md'), 'utf8');
    assert.ok(text.includes('ROOT_WORD'));
    const localWord = snapshots.length ? 'CHANGED_WORD' : 'NESTED_WORD';
    assert.ok(text.includes(localWord));
    assert.ok(text.indexOf('ROOT_WORD') < text.indexOf(localWord));
    assert.ok(text.includes(nested));
    assert.doesNotMatch(text, /UNSELECTED|TAMPERED/);
    snapshots.push(text);
    return { status: 0, stdout: recorded };
  } });
  assert.equal((await backend.runTurn({ cwd: nested, prompt: 'first' })).ok, true);
  assert.equal(snapshots[0], selected.content);
  writeFileSync(join(f.home, 'AGENTS.override.md'), 'TAMPERED');
  writeFileSync(local, 'CHANGED_WORD. Changed local instructions.');
  assert.equal((await backend.runTurn({ cwd: nested, prompt: 'second' })).ok, true);
  assert.equal(snapshots.length, 2);
  assert.doesNotMatch(snapshots[1], /NESTED_WORD/);
  writeFileSync(local, '\u044f'.repeat(CODEX_INSTRUCTIONS_MAX_BYTES));
  const oversized = await backend.runTurn({ cwd: nested, prompt: 'third' });
  assert.equal(oversized.ok, false); assert.match(oversized.error, /configured limit/);
  assert.equal(snapshots.length, 2, 'an old valid snapshot cannot authorize oversized new instructions');
});

test('empty project instructions replace stale home instructions with a nonempty scoped override', async t => {
  const f = fixture(t), file = join(f.project, 'AGENTS.md');
  writeFileSync(file, 'OLD_WORD');
  const backend = new CodexBackend({ ...f });
  const first = await backend.ensureReady({ cwd: f.project });
  assert.match(readFileSync(first.instructionsFile, 'utf8'), /OLD_WORD/);
  writeFileSync(join(f.home, 'AGENTS.md'), 'STALE_HOME_WORD');
  unlinkSync(file);
  const empty = validateCodexInstructions(f.project);
  assert.equal(empty.bytes, 0); assert.deepEqual(empty.files, []);
  await backend.ensureReady({ cwd: f.project });
  const snapshot = readFileSync(first.instructionsFile, 'utf8');
  assert.ok(snapshot.trim()); assert.ok(snapshot.includes(f.project));
  assert.doesNotMatch(snapshot, /OLD_WORD|STALE_HOME_WORD/);
  assert.equal(readFileSync(join(f.home, 'AGENTS.md'), 'utf8'), 'STALE_HOME_WORD');
});

test('a maximum-size UTF-8 body is passed whole and a damaged home snapshot refuses launch', async t => {
  const f = fixture(t), file = join(f.project, 'AGENTS.md');
  const body = '\u044f'.repeat(CODEX_INSTRUCTIONS_MAX_BYTES / 2);
  writeFileSync(file, body);
  const selected = validateCodexInstructions(f.project);
  assert.equal(selected.bytes, CODEX_INSTRUCTIONS_MAX_BYTES);
  assert.ok(selected.content.endsWith(body + '\n'));
  let calls = 0;
  const backend = new CodexBackend({ ...f, launch: async () => { calls++; return { status: 0, stdout: recorded }; } });
  const planned = await backend.ensureReady({ cwd: f.project, dryRun: true });
  assert.equal(planned.instructionsFile, join(canonicalCodexPath(f.home), 'AGENTS.override.md'));
  assert.equal(existsSync(f.home), false);
  assert.equal((await backend.runTurn({ cwd: f.project, prompt: 'full' })).ok, true);
  const snapshot = join(f.home, 'AGENTS.override.md');
  assert.ok(readFileSync(snapshot, 'utf8').endsWith(body + '\n'));
  unlinkSync(snapshot); mkdirSync(snapshot);
  const refused = await backend.runTurn({ cwd: f.project, prompt: 'damaged' });
  assert.equal(refused.ok, false); assert.match(refused.error, /regular, unlinked file/);
  assert.equal(calls, 1);
});
