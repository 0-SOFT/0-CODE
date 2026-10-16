import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCUMENT_DEFAULTS, findProjectRoot, frameworkVersion, loadProjectConfig,
  normalizeProjectConfig, projectRelativePath, resolveProjectPath } from '../../core/project-config.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const scratch = join(dirname(repository.replace(/[\\/]$/, '')), 'scratch', 'tmp');
mkdirSync(scratch, { recursive: true });
function project(t, config) {
  const root = mkdtempSync(join(scratch, 'config-'));
  t.after(() => cleanupTempDir(root));
  if (config !== undefined) {
    mkdirSync(join(root,'.0-code'));
    writeFileSync(join(root,'.0-code/config.json'), JSON.stringify(config));
  }
  return root;
}

test('legacy defaults load without writes or overriding the engine own model', t => {
  const root = project(t);
  const loaded = loadProjectConfig({ projectDir: root, env: {} });
  assert.equal(loaded.installed, false);
  assert.equal(loaded.documentPath('state'), join(root, 'docs/STATE.md'));
  assert.equal(loaded.documentRelative('roadmap'), 'docs/ROADMAP.md');
  assert.equal(loaded.runtimePath('.loop.lock'), join(root, 'docs/.loop.lock'));
  assert.equal(loaded.engineSettings('codex').model, undefined);
  assert.equal(loaded.engineSettings('codex').sandbox, 'danger-full-access');
  assert.equal(existsSync(join(root,'.0-code')), false);
  assert.equal(existsSync(join(root,'docs')), false);
  assert.equal(normalizeProjectConfig().framework_version, frameworkVersion());
});

test('custom roles and names resolve independently; runtime is in .0-code/run', t => {
  const root = project(t, { language: 'ru', engines: ['codex','opencode'],
    documents: { state: {path:'work/status.md'}, roadmap: {path:'CHANGELOG.md'},
      decisions:{path:'docs/adr',name:'ADR-<version>-<name>.md'}, reports:{path:'results',name:'<version>.md'} } });
  const loaded = loadProjectConfig({ projectDir: root });
  assert.equal(loaded.config.language,'ru');
  assert.equal(loaded.documentPath('state'),join(root,'work/status.md'));
  assert.equal(loaded.documentPath('roadmap'),join(root,'CHANGELOG.md'));
  assert.equal(loaded.documentRelative('decisions',{version:'2.1.0',name:'database'}),'docs/adr/ADR-2.1.0-database.md');
  assert.equal(loaded.documentRelative('reports',{version:'2.1.0'}),'results/2.1.0.md');
  assert.equal(loaded.runtimePath('.loop.lock'),join(root,'.0-code/run/.loop.lock'));
  assert.throws(()=>loaded.documentPath('unknown'),/Unknown/);
  assert.throws(()=>loaded.documentPath('decisions',{version:'2.1.0'}),/Missing/);
  assert.throws(()=>loaded.documentPath('decisions',{version:'2.1.0',name:'a/b'}),/directory/);
  assert.throws(()=>loaded.runtimePath('../elsewhere'),/Invalid/);
});

test('partial overrides preserve remaining defaults and never mutate caller data', () => {
  const input={modules:{telegram:true},toolset:{scope:'project'},documents:{reports:{path:'result'}}};
  const before=structuredClone(input);
  const config=normalizeProjectConfig(input);
  assert.deepEqual(input,before);
  assert.equal(config.documents.reports.name,DOCUMENT_DEFAULTS.reports.name);
  assert.equal(config.documents.state.path,DOCUMENT_DEFAULTS.state.path);
  assert.equal(config.modules.audits,true);
  assert.equal(config.modules.telegram,true);
  assert.equal(config.toolset.scope,'project');
  assert.deepEqual(config.toolset.enable,[]);
});

test('schema rejects malformed configuration and unknown fields before any write', t => {
  const root=project(t);
  for(const input of [null,[],{schema_version:2},{framework_version:'wrong'},{language:'en_US'},
    {engines:[]},{engines:['codex','codex']},{engines:['other']},{surprise:1},{modules:{bogus:true}},
    {modules:{audits:'true'}},{engine_settings:{codex:{timeoutMs:-1}}},{engine_settings:{codex:{timeoutMs:1.5}}},
    {engine_settings:{claude:{model:''}}},{documents:{state:{path:'x',name:'x'}}},
    JSON.parse('{"__proto__":{"polluted":true}}'),{guard:{mode:'off'}},{toolset:{enable:['a','a']}}]) {
    assert.throws(()=>normalizeProjectConfig(input));
  }
  assert.equal({}.polluted,undefined);
  mkdirSync(join(root,'.0-code'));
  writeFileSync(join(root,'.0-code/config.json'),'{ broken config');
  assert.throws(()=>loadProjectConfig({projectDir:root}),/cannot be read/);
  assert.equal(readFileSync(join(root,'.0-code/config.json'),'utf8'),'{ broken config');
});

test('paths reject traversal, absolute names, Windows aliases and framework internals', () => {
  for(const path of ['','../x','a/../../x','/root/x','C:/x','C:x','\\\\server\\share','a//b','./a',
    'a/../b','a\u0000b','a\nb','file:stream','docs/CON.md','NUL','dir./x','x ','.git/config',
    '.GIT/config','.0-code/config.json','a*','a?','<x>']) assert.throws(()=>projectRelativePath(path),path);
  assert.equal(projectRelativePath('docs\\adr'),'docs/adr');
  assert.equal(projectRelativePath('\u0440\u0430\u0431\u043e\u0447\u0438\u0435 \u0434\u043e\u043a\u0443\u043c\u0435\u043d\u0442\u044b/\u0441\u043e\u0441\u0442\u043e\u044f\u043d\u0438\u0435.md'),'\u0440\u0430\u0431\u043e\u0447\u0438\u0435 \u0434\u043e\u043a\u0443\u043c\u0435\u043d\u0442\u044b/\u0441\u043e\u0441\u0442\u043e\u044f\u043d\u0438\u0435.md');
  for(const documents of [{state:{path:'same'},roadmap:{path:'SAME'}},
    {state:{path:'status'},roadmap:{path:'status/plan'}},{state:{path:'reports'},reports:{path:'reports'}},
    {reports:{path:'reports',name:'<unknown>.md'}},{reports:{path:'reports',name:'../bad.md'}}])
    assert.throws(()=>normalizeProjectConfig({documents}));
  assert.throws(()=>normalizeProjectConfig({toolset:{enable:['skills/a'],disable:['skills/a']}}),/both/);
});

test('physical paths are checked, including native links on supporting file systems', t => {
  const root=project(t,{}),outside=project(t);
  mkdirSync(join(root,'ordinary'));
  assert.equal(resolveProjectPath(root,'ordinary/state.md'),join(root,'ordinary/state.md'));
  try { symlinkSync(outside,join(root,'linked'),process.platform === 'win32' ? 'junction' : 'dir'); }
  catch(error) {
    // F: cannot create reparse points. This is an observed filesystem limitation, not
    // a simulated link or a claim that its link handling has been exercised.
    assert.ok(process.platform === 'win32' && ['EISDIR','EPERM','ENOTSUP'].includes(error.code));
    assert.equal(existsSync(join(root,'linked')),false);
    t.diagnostic('Native link checks were not exercised: this scratch filesystem does not support links.');
    return;
  }
  assert.throws(()=>resolveProjectPath(root,'linked/state.md'),/symlink/);
  symlinkSync(outside,join(root,'.0-code/run'),'junction');
  assert.throws(()=>loadProjectConfig({projectDir:root}).runtimePath('.loop.lock'),/symlink/);
  const another=project(t);
  symlinkSync(join(root,'.0-code'),join(another,'.0-code'),'junction');
  assert.throws(()=>loadProjectConfig({projectDir:another}),/symlink/);
});

test('directory document roles may put generated files in the project root', t => {
  const root=project(t,{documents:{reports:{path:'.',name:'report-<version>.md'}}});
  const loaded=loadProjectConfig({projectDir:root});
  assert.equal(loaded.documentPath('reports'),root);
  assert.equal(loaded.documentPath('reports',{version:'2.0.0'}),join(root,'report-2.0.0.md'));
});

test('project lookup finds installed root from descendants and respects git boundaries', t => {
  const root=project(t,{}),child=join(root,'packages','one');
  mkdirSync(child,{recursive:true});
  assert.equal(findProjectRoot(child),root);
  mkdirSync(join(child,'.git'));
  assert.equal(findProjectRoot(child),child);
  const bare=project(t);
  assert.equal(findProjectRoot(bare),bare);
});

test('project templates override built-in templates using the chosen naming rule', t => {
  const root=project(t,{documents:{templates:{path:'patterns',name:'custom-<name>.md'}}});
  const loaded=loadProjectConfig({projectDir:root});
  mkdirSync(join(root,'patterns'));
  writeFileSync(join(root,'patterns/custom-cycle.md'),'project-specific cycle');
  assert.equal(loaded.templatePath('cycle'),join(root,'patterns/custom-cycle.md'));
  assert.equal(loaded.templatePath('research'),join(root,'.0-code/templates/research.md'));
});

test('engine settings follow flags, environment, project, engine defaults', t => {
  const root=project(t,{engine_settings:{codex:{model:'project-model',effort:'low',sandbox:'read-only',
    timeoutMs:1000,strictVersion:true,config:['personality="none"']},claude:{strictMcp:true}}});
  const loaded=loadProjectConfig({projectDir:root,env:{CODEX_MODEL:'environment-model',
    CODEX_REASONING_EFFORT:'high',CODEX_SANDBOX:'workspace-write',AGENT_TURN_TIMEOUT_MS:'2000',CODEX_STRICT_VERSION:'0'}});
  assert.equal(loaded.engineSettings('codex').model,'environment-model');
  assert.equal(loaded.engineSettings('codex').effort,'high');
  assert.equal(loaded.engineSettings('codex').timeoutMs,2000);
  assert.equal(loaded.engineSettings('codex').sandbox,'workspace-write');
  assert.equal(loaded.engineSettings('codex').strictVersion,false);
  const explicit=loaded.engineSettings('codex',{model:'flag-model',effort:'xhigh',timeoutMs:3000,sandbox:'danger-full-access'});
  assert.equal(explicit.model,'flag-model');
  assert.equal(explicit.effort,'xhigh');
  assert.equal(explicit.timeoutMs,3000);
  assert.equal(explicit.sandbox,'danger-full-access');
  assert.deepEqual(explicit.config,['personality="none"']);
  assert.equal(loaded.engineSettings('claude').strictMcp,true);
  assert.equal(loadProjectConfig({projectDir:root,env:{}}).engineSettings('codex').model,'project-model');
  assert.equal(loadProjectConfig({projectDir:root,env:{}}).engineSettings('codex').sandbox,'read-only');
  assert.equal(loaded.guardEnvironment.SAFETY_GUARD_MODE,'arbiter');
  assert.equal(loadProjectConfig({projectDir:root,env:{SAFETY_GUARD_MODE:'confirm'}}).guardEnvironment.SAFETY_GUARD_MODE,'confirm');
});
