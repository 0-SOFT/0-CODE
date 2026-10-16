import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeBackend, OPENCODE_CONFIG_FILE, openCodeHostGuardEnvironment } from '../../core/backends/opencode.mjs';
import { installProject, upgradeProject } from '../../core/project-installation.mjs';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';
import { hashBytes } from '../../core/installation-transaction.mjs';
import { buildPermissionsBlock } from '../../core/permissions-policy.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';

function tmp() { return mkdtempSync(join(tmpdir(), 'opencode-')); }
const readCfg = d => JSON.parse(readFileSync(join(d, OPENCODE_CONFIG_FILE), 'utf8'));

test('applyPermissions → opencode.json carrying denials from the shared policy', async () => {
  const d = tmp();
  try {
    const r = await new OpenCodeBackend().applyPermissions({ policy: buildPermissionsBlock(), targetDir: d });
    const cfg = readCfg(d);
    assert.equal(r.applied, true, 'the OpenCode mechanism genuinely works — we state the truth');
    assert.deepEqual(r.dropped, [], 'no rule may be lost in translation');
    assert.equal(cfg.permission.bash['*'], 'allow');
    const denials = Object.entries(cfg.permission.bash).filter(([, v]) => v === 'deny');
    assert.equal(denials.length, 0, 'runtime decisions belong to the shared hook');
  } finally { await cleanupTempDir(d); }
});

test('applyPermissions preserves unrelated configuration keys', async () => {
  const d = tmp();
  try {
    writeFileSync(join(d, OPENCODE_CONFIG_FILE), JSON.stringify({ model: 'own/model', instructions: ['x.md'] }));
    await new OpenCodeBackend().applyPermissions({ policy: buildPermissionsBlock(), targetDir: d });
    const cfg = readCfg(d);
    assert.equal(cfg.model, 'own/model', 'unrelated settings must not be overwritten');
    assert.deepEqual(cfg.instructions, ['x.md']);
    assert.ok(cfg.permission, 'our block was added');
  } finally { await cleanupTempDir(d); }
});

test('installInstructions → AGENTS.md', async () => {
  const d = tmp();
  try {
    const r = await new OpenCodeBackend().installInstructions({ targetDir: d, content: 'LOOP RULES' });
    assert.match(readFileSync(join(d, 'AGENTS.md'), 'utf8'), /<!-- BEGIN AUTONOMOUS FRAMEWORK -->\nLOOP RULES\n<!-- END AUTONOMOUS FRAMEWORK -->/);
    assert.ok(r.written[0].endsWith('AGENTS.md'));
  } finally { await cleanupTempDir(d); }
});

test('registerMcp → an mcp block in opencode.json, non-portable servers skipped', async () => {
  const d = tmp();
  try {
    const manifest = { servers: [
      { name: 'a', command: 'cmd', args: ['${X}'], env: { K: '${Y}' } },
      { name: 'connector', source: 'claude_ai' },
      { name: 'ns', needs_setup: true },
    ] };
    const r = await new OpenCodeBackend().registerMcp(manifest, { X: 'xx', Y: 'yy' }, { targetDir: d });
    const cfg = readCfg(d);
    assert.deepEqual(r.registered, ['a']);
    assert.ok(r.skipped.includes('connector') && r.skipped.includes('ns'));
    assert.deepEqual(cfg.mcp.a.command, ['cmd', 'xx']);
    assert.equal(cfg.mcp.a.environment.K, 'yy');
    assert.equal(cfg.mcp.connector, undefined);
  } finally { await cleanupTempDir(d); }
});

// v1.24.0. Measured with `opencode mcp list` on the old generator: every remote server came out as
// `type: local` with `command: [""]` and failed with "The argument 'file' cannot be empty", and
// servers whose secret was absent were registered with an empty key to fail on start. The remote
// shape below was checked live against a local echo server: the header arrived.
test('registerMcp: a remote server becomes type remote with its url and headers', async () => {
  const d = tmp();
  try {
    const manifest = { servers: [
      { name: 'gh', type: 'http', url: 'https://api.example/mcp',
        headers: { Authorization: 'Bearer ${TOKEN}' }, secrets: ['TOKEN'] },
      { name: 'open', type: 'http', url: 'https://open.example/mcp' },
    ] };
    const r = await new OpenCodeBackend().registerMcp(manifest, { TOKEN: 'tkn' }, { targetDir: d });
    const cfg = readCfg(d);
    assert.deepEqual(r.registered.sort(), ['gh', 'open']);
    assert.deepEqual(cfg.mcp.gh, { type: 'remote', url: 'https://api.example/mcp',
      headers: { Authorization: 'Bearer tkn' }, enabled: true });
    assert.deepEqual(cfg.mcp.open, { type: 'remote', url: 'https://open.example/mcp', enabled: true },
      'no headers declared — none written, and no command at all');
  } finally { await cleanupTempDir(d); }
});

test('registerMcp: a missing secret skips generation and preserves existing project entries', async () => {
  const d = tmp();
  try {
    // A matching name or empty key does not prove that a server belongs to the framework.
    writeFileSync(join(d, OPENCODE_CONFIG_FILE), JSON.stringify({ mcp: {
      cap: { type: 'local', command: ['cap-mcp'], environment: { KEY: '' }, enabled: true },
      mine: { type: 'local', command: ['my-own'], enabled: true },
    } }));
    const manifest = { servers: [
      { name: 'cap', command: 'cap-mcp', env: { KEY: '${CAP_KEY}' }, secrets: ['CAP_KEY'] },
      { name: 'gh', type: 'http', url: 'https://api.example/mcp',
        headers: { Authorization: 'Bearer ${TOKEN}' }, secrets: ['TOKEN'] },
    ] };
    const r = await new OpenCodeBackend().registerMcp(manifest, { CAP_KEY: '' }, { targetDir: d });
    const cfg = readCfg(d);
    assert.deepEqual(r.registered, []);
    assert.deepEqual(r.skipped.sort(), ['cap', 'gh']);
    assert.match(r.reasons.cap, /CAP_KEY/);
    assert.match(r.reasons.gh, /TOKEN/);
    assert.deepEqual(cfg.mcp.cap.command, ['cap-mcp'], 'an entry without ownership evidence is preserved');
    assert.deepEqual(cfg.mcp.mine.command, ['my-own'], 'a server the manifest does not name is not ours to touch');
  } finally { await cleanupTempDir(d); }
});

test('registerMcp: in a cloud session a remote server is pointed to a connector, a local one is kept', async () => {
  const d = tmp();
  try {
    const manifest = { servers: [
      { name: 'remote', type: 'http', url: 'https://r.example/mcp' },
      { name: 'local', command: 'srv' },
    ] };
    const r = await new OpenCodeBackend().registerMcp(manifest, { CLAUDE_CODE_REMOTE: 'true' }, { targetDir: d });
    assert.deepEqual(r.registered, ['local']);
    assert.match(r.reasons.remote, /connector/);
  } finally { await cleanupTempDir(d); }
});

test('guardCommand and id: the Backend port contract is honoured', async () => {
  const b = new OpenCodeBackend();
  assert.equal(b.id, 'opencode');
  assert.ok(b.guardCommand('rm -rf /'));
  assert.equal(b.guardCommand('git status'), null);
  const r = await b.runTurn({ prompt: '' });
  assert.equal(r.ok, false, 'an empty prompt is an honest error, not a process launch');
});

// Found by the LIVE v1.3.0 acceptance run: the agent ran `git clean -fd .` — an ordinary cleanup —
// and wiped the untracked opencode.json and the arbiter plugin, i.e. it disarmed itself and kept
// working. Protection that can be silently deleted is not protection.
test('ensureReady restores a wiped arbiter plugin', async () => {
  const d = tmp();
  try {
    const b = new OpenCodeBackend();
    await b.ensureReady({ cwd: d, home: join(d, 'test-home') });                       // the initial install
    const plugin = join(d, '.opencode', 'plugins', 'safety-guard.js');
    assert.ok(existsSync(plugin), 'the plugin must appear');
    rmSync(plugin);                                        // simulate `git clean -fd`
    const r = await b.ensureReady({ cwd: d, home: join(d, 'test-home') });
    assert.ok(existsSync(plugin), 'the plugin must be restored before the turn');
    assert.ok(r.restored.some(x => x.includes('safety-guard')));
    const text = readFileSync(plugin, 'utf8');
    assert.match(text, /decidePermission/, 'the mode comes from the shared decision');
  } finally { await cleanupTempDir(d); }
});

test('ensureReady restores a wiped permission configuration', async () => {
  const d = tmp();
  try {
    const b = new OpenCodeBackend();
    const policy = { deny: ['Bash(owner-protected-command)'] };
    await b.ensureReady({ cwd: d, home: join(d, 'test-home'), policy });
    rmSync(join(d, OPENCODE_CONFIG_FILE));
    const r = await b.ensureReady({ cwd: d, home: join(d, 'test-home'), policy });
    const cfg = JSON.parse(readFileSync(join(d, OPENCODE_CONFIG_FILE), 'utf8'));
    assert.equal(cfg.permission.bash['*'], 'allow');
    assert.ok(Object.values(cfg.permission.bash).includes('deny'), 'the denials must come back');
    assert.ok(r.restored.some(x => x.includes(OPENCODE_CONFIG_FILE)));
  } finally { await cleanupTempDir(d); }
});

test('ensureReady is idempotent: it touches nothing when everything is in place', async () => {
  const d = tmp();
  try {
    const b = new OpenCodeBackend();
    await b.ensureReady({ cwd: d, home: join(d, 'test-home') });
    const r = await b.ensureReady({ cwd: d, home: join(d, 'test-home') });
    assert.deepEqual(r.restored, [], 'a repeated call must restore nothing');
  } finally { await cleanupTempDir(d); }
});

// The v1.4.0 audit caught two holes at once: the agent deleted the plugin FROM THE PROJECT and
// rewrote the permission.bash values to allow while leaving the block itself in place — the old
// check missed that because it looked at the presence of the block rather than its contents.
test('ensureReady installs a global plugin outside project cleanup', async () => {
  const d = tmp(); const home = tmp();
  try {
    const r = await new OpenCodeBackend().ensureReady({ cwd: d, home });
    const globalPlugin = join(home, '.config', 'opencode', 'plugins', 'safety-guard.js');
    assert.ok(existsSync(globalPlugin), 'the main line of defence lives outside the working directory');
    assert.ok(r.restored.some(x => x.includes('safety-guard')));
    assert.match(readFileSync(globalPlugin, 'utf8'), /decidePermission/);
  } finally { await Promise.all([d, home].map(cleanupTempDir)); }
});

// Execute the generated plugin in a fresh process: imports cached by the host must not mask
// the changed detector the engine would actually load. No command is executed by these hooks.
function checkFreshPlugin(home) {
  const url = pathToFileURL(join(home, '.config', 'opencode', 'plugins', 'safety-guard.js')).href;
  const program = `const {SafetyGuard}=await import(${JSON.stringify(url)});
    const hook=(await SafetyGuard())["tool.execute.before"];
    const blocked=async command=>{try{await hook({}, {args:{command}});return false;}catch{return true;}};
    console.log(JSON.stringify({dangerous:await blocked('git push --force'),routine:await blocked('echo hello')}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program],
    { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('ensureReady restores modified global and local plugins to working protection', async () => {
  const d = tmp(), home = tmp();
  try {
    const backend = new OpenCodeBackend();
    await backend.ensureReady({ cwd: d, home });
    const global = join(home, '.config', 'opencode', 'plugins', 'safety-guard.js');
    const local = join(d, '.opencode', 'plugins', 'safety-guard.js');
    const empty = 'export const SafetyGuard = async () => ({"tool.execute.before":async () => {}});\n';
    writeFileSync(global, empty); writeFileSync(local, empty);
    assert.equal(checkFreshPlugin(home).dangerous, false, 'positive control: the edited plugin is ineffective');
    await backend.ensureReady({ cwd: d, home });
    assert.deepEqual(checkFreshPlugin(home), { dangerous: true, routine: false });
    assert.equal(readFileSync(local, 'utf8'), readFileSync(global, 'utf8'));
  } finally { await Promise.all([d, home].map(cleanupTempDir)); }
});

test('ensureReady uses the host snapshot after the original detector changes', async () => {
  const d = tmp(), home = tmp();
  try {
    const source = join(d, 'safety.mjs');
    writeFileSync(source, readFileSync(new URL('../../core/safety.mjs', import.meta.url)));
    const backend = new OpenCodeBackend({ safetyPath: source });
    const ready = await backend.ensureReady({ cwd: d, home, safetyPath: source });
    writeFileSync(source, 'export const destructiveReason = () => null;\n');
    await backend.ensureReady({ cwd: d, home, safetyPath: source });
    assert.deepEqual(checkFreshPlugin(home), { dangerous: true, routine: false });
    const inactive = readFileSync(ready.safetyFile, 'utf8').replace(
      'export function destructiveVerdict(command, { advisory = false } = {}) {',
      'export function destructiveVerdict(command, { advisory = false } = {}) { return null;');
    writeFileSync(ready.safetyFile, inactive);
    assert.equal(checkFreshPlugin(home).dangerous, false, 'positive control: changed external rules lose protection');
    await backend.ensureReady({ cwd: d, home, safetyPath: source });
    assert.deepEqual(checkFreshPlugin(home), { dangerous: true, routine: false });
  } finally { await Promise.all([d, home].map(cleanupTempDir)); }
});

test('ensureReady refuses a directory in place of a global plugin without touching its contents', async () => {
  const d = tmp(), home = tmp();
  try {
    const backend = new OpenCodeBackend();
    await backend.ensureReady({ cwd: d, home });
    const global = join(home, '.config', 'opencode', 'plugins', 'safety-guard.js');
    rmSync(global); mkdirSync(global);
    const other = join(global, 'person-owned.txt');
    writeFileSync(other, 'preserve these bytes');
    await assert.rejects(backend.ensureReady({ cwd: d, home }), /regular|file|link/i);
    assert.equal(readFileSync(other, 'utf8'), 'preserve these bytes');
  } finally { await Promise.all([d, home].map(cleanupTempDir)); }
});

test('ensureReady restores denials after the agent rewrote them to allow', async () => {
  const d = tmp(); const home = tmp();
  try {
    const b = new OpenCodeBackend();
    const policy = { deny: ['Bash(owner-protected-command)'] };
    await b.ensureReady({ cwd: d, home, policy });
    // simulate disarming: the block is in place but every value says allow
    const cfg = JSON.parse(readFileSync(join(d, OPENCODE_CONFIG_FILE), 'utf8'));
    for (const k of Object.keys(cfg.permission.bash)) cfg.permission.bash[k] = 'allow';
    writeFileSync(join(d, OPENCODE_CONFIG_FILE), JSON.stringify(cfg, null, 2));
    const r = await b.ensureReady({ cwd: d, home, policy });
    const after = JSON.parse(readFileSync(join(d, OPENCODE_CONFIG_FILE), 'utf8')).permission.bash;
    assert.ok(Object.values(after).includes('deny'), 'the denials must come back');
    assert.ok(r.restored.some(x => x.includes(OPENCODE_CONFIG_FILE)));
  } finally { await Promise.all([d, home].map(cleanupTempDir)); }
});
test('a foreign local or global guard refuses before any framework artifact is written',async()=>{
  for(const global of [false,true]) {
    const d=tmp(),home=tmp(),own='export const OwnerGuard = async () => ({});\n';
    try {
      const path=global?join(home,'.config/opencode/plugins/safety-guard.js'):join(d,'.opencode/plugins/safety-guard.js');
      mkdirSync(new URL('.',pathToFileURL(path)),{recursive:true});writeFileSync(path,own);
      await assert.rejects(new OpenCodeBackend().ensureReady({cwd:d,home}),/Unowned/);
      assert.equal(readFileSync(path,'utf8'),own);
      assert.equal(existsSync(join(home,'.config/opencode/0-code-guard/safety.mjs')),false);
      assert.equal(existsSync(join(d,'opencode.json')),false);
      assert.equal(existsSync(join(d,'.opencode/0-code-guard-ownership.json')),false);
    } finally {await cleanupTempDir(d);await cleanupTempDir(home);}
  }
});
test('an installed project keeps host guard snapshots in ignored runtime and preserves the native project and profile files',async()=>{
  const d=tmp(),home=tmp(),own='export const OwnerGuard = async () => ({});\n';
  const native='{"model":"owner/model","permission":{"bash":{"owner-only":"deny"}},"owner":"preserve"}\n';
  try {
    writeFileSync(join(d,'opencode.json'),native);
    const installed=installProject(d,{config:{engines:['opencode'],modules:Object.fromEntries(Object.keys(PROJECT_MODULES).map(id=>[id,false]))}});
    for(const file of [join(d,'.opencode/plugins/safety-guard.js'),join(home,'.config/opencode/plugins/safety-guard.js')]) {
      mkdirSync(new URL('.',pathToFileURL(file)),{recursive:true});writeFileSync(file,own);
    }
    const backend=new OpenCodeBackend(),ready=await backend.ensureReady({cwd:d,home});
    assert.ok(ready.safetyFile.startsWith(join(d,'.0-code/run')));
    assert.equal(existsSync(join(home,'.config/opencode/0-code-guard')),false);
    assert.equal(readFileSync(join(d,'opencode.json'),'utf8'),native);
    assert.equal(readFileSync(join(d,'.opencode/plugins/safety-guard.js'),'utf8'),own);
    assert.equal(readFileSync(join(home,'.config/opencode/plugins/safety-guard.js'),'utf8'),own);
    for(const entry of installed.receipt.files) assert.equal(hashBytes(readFileSync(join(d,entry.path))),entry.hash,entry.path);
    const program='const {SafetyGuard}=await import('+JSON.stringify(pathToFileURL(ready.hostPlugin).href)+'); const hook=(await SafetyGuard())["tool.execute.before"]; let denied=false; try{await hook({tool:"Bash"},{args:{command:"git push --force"}});}catch{denied=true;} console.log(JSON.stringify({denied}));';
    const checked=spawnSync(process.execPath,['--input-type=module','-e',program],{encoding:'utf8',windowsHide:true,env:{...process.env,SAFETY_GUARD_MODE:'arbiter'}});
    assert.equal(checked.status,0,checked.stderr);assert.deepEqual(JSON.parse(checked.stdout),{denied:true});
    assert.deepEqual((await backend.ensureReady({cwd:d,home})).restored,[]);
    writeFileSync(ready.hostPlugin,'export const SafetyGuard = async () => ({});\n');
    writeFileSync(join(d,'.opencode/plugins/0-code-safety-guard.js'),'export const SafetyGuard = async () => ({});\n');
    await new OpenCodeBackend().ensureReady({cwd:d,home}); // Persistent ownership works across backend instances.
    assert.equal(hashBytes(readFileSync(join(d,'.opencode/plugins/0-code-safety-guard.js'))),installed.receipt.files.find(entry=>entry.path.endsWith('0-code-safety-guard.js')).hash);
    assert.equal(spawnSync(process.execPath,['--input-type=module','-e',program],{encoding:'utf8',windowsHide:true,env:{...process.env,SAFETY_GUARD_MODE:'arbiter'}}).stdout,checked.stdout);
    assert.equal(upgradeProject(d).result.changed,0);
  } finally {await cleanupTempDir(d);await cleanupTempDir(home);}
});
test('host plugin delivery preserves inline settings and rejects malformed native configuration without reflecting values',()=>{
  const original={model:'owner/model',mcp:{private:{environment:{TOKEN:'private-fixture'}}},plugin:['owner-plugin'],permission:{bash:{'*':'ask'}}};
  const env={OPENCODE_CONFIG_CONTENT:JSON.stringify(original),SAFETY_GUARD_MODE:'confirm'};
  const merged=openCodeHostGuardEnvironment(env,join(tmpdir(),'host-plugin.mjs'),{'owner-protected':'deny'});
  const config=JSON.parse(merged.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.mcp,original.mcp);assert.equal(config.model,original.model);assert.equal(config.permission.bash['*'],'ask');
  assert.equal(config.permission.bash['owner-protected'],'deny');assert.equal(config.plugin[0],'owner-plugin');
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT),original);
  assert.equal(JSON.parse(openCodeHostGuardEnvironment(merged,join(tmpdir(),'host-plugin.mjs')).OPENCODE_CONFIG_CONTENT).plugin.length,2);
  for(const value of ['{"private-fixture"', '{"plugin":"private-fixture"}', 'null']) assert.throws(()=>openCodeHostGuardEnvironment({OPENCODE_CONFIG_CONTENT:value},'plugin'),error=>!error.message.includes('private-fixture'));
});
test('an installed runtime collision or malformed inline configuration refuses without touching a profile or pointer',async()=>{
  const d=tmp(),home=tmp();
  try {
    installProject(d,{config:{engines:['opencode'],modules:Object.fromEntries(Object.keys(PROJECT_MODULES).map(id=>[id,false]))}});
    const file=join(d,'.0-code/run/opencode-guard/safety.mjs');mkdirSync(new URL('.',pathToFileURL(file)),{recursive:true});writeFileSync(file,'foreign runtime data');
    await assert.rejects(new OpenCodeBackend().ensureReady({cwd:d,home}),/Unowned/);
    assert.equal(readFileSync(file,'utf8'),'foreign runtime data');assert.equal(existsSync(join(home,'.config')),false);
    assert.equal(existsSync(join(d,'.0-code/run/opencode-guard/ownership.json')),false);
    rmSync(file);
    await assert.rejects(new OpenCodeBackend({env:{...process.env,OPENCODE_CONFIG_CONTENT:'{"secret-fixture"'}}).ensureReady({cwd:d,home}),/inline configuration is invalid/);
    assert.equal(existsSync(file),false);assert.equal(existsSync(join(home,'.config')),false);
  } finally {await cleanupTempDir(d);await cleanupTempDir(home);}
});

// v1.5.0 — the spending guard INSIDE a turn. A deferred limitation from the report: the cost was
// only counted once the turn finished, so on half-hour turns the cap was powerless and an
// overrun was discovered after the fact. Now the cost is read from the stream on the fly.
test('spending watcher: accumulates step costs and asks to abort once the limit is passed', async () => {
  const { makeBudgetWatcher } = await import('../../core/backends/opencode.mjs');
  const watcher = makeBudgetWatcher(1.0);
  const step = (c) => JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', cost: c } }) + '\n';
  assert.equal(watcher.onChunk(step(0.3)), undefined, 'within the limit the turn is left alone');
  assert.equal(watcher.onChunk(step(0.4)), undefined);
  assert.ok(Math.abs(watcher.spent() - 0.7) < 1e-9);
  assert.equal(watcher.onChunk(step(0.5)), 'abort', 'exceeding the limit must abort the turn');
});

test('spending watcher: with no limit it counts nothing and interferes with nothing', async () => {
  const { makeBudgetWatcher } = await import('../../core/backends/opencode.mjs');
  for (const limit of [undefined, null, 0, -5]) {
    const watcher = makeBudgetWatcher(limit);
    assert.equal(watcher.onChunk(JSON.stringify({ type: 'step_finish', part: { cost: 99 } }) + '\n'), undefined);
    assert.equal(watcher.spent(), 0);
  }
});

test('spending watcher: an incomplete line in the stream does not break parsing', async () => {
  const { makeBudgetWatcher } = await import('../../core/backends/opencode.mjs');
  const watcher = makeBudgetWatcher(1.0);
  const full = JSON.stringify({ type: 'step_finish', part: { cost: 0.6 } }) + '\n';
  watcher.onChunk(full.slice(0, 20));          // the first half of the event
  assert.equal(watcher.spent(), 0, 'while a line is incomplete there is nothing to count');
  watcher.onChunk(full.slice(20));             // the remainder
  assert.ok(Math.abs(watcher.spent() - 0.6) < 1e-9, 'a reassembled line must be counted');
});
