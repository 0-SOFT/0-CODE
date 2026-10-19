import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InstallationPlan, applyInstallationPlan, hashBytes, recoverInstallation, transactionIO } from '../../core/installation-transaction.mjs';
import { installProject, planProjectInstallation, readInstallationReceipt, recoverProjectInstallation, upgradeProject } from '../../core/project-installation.mjs';
import { migrateProject, planProjectMigration } from '../../core/project-migration.mjs';
import { DOCUMENT_DEFAULTS, LEGACY_DOCUMENT_DEFAULTS, normalizeProjectConfig } from '../../core/project-config.mjs';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';
import { main } from '../../tools/0code.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
import { frameworkSource } from '../helpers/framework-source.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const scratch = join(dirname(repository.replace(/[\\/]$/, '')), 'scratch', 'tmp');
const internal = path => path === '.0-code' || path.startsWith('.0-code/');
const state = '---\nschema_version: 1\nproject_name: fixture\ncurrent_stage: 0\ncurrent_version: "0.0.1"\niteration: 0\nrunning_jobs: []\n---\n\nOwner journal\r\n';
const selectedTools = ['skills/api-design', 'agents/architect', 'commands/code-review', 'rules/common/coding-style', 'mcp/context7'];
function configuration(extra = {}) {
  return normalizeProjectConfig({ engines: ['claude'], documents: DOCUMENT_DEFAULTS,
    modules: { ...Object.fromEntries(Object.keys(PROJECT_MODULES).map(id => [id, false])), audits: true },
    instructions: { claude: 'session-hook', claude_settings: '.0-code/claude/settings.json' }, ...extra });
}
function fixture(t, files = {}) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'session-installation-'));
  t.after(() => cleanupTempDir(root));
  const put = (path, bytes) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof bytes === 'string' || Buffer.isBuffer(bytes) ? bytes : JSON.stringify(bytes));
  };
  for (const [path, bytes] of Object.entries(files)) put(path, bytes);
  return { root, put };
}
function snapshot(root, { external = false } = {}) {
  const visit = (path = '') => readdirSync(join(root, path), { withFileTypes: true }).flatMap(entry => {
    const child = path ? path + '/' + entry.name : entry.name;
    if (external && internal(child)) return [];
    const stat = lstatSync(join(root, child));
    return entry.isDirectory() ? [[child, 'directory', stat.mode & 0o777], ...visit(child)]
      : [[child, 'file', stat.mode & 0o777, hashBytes(readFileSync(join(root, child)))]];
  });
  return visit().sort(([a], [b]) => a.localeCompare(b, 'en'));
}
// Observe real mutation attempts, including transient staging and directory creation.
// Restoring builtin exports keeps other tests independent of this instrumentation.
function beginWriteObservation(root) {
  const calls = [], originals = new Map();
  const methods = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmdirSync', 'unlinkSync', 'renameSync',
    'chmodSync', 'truncateSync', 'copyFileSync', 'linkSync', 'symlinkSync', 'rmSync', 'openSync'];
  for (const name of methods) {
    const original = fs[name]; originals.set(name, original);
    fs[name] = (...args) => {
      const indexes = ['renameSync', 'linkSync'].includes(name) ? [0, 1] : ['copyFileSync', 'symlinkSync'].includes(name) ? [1] : [0];
      const reading = name === 'openSync' && (typeof args[1] === 'string' ? /^r(?:s)?$/.test(args[1]) : args[1] === fs.constants.O_RDONLY);
      if (!reading) for (const index of indexes) if (typeof args[index] === 'string') {
        const path = relative(root, resolve(args[index])).replaceAll('\\', '/');
        calls.push({ method: name, path: path === '..' || path.startsWith('../') || isAbsolute(path) ? resolve(args[index]) : path });
      }
      return original(...args);
    };
  }
  syncBuiltinESMExports();
  return { calls, restore() { for (const [name, original] of originals) fs[name] = original; syncBuiltinESMExports(); } };
}
function observeWrites(root, action) {
  const observer = beginWriteObservation(root);
  try { return { value: action(), calls: observer.calls }; }
  finally { observer.restore(); }
}
async function observeWritesAsync(root, action) {
  const observer = beginWriteObservation(root);
  try { return { value: await action(), calls: observer.calls }; }
  finally { observer.restore(); }
}
function assertInternalPlan(plan) {
  assert.ok(Array.isArray(plan.allowedPaths), 'strict plans retain a write boundary');
  assert.deepEqual(plan.summary().filter(entry => !internal(entry.path)), []);
}
function applyInternal(root, action) {
  const before = snapshot(root, { external: true }), observed = observeWrites(root, action);
  assert.deepEqual(observed.calls.filter(call => !internal(call.path)), []);
  assert.deepEqual(snapshot(root, { external: true }), before);
  return observed.value;
}
function refusesWithoutWrites(root, action, pattern = /authorized|isolat|session-hook|cleanup|previous.*mode/i) {
  const before = snapshot(root), observed = observeWrites(root, () => assert.throws(action, pattern));
  assert.deepEqual(observed.calls, [], 'refusal precedes every filesystem mutation');
  assert.deepEqual(snapshot(root), before);
}
const ownerFiles = {
  'CLAUDE.md': '# Owner instruction\r\nExact spaces.  \r\n',
  '.claude/settings.json': '{ "env": {"OWNER":"keep"}, "hooks":{"Stop":[{"hooks":[{"type":"command","command":"node owner-stop.mjs"}]}]} }\r\n',
  '.claude/settings.local.json': '{"permissions":{"ask":["Bash(*)"]}}\r\n',
  '.claude/skills/owner/SKILL.md': '---\nname: owner\ndescription: Owner skill\n---\nKeep owner instructions.\n',
  '.claude/commands/owner.md': 'Owner command $ARGUMENTS.\r\n',
  '.claude/agents/owner.md': '---\nname: owner\ndescription: Owner agent\nmodel: owner-model\n---\nOwner agent instructions.\n',
  '.claude/rules/owner.md': '# Owner rules\r\n',
  '.mcp.json': '{"mcpServers":{"owner":{"command":"node","args":["owner-mcp.mjs"]}}}\r\n',
  'source/main.py': 'print("owner")\r\n',
};

for (const item of [
  { name: 'audits enabled', extra: {} },
  { name: 'audits disabled', extra: { modules: Object.fromEntries(Object.keys(PROJECT_MODULES).map(id => [id, false])) } },
  { name: 'all project-toolset families', extra: { modules: { toolset: true, audits: true, session_logs: false, token_usage: false, mcp_catalog: true },
    toolset: { scope: 'project', defaults: false, enable: selectedTools } } },
]) test('strict install and upgrades keep all planned and actual writes internal: ' + item.name, t => {
  const f = fixture(t, ownerFiles), { source } = frameworkSource(t), config = configuration(item.extra);
  f.put('.claude/empty-owner/.keep', '');
  mkdirSync(join(f.root, 'empty-owner-directory'));
  const before = snapshot(f.root), preview = planProjectInstallation(f.root, { source, config });
  assertInternalPlan(preview.plan); assert.deepEqual(snapshot(f.root), before);
  assert.ok(applyInternal(f.root, () => installProject(f.root, { source, config })).result.changed > 0);
  assert.equal(readInstallationReceipt(f.root).files.some(entry => !internal(entry.path)), false);
  assertInternalPlan(planProjectInstallation(f.root, { source, upgrade: true }).plan);
  assert.equal(applyInternal(f.root, () => installProject(f.root, { source })).result.changed, 0);
  assert.equal(applyInternal(f.root, () => upgradeProject(f.root, { source })).result.changed, 0);
});

test('strict module upgrades remove internal audit sources without touching native owner tools', t => {
  const f = fixture(t, ownerFiles), { source } = frameworkSource(t), config = configuration();
  applyInternal(f.root, () => installProject(f.root, { source, config }));
  const disabled = configuration({ modules: Object.fromEntries(Object.keys(PROJECT_MODULES).map(id => [id, false])) });
  const preview = planProjectInstallation(f.root, { source, config: disabled, upgrade: true }); assertInternalPlan(preview.plan);
  assert.ok(preview.plan.summary().some(entry => entry.operation === 'remove' && entry.path === '.0-code/commands/productionaudit.md'));
  applyInternal(f.root, () => upgradeProject(f.root, { source, config: disabled }));
  assert.equal(existsSync(join(f.root, '.0-code/commands/productionaudit.md')), false);
  assert.equal(applyInternal(f.root, () => upgradeProject(f.root, { source })).result.changed, 0);
});

test('strict CLI install with user-scope toolset never plans or applies a machine installation', async t => {
  const f = fixture(t, { ...ownerFiles, 'profiles/claude/settings.json': '{"env":{"OWNER":"machine"}}\r\n',
    'profiles/codex/config.toml': '# Owner machine profile\r\n', 'profiles/xdg/opencode/opencode.json': '{"owner":true}\r\n' });
  const { source } = frameworkSource(t), config = configuration({ modules: { toolset: true, audits: true,
    session_logs: false, token_usage: false, mcp_catalog: false }, toolset: { scope: 'user', defaults: false, enable: ['skills/api-design'] } });
  f.put('selected-config.json', config);
  const environment = { ZERO_CODE_USER_DIR: join(f.root, 'profiles/pool'), CLAUDE_CONFIG_DIR: join(f.root, 'profiles/claude'),
    CODEX_HOME: join(f.root, 'profiles/codex'), XDG_CONFIG_HOME: join(f.root, 'profiles/xdg') };
  const saved = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    const argv = ['install', '--project', f.root, '--config', join(f.root, 'selected-config.json'), '--source', source, '--json'];
    const before = snapshot(f.root), external = snapshot(f.root, { external: true });
    for (const dryRun of [true, false]) {
      let output = '';
      const observed = await observeWritesAsync(f.root, () => main([...argv, ...(dryRun ? ['--dry-run'] : [])], text => { output += text; }));
      assert.equal(Object.hasOwn(observed.value, 'machinePlan'), false);
      assert.deepEqual(JSON.parse(output), observed.value);
      assert.ok(observed.value.plan.every(entry => internal(entry.path)));
      assert.deepEqual(observed.calls.filter(call => !internal(call.path)), []);
      assert.deepEqual(snapshot(f.root, { external: true }), external);
      if (dryRun) { assert.deepEqual(observed.calls, []); assert.deepEqual(snapshot(f.root), before); }
      else assert.ok(observed.value.changed > 0);
    }
  } finally {
    for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

for (const mode of ['project-file', 'session-hook']) test('ordinary ' + mode + ' retains native Claude installation targets', t => {
  const f = fixture(t), { source } = frameworkSource(t);
  const config = configuration({ instructions: { claude: mode, claude_settings: '.claude/settings.json' } });
  const prepared = planProjectInstallation(f.root, { source, config }), paths = prepared.plan.summary().map(entry => entry.path);
  for (const path of ['.claude/settings.json', '.claude/skills/0-code-orchestrator/SKILL.md',
    '.claude/commands/0-code-productionaudit.md', '.claude/commands/0-code-productionauditloop.md']) assert.ok(paths.includes(path), path);
  assert.equal(paths.includes('CLAUDE.md'), mode === 'project-file');
  installProject(f.root, { source, config });
  assert.equal(upgradeProject(f.root, { source }).result.changed, 0);
});

test('selected Codex and OpenCode allow their own external locations without enabling Claude surfaces', t => {
  const f = fixture(t), { source } = frameworkSource(t), config = configuration({ engines: ['claude', 'codex', 'opencode'] });
  const prepared = planProjectInstallation(f.root, { source, config });
  const external = prepared.plan.summary().filter(entry => !internal(entry.path)).map(entry => entry.path);
  assert.ok(external.includes('AGENTS.md'));
  assert.ok(external.some(path => path.startsWith('.agents/')));
  assert.ok(external.some(path => path.startsWith('.opencode/')));
  assert.ok(external.every(path => path === 'AGENTS.md' || /^(?:\.agents|\.codex|\.opencode)\//.test(path) || /^opencode\.jsonc?$/.test(path)), JSON.stringify(external));
  installProject(f.root, { source, config });
  assert.equal(existsSync(join(f.root, '.claude')), false); assert.equal(existsSync(join(f.root, '.mcp.json')), false);
  assert.equal(upgradeProject(f.root, { source }).result.changed, 0);
  refusesWithoutWrites(f.root, () => prepared.plan.change('.claude/rules/unselected.md', 'Unselected Claude write'));
});

test('explicit external state and roadmap authorize their exact files without opening their directories', t => {
  const f = fixture(t, { 'work/owner.txt': 'Keep sibling bytes' }), { source } = frameworkSource(t);
  const config = configuration({ documents: { state: { path: 'work/status.md' }, roadmap: { path: 'work/plan.md' } } });
  const prepared = planProjectInstallation(f.root, { source, config });
  assert.deepEqual(prepared.plan.summary().filter(entry => !internal(entry.path)).map(entry => entry.path).sort(), ['work/plan.md', 'work/status.md']);
  refusesWithoutWrites(f.root, () => prepared.plan.change('work/unselected.md', 'Sibling is not authorized'));
  installProject(f.root, { source, config }); assert.equal(readFileSync(join(f.root, 'work/owner.txt'), 'utf8'), 'Keep sibling bytes');
  assert.equal(upgradeProject(f.root, { source }).result.changed, 0);
});

function adoption(t) {
  const config = configuration(), f = fixture(t, { ...ownerFiles,
    '.0-code/config.json': JSON.stringify(config), '.0-code/AGENT.md': 'Previous generated guide\r\n',
    '.0-code/bin/owner-launcher': '#!/bin/sh\nclaude --settings .0-code/claude/settings.json\n',
    '.0-code/claude/settings.json': '{"env":{"OWNER":"keep"},"permissions":{"deny":["Bash(git push:*)"]}}\r\n',
    '.0-code/claude/mcp.json': '{"mcpServers":{}}\r\n', '.0-code/claude/system-prompt.md': 'Exact owner system prompt\r\n',
    '.0-code/docs/STATE.md': state, '.0-code/docs/ROADMAP.md': '# Owner roadmap\r\n' });
  const paths = ['.0-code/config.json', '.0-code/AGENT.md', '.0-code/bin/owner-launcher', '.0-code/claude/settings.json',
    '.0-code/claude/mcp.json', '.0-code/claude/system-prompt.md'];
  const adoptionManifest = { schema_version: 1, files: paths.map(path => ({ path, sha256: hashBytes(readFileSync(join(f.root, path))),
    action: path.includes('/bin/') || path.includes('/claude/') ? 'preserve' : 'replace' })) };
  return { ...f, config, adoptionManifest };
}
test('reviewed internal adoption and repeated migration preserve every external file and directory', t => {
  const f = adoption(t), { source } = frameworkSource(t), options = { source, config: f.config, adoptionManifest: f.adoptionManifest };
  const retained = ['.0-code/bin/owner-launcher', '.0-code/claude/mcp.json', '.0-code/claude/system-prompt.md',
    '.0-code/docs/STATE.md', '.0-code/docs/ROADMAP.md'].map(path => [path, readFileSync(join(f.root, path))]);
  const before = snapshot(f.root), prepared = planProjectMigration(f.root, options); assertInternalPlan(prepared.plan);
  assert.deepEqual(snapshot(f.root), before);
  assert.ok(applyInternal(f.root, () => migrateProject(f.root, options)).result.changed > 0);
  for (const [path, bytes] of retained) assert.deepEqual(readFileSync(join(f.root, path)), bytes, path);
  assert.equal(applyInternal(f.root, () => upgradeProject(f.root, { source })).result.changed, 0);
  assert.equal(applyInternal(f.root, () => migrateProject(f.root, options)).result.changed, 0);
});

function internalLegacy(t) {
  const framework = frameworkSource(t), config = configuration();
  const f = fixture(t, { '.0-code/config.json': JSON.stringify(config), '.0-code/docs/STATE.md': state,
    '.0-code/docs/ROADMAP.md': '# Owner roadmap\r\n', '.0-code/legacy-gates.mjs': '// Proven old internal runtime\n' });
  const proofPath = join(framework.source, 'config/legacy-installations.json'), proof = JSON.parse(readFileSync(proofPath));
  const internalEntry = { path: '.0-code/legacy-gates.mjs', hashes: { [hashBytes(readFileSync(join(f.root, '.0-code/legacy-gates.mjs')))]: ['fixture-legacy'] } };
  writeFileSync(proofPath, JSON.stringify({ ...proof, files: [...proof.files, internalEntry] }));
  return { ...f, ...framework, config };
}
test('proved internal legacy migration retains its boundary through copied and appended plans', t => {
  const f = internalLegacy(t), options = { source: f.source, config: f.config };
  const before = snapshot(f.root), prepared = planProjectMigration(f.root, options); assertInternalPlan(prepared.plan);
  assert.ok(prepared.plan.summary().some(entry => entry.path === '.0-code/legacy-gates.mjs' && entry.operation === 'remove'));
  assert.deepEqual(snapshot(f.root), before);
  assert.ok(applyInternal(f.root, () => migrateProject(f.root, options)).result.changed > 0);
  assert.equal(existsSync(join(f.root, '.0-code/legacy-gates.mjs')), false);
  const upgraded = applyInternal(f.root, () => upgradeProject(f.root, { source: f.source }));
  assert.equal(upgraded.result.changed, 0, JSON.stringify(upgraded.plan.summary()));
  assert.equal(applyInternal(f.root, () => migrateProject(f.root, { source: f.source })).result.changed, 0);
});

test('old receipt ownership cannot authorize external Claude cleanup on a strict upgrade', t => {
  const f = fixture(t), { source } = frameworkSource(t);
  installProject(f.root, { source, config: configuration({ instructions: { claude: 'session-hook', claude_settings: '.claude/settings.json' } }) });
  const action = () => upgradeProject(f.root, { source, config: configuration() });
  refusesWithoutWrites(f.root, action, error => {
    assert.match(error.message, /\.claude\/settings\.json/);
    assert.match(error.message, /\.claude\/skills\/0-code-orchestrator\/SKILL\.md/);
    assert.match(error.message, /uninstall|cleanup/i); return true;
  });
});

test('an old receipt directory is not authority to clean a native location in strict mode', t => {
  const f = fixture(t), { source } = frameworkSource(t); installProject(f.root, { source, config: configuration() });
  const receipt = readInstallationReceipt(f.root);
  mkdirSync(join(f.root, '.claude/old-owned-empty'), { recursive: true });
  f.put('.0-code/installation.json', { ...receipt, directories: [...receipt.directories, '.claude/old-owned-empty'] });
  refusesWithoutWrites(f.root, () => upgradeProject(f.root, { source }), /\.claude\/old-owned-empty/);
});

for (const kind of ['legacy code', 'legacy skill', 'legacy settings', 'legacy instructions', 'legacy runtime'])
  test('strict migration refuses ' + kind + ' cleanup before every write', t => {
    const f = internalLegacy(t), options = { source: f.source, config: f.config };
    if (kind === 'legacy code') f.put('core/gates.mjs', f.legacyFiles['core/gates.mjs']);
    if (kind === 'legacy skill') f.put('.claude/skills/orchestrator-wrapper/SKILL.md', f.legacyFiles['.claude/skills/orchestrator-wrapper/SKILL.md']);
    if (kind === 'legacy settings') f.put('.claude/settings.json', f.settings);
    if (kind === 'legacy instructions') f.put('CLAUDE.md', '<!-- BEGIN AUTONOMOUS FRAMEWORK -->\n' +
      f.instructions.replaceAll('__PROJECT_NAME__', 'fixture').replaceAll('__FRAMEWORK_VERSION__', '1.30.0').trimEnd() + '\n<!-- END AUTONOMOUS FRAMEWORK -->');
    if (kind === 'legacy runtime') f.put('docs/.loop-progress', { snapshot: { head: 'owner' }, stagnant: 0, at: new Date().toISOString() });
    refusesWithoutWrites(f.root, () => migrateProject(f.root, options));
  });

function crashJournal(f, variant) {
  const path = variant === 'external target' ? '.claude/rules/old-owned.md' : '.0-code/interrupted.txt';
  const before = Buffer.from('Original before-image\r\n'), after = Buffer.from('Applied interrupted bytes');
  f.put(path, after);
  if (variant === 'external directory') mkdirSync(join(f.root, 'old-external-empty'));
  const journal = { schema_version: 1, missingDirectories: variant === 'external directory' ? ['old-external-empty'] : [],
    ...(variant === 'external guard' ? { cycleLockPaths: ['external-runtime/.loop.lock'] } : {}),
    ...(variant === 'forged authorization' ? { allowedPaths: [{ path: '.claude', recursive: true }] } : {}),
    changes: [{ path, before: before.toString('base64'), beforeHash: hashBytes(before), beforeMode: 0o644, afterHash: hashBytes(after) }] };
  if (variant === 'forged authorization') {
    f.put('.claude/rules/old-owned.md', after);
    journal.changes = [{ ...journal.changes[0], path: '.claude/rules/old-owned.md' }];
  }
  f.put('.0-code/run/installation-transaction.json', journal);
}
for (const variant of ['external target', 'external directory', 'external guard', 'forged authorization'])
  test('automatic recovery cannot bypass strict boundaries through ' + variant, t => {
    const f = fixture(t), { source } = frameworkSource(t); installProject(f.root, { source, config: configuration() });
    crashJournal(f, variant);
    for (const action of [() => recoverInstallation(f.root), () => installProject(f.root, { source }),
      () => upgradeProject(f.root, { source }), () => migrateProject(f.root, { source })]) refusesWithoutWrites(f.root, action);
  });

for (const schemaVersion of [999, 1])
  test('unvalidated document manifests cannot authorize external automatic recovery: schema ' + schemaVersion, t => {
    const f = fixture(t), { source } = frameworkSource(t); installProject(f.root, { source, config: configuration() });
    const before = Buffer.from('{"env":{"OWNER":"original"}}\r\n'), after = Buffer.from('{"env":{"OWNER":"interrupted"}}\n');
    f.put('.claude/settings.json', after);
    f.put('.0-code/run/installation-transaction.json', { schema_version: 1, missingDirectories: [], changes: [{
      path: '.claude/settings.json', before: before.toString('base64'), beforeHash: hashBytes(before), beforeMode: 0o644,
      afterHash: hashBytes(after) }] });
    const options = { source, documentManifest: { schema_version: schemaVersion, files: ['.claude/settings.json'] } };
    for (const action of [() => installProject(f.root, options), () => upgradeProject(f.root, options), () => migrateProject(f.root, options)])
      refusesWithoutWrites(f.root, action, /document|manifest|authorized|isolat|role/i);
  });

for (const checkpoint of ['config published', 'all files published']) for (const operation of ['recover', 'upgrade', 'migrate'])
  test('explicit former config recovers strict relocation after ' + checkpoint + ' through ' + operation, t => {
    const f=fixture(t,ownerFiles),{source}=frameworkSource(t),config=configuration({documents:LEGACY_DOCUMENT_DEFAULTS});
    installProject(f.root,{source,config});
    const before=snapshot(f.root),documentManifest={schema_version:1,files:['docs/STATE.md','docs/ROADMAP.md']};
    const prepared=planProjectInstallation(f.root,{source,upgrade:true,documentManifest});
    const journal={schema_version:1,missingDirectories:transactionIO.missingDirectories(f.root,prepared.plan.changes),
      cycleLockPaths:prepared.plan.cycleLockPaths,changes:prepared.plan.changes.map(entry=>({path:entry.path,
        before:entry.before===null?null:entry.before.toString('base64'),beforeHash:entry.beforeHash,
        beforeMode:entry.beforeMode,afterHash:entry.afterHash}))};
    for(const entry of prepared.plan.changes) if(checkpoint==='all files published'||entry.path==='.0-code/config.json') {
      if(entry.after===null)fs.unlinkSync(join(f.root,entry.path));
      else {f.put(entry.path,entry.after);fs.chmodSync(join(f.root,entry.path),entry.mode);}
    }
    f.put('.0-code/run/installation-transaction.json',journal);
    refusesWithoutWrites(f.root,()=>recoverProjectInstallation(f.root,{documentManifest}),/document|manifest|role/i);
    // Even an explicit former config grants no authority to an unrelated manifest path.
    refusesWithoutWrites(f.root,()=>recoverProjectInstallation(f.root,{config,documentManifest:{schema_version:1,files:['.claude/settings.json']}}),/document|manifest|role/i);
    const options={source,config,documentManifest};
    if(operation==='recover') {
      assert.equal(recoverProjectInstallation(f.root,options).recovered,true);
      assert.deepEqual(snapshot(f.root),before);
    } else {
      const action=operation==='upgrade'?upgradeProject:migrateProject;
      assert.ok(action(f.root,options).result.changed>0);
      assert.equal(existsSync(join(f.root,'docs/STATE.md')),false);
      assert.equal(existsSync(join(f.root,'.0-code/docs/STATE.md')),true);
      assert.equal(action(f.root,{source,documentManifest}).result.changed,0);
    }
  });

test('fresh strict install never inherits external document authority while recovering an older journal', t => {
  const f = fixture(t), { source } = frameworkSource(t);
  const before = Buffer.from('# External owner roadmap\r\n'), after = Buffer.from('# Interrupted external roadmap\n');
  f.put('docs/ROADMAP.md', after);
  f.put('.0-code/run/installation-transaction.json', { schema_version: 1, missingDirectories: [], changes: [{
    path: 'docs/ROADMAP.md', before: before.toString('base64'), beforeHash: hashBytes(before), beforeMode: 0o644,
    afterHash: hashBytes(after) }] });
  const config = { engines: ['claude'], instructions: { claude: 'session-hook', claude_settings: '.0-code/claude/settings.json' },
    modules: Object.fromEntries(Object.keys(PROJECT_MODULES).map(id => [id, false])) };
  refusesWithoutWrites(f.root, () => installProject(f.root, { source, config }));
});

for (const operation of ['install', 'internal legacy migration'])
  test('final validation rejects a forbidden operation appended after ' + operation + ' planning', t => {
    const f = operation === 'install' ? fixture(t) : internalLegacy(t);
    const source = f.source || frameworkSource(t).source;
    const prepared = operation === 'install' ? planProjectInstallation(f.root, { source, config: configuration() })
      : planProjectMigration(f.root, { source, config: f.config });
    const forbidden = new InstallationPlan(f.root); forbidden.change('unselected/new-directory/file.md', 'Must never be published');
    prepared.plan.changes.push(...forbidden.changes);
    refusesWithoutWrites(f.root, () => applyInstallationPlan(prepared.plan));
    assert.equal(existsSync(join(f.root, 'unselected')), false);
  });
