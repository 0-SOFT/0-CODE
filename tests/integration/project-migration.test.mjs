import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { planProjectMigration as plan, migrateProject as migrate, readMigrationEvidence } from '../../core/project-migration.mjs';
import { installProject as install, upgradeProject as upgrade, uninstallProject } from '../../core/project-installation.mjs';
import { scanProject } from '../../core/project-inventory.mjs';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';
import { LEGACY_DOCUMENT_DEFAULTS, loadProjectConfig } from '../../core/project-config.mjs';
import { doctorProject } from '../../core/project-doctor.mjs';
import { assertLifecycleDoctor } from '../helpers/lifecycle-doctor.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
import { writeMemory } from '../../core/turn-progress.mjs';
import { frameworkSource } from '../helpers/framework-source.mjs';
import { runBootstrap } from '../helpers/bootstrap-run.mjs';
const repo=fileURLToPath(new URL('../../',import.meta.url)),scratch=join(dirname(repo.replace(/[\\/]$/,'')),'scratch','tmp');mkdirSync(scratch,{recursive:true});
const config={engines:['claude'],modules:Object.fromEntries(Object.keys(PROJECT_MODULES).map(id=>[id,false]))};
const sources=new Map();
const planProjectMigration=(root,options={})=>plan(root,{source:sources.get(root),...options});
const migrateProject=(root,options={})=>migrate(root,{source:sources.get(root),...options});
const installProject=(root,options={})=>install(root,{source:sources.get(root),...options});
const upgradeProject=(root,options={})=>upgrade(root,{source:sources.get(root),...options});
function legacy(t,{syntheticOnly=false}={}) {
  const root=mkdtempSync(join(scratch,'migration-'));t.after(()=>cleanupTempDir(root));
  const published=!syntheticOnly&&existsSync(join(repo,'config/legacy-installations.json'));
  const synthetic=published?null:frameworkSource(t),source=published?repo:synthetic.source;
  sources.set(root,source);t.after(()=>sources.delete(root));
  const put=(path,bytes)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),bytes);};
  const blob=path=>{const r=spawnSync('git',['show','v1.30.0:'+path],{cwd:repo,windowsHide:true});assert.equal(r.status,0);return r.stdout;};
  for(const path of ['core/gates.mjs','hooks/safety-guard.mjs','.claude/skills/orchestrator-wrapper/SKILL.md'])put(path,published?blob(path.startsWith('.claude/')?path.slice(8):path):synthetic.legacyFiles[path]);
  put('core/owner.py','owner code\r\n');put('lib/yaml-mini.mjs','owner modified library');
  const evidence=readMigrationEvidence(source);
  const template=(published?evidence.instructions.find(x=>x.tag==='v1.30.0').template:synthetic.instructions).replaceAll('__PROJECT_NAME__','fixture').replaceAll('__FRAMEWORK_VERSION__','1.30.0').trimEnd();
  const prefix='# Owner rules\r\nExact spaces.  \r\n\r\n',suffix='\n# Owner suffix\n';
  put('CLAUDE.md',prefix+'<!-- BEGIN AUTONOMOUS FRAMEWORK -->\n'+template+'\n<!-- END AUTONOMOUS FRAMEWORK -->'+suffix);
  const settings=structuredClone(published?evidence.settings.find(x=>x.tag==='v1.30.0').template:synthetic.settings);delete settings.$schema_comment;
  settings.hooks.PreToolUse.push({matcher:'Write',hooks:[{type:'command',command:'node owner-check.js'}]});
  put('.claude/settings.json',JSON.stringify(settings));
  put('docs/STATE.md','---\nschema_version: 1\nproject_name: fixture\ncurrent_version: "3.0.0"\ncurrent_stage: 2\nblockers: []\n---\n\n# Exact owner journal\r\n');
  put('docs/ROADMAP.md','# Owner roadmap\r\n');put('docs/adr/design.md','# Owner decision\n');
  return {root,put,prefix,suffix,source};
}
function all(root) {const rows=[];function visit(dir,path=''){for(const e of readdirSync(dir,{withFileTypes:true})){const next=path?path+'/'+e.name:e.name;if(e.isDirectory())visit(join(dir,e.name),next);else rows.push([next,readFileSync(join(dir,e.name)).toString('base64')]);}}visit(root);return rows.sort(([a],[b])=>a.localeCompare(b));}

test('strict session-hook refuses legacy CLAUDE cleanup without writes',t=>{
  const f=legacy(t),before=all(f.root);
  assert.throws(()=>migrateProject(f.root,{config:{...config,instructions:{claude:'session-hook'}}}),/never writes CLAUDE/);
  assert.deepEqual(all(f.root),before);
});

test('migration removes proven legacy instructions for engines that are no longer selected',t=>{
  const f=legacy(t);
  migrateProject(f.root,{config:{...config,engines:['codex']}});
  assert.equal(readFileSync(join(f.root,'CLAUDE.md'),'utf8'),f.prefix+f.suffix);
  assert.doesNotMatch(readFileSync(join(f.root,'.claude/settings.json'),'utf8'),/run-hook/);
  uninstallProject(f.root);
  assert.equal(readFileSync(join(f.root,'CLAUDE.md'),'utf8'),f.prefix+f.suffix);
});
test('available ownership evidence authorizes an atomic migration; owner code/docs remain exact and repeat changes zero',t=>{
  const f=legacy(t),before=all(f.root),plan=planProjectMigration(f.root,{config});assert.deepEqual(all(f.root),before);
  assert.ok(plan.migration.removed.some(x=>x.path==='core/gates.mjs'));assert.ok(plan.migration.preserved.some(x=>x.path==='lib/yaml-mini.mjs'));
  const migrated=migrateProject(f.root,{config});assert.ok(migrated.result.changed>0);assertLifecycleDoctor(doctorProject(f.root),{cwd:f.root,engines:config.engines});
  assert.deepEqual(loadProjectConfig({projectDir:f.root}).config.documents,LEGACY_DOCUMENT_DEFAULTS);
  assert.equal(existsSync(join(f.root,'.0-code/docs/STATE.md')),false);
  for(const path of ['core/owner.py','lib/yaml-mini.mjs','docs/STATE.md','docs/ROADMAP.md','docs/adr/design.md'])assert.equal(readFileSync(join(f.root,path)).toString('base64'),before.find(([p])=>p===path)[1]);
  assert.equal(existsSync(join(f.root,'core/gates.mjs')),false);
  const receipt=JSON.parse(readFileSync(join(f.root,'.0-code/installation.json')));for(const item of receipt.migration.backups)assert.equal(readFileSync(join(f.root,item.backup)).toString('base64'),before.find(([p])=>p===item.path)[1]);
  assert.equal(migrateProject(f.root,{config}).result.changed,0);uninstallProject(f.root);
  assert.equal(readFileSync(join(f.root,'CLAUDE.md'),'utf8'),f.prefix+f.suffix);
  assert.match(readFileSync(join(f.root,'.claude/settings.json'),'utf8'),/owner-check/);
  assert.doesNotMatch(readFileSync(join(f.root,'.claude/settings.json'),'utf8'),/run-hook/);
});

test('migration without explicit config preserves the legacy state instead of forking a new cycle',t=>{
  const f=legacy(t),before=readFileSync(join(f.root,'docs/STATE.md'));
  migrateProject(f.root);
  assert.deepEqual(loadProjectConfig({projectDir:f.root}).config.documents,LEGACY_DOCUMENT_DEFAULTS);
  assert.deepEqual(readFileSync(join(f.root,'docs/STATE.md')),before);
  assert.equal(existsSync(join(f.root,'.0-code/docs/STATE.md')),false);
});

test('migration honors document roles from an existing config even without an explicit option',t=>{
  const f=legacy(t),documents={...LEGACY_DOCUMENT_DEFAULTS,state:{path:'work/status.md'},logs:{...LEGACY_DOCUMENT_DEFAULTS.logs,path:'work/logs'}};
  f.put('work/status.md',readFileSync(join(f.root,'docs/STATE.md')));
  f.put('.0-code/config.json',JSON.stringify({...config,documents}));
  migrateProject(f.root);
  assert.deepEqual(loadProjectConfig({projectDir:f.root}).config.documents,documents);
  assert.equal(existsSync(join(f.root,'.0-code/docs/STATE.md')),false);
});

test('migration rejects malformed document objects without writes and inherits custom names for partial paths',t=>{
  const f=legacy(t,{syntheticOnly:true});
  for(const documents of [null,[]]) {
    const before=all(f.root);
    assert.throws(()=>planProjectMigration(f.root,{config:{...config,documents}}),/documents: invalid type/);
    assert.deepEqual(all(f.root),before);
  }
  const documents={...LEGACY_DOCUMENT_DEFAULTS,reports:{path:'results',name:'custom-<name>.md'}};
  f.put('.0-code/config.json',JSON.stringify({...config,documents}));
  migrateProject(f.root,{config:{...config,documents:{reports:{path:'new-results'}}}});
  assert.deepEqual(loadProjectConfig({projectDir:f.root}).config.documents.reports,{path:'new-results',name:'custom-<name>.md'});
  assert.equal(loadProjectConfig({projectDir:f.root}).documentRelative('state'),'docs/STATE.md');
});
test('legacy runtime moves without changing documents and a real active process prevents conversion',t=>{
  const f=legacy(t);writeMemory(join(f.root,'docs'),{head:'fixture',dirty:'owner',state:'fixture'},2);
  f.put('docs/.loop-children',JSON.stringify({pids:[],children:[],at:new Date().toISOString()}));
  const progress=readFileSync(join(f.root,'docs/.loop-progress'));migrateProject(f.root,{config});
  assert.deepEqual(readFileSync(join(f.root,'.0-code/run/.loop-progress')),progress);assert.equal(existsSync(join(f.root,'docs/.loop-progress')),false);
  const active=legacy(t);active.put('docs/.loop.lock',JSON.stringify({pid:process.pid,engine:'supervisor',startedAt:new Date().toISOString()}));
  const before=all(active.root);assert.throws(()=>migrateProject(active.root,{config}),/active legacy cycle/);assert.deepEqual(all(active.root),before);
});
test('changed instruction block, foreign Stop, ambiguous markers and unproved installation refuse without writing',t=>{
  for(const change of ['body','stop','markers']) {
    const f=legacy(t);
    if(change==='body')f.put('CLAUDE.md',readFileSync(join(f.root,'CLAUDE.md'),'utf8').replace('A continuous autonomous Ralph Loop:','A locally changed loop:'));
    if(change==='stop'){const settings=JSON.parse(readFileSync(join(f.root,'.claude/settings.json')));settings.hooks.Stop.push({hooks:[{type:'command',command:'node owner-stop.js'}]});f.put('.claude/settings.json',JSON.stringify(settings));}
    if(change==='markers')f.put('CLAUDE.md','<!-- END AUTONOMOUS FRAMEWORK -->\n<!-- BEGIN AUTONOMOUS FRAMEWORK -->');
    const before=all(f.root);assert.throws(()=>migrateProject(f.root,{config}),/published templates|Stop hooks|markers/);assert.deepEqual(all(f.root),before);
  }
  const root=mkdtempSync(join(scratch,'not-legacy-'));t.after(()=>cleanupTempDir(root));
  assert.throws(()=>migrateProject(root,{source:frameworkSource(t).source,config}),/No proved/);assert.deepEqual(all(root),[]);
});
test('actual migrate CLI previews all removals and backs up before conversion',async t=>{
  const f=legacy(t),settings=join(f.root,'selected.json');writeFileSync(settings,JSON.stringify(config));
  const before=all(f.root),run=args=>runBootstrap(process.execPath,[join(repo,'tools/0code.mjs'),'migrate','--project',f.root,'--config',settings,'--backend','claude','--source',f.source,'--json',...args]);
  const preview=await run(['--dry-run']);assert.equal(preview.status,0,preview.stderr);assert.deepEqual(all(f.root),before);assert.ok(JSON.parse(preview.stdout).migration.removed.length>0);
  const result=await run([]);assert.equal(result.status,0,result.stderr);assertLifecycleDoctor(doctorProject(f.root),{cwd:f.root,engines:config.engines});
});

test('migrate CLI backend selection keeps historical roles when inventory has incomplete legacy markers',async t=>{
  const f=legacy(t,{syntheticOnly:true}),before=readFileSync(join(f.root,'docs/STATE.md'));
  assert.equal(scanProject(f.root).inventory.legacy.detected,false);
  const env={...process.env,ZERO_CODE_USER_DIR:join(f.root,'profiles/pool'),
    CLAUDE_CONFIG_DIR:join(f.root,'profiles/claude'),CODEX_HOME:join(f.root,'profiles/codex'),XDG_CONFIG_HOME:join(f.root,'profiles/xdg')};
  const args=[join(repo,'tools/0code.mjs'),'migrate','--project',f.root,'--backend','codex','--source',f.source,'--json'];
  const preview=await runBootstrap(process.execPath,[...args,'--dry-run'],{env});
  assert.equal(preview.status,0,preview.stderr);
  assert.equal(JSON.parse(preview.stdout).plan.some(entry=>entry.path==='.0-code/docs/STATE.md'),false);
  assert.equal(existsSync(join(f.root,'.0-code')),false);
  const result=await runBootstrap(process.execPath,args,{env});
  assert.equal(result.status,0,result.stderr);
  const project=loadProjectConfig({projectDir:f.root});
  assert.deepEqual(project.config.documents,LEGACY_DOCUMENT_DEFAULTS);
  assert.deepEqual(project.config.engines,['codex']);
  assert.deepEqual(readFileSync(join(f.root,'docs/STATE.md')),before);
  assert.equal(existsSync(join(f.root,'.0-code/docs/STATE.md')),false);
});

test('lifecycle matrix: available legacy evidence with all three engines',t=>{
  const f=legacy(t),before=all(f.root),scan=scanProject(f.root);assert.ok(scan.inventory);
  const selection={...config,engines:['claude','codex','opencode']};migrateProject(f.root,{config:selection});
  const doctor=doctorProject(f.root);const probes=assertLifecycleDoctor(doctor,{cwd:f.root,engines:selection.engines});
  assert.equal(installProject(f.root).result.changed,0);assert.equal(upgradeProject(f.root).result.changed,0);
  uninstallProject(f.root);
  for(const path of ['core/owner.py','lib/yaml-mini.mjs','docs/STATE.md','docs/ROADMAP.md','docs/adr/design.md'])
    assert.equal(readFileSync(join(f.root,path)).toString('base64'),before.find(([p])=>p===path)[1],path);
  assert.equal(readFileSync(join(f.root,'CLAUDE.md'),'utf8'),f.prefix+f.suffix);
  assert.doesNotMatch(readFileSync(join(f.root,'.claude/settings.json'),'utf8'),/run-hook/);
  t.diagnostic(JSON.stringify({case:f.source===repo?'published 1.30':'synthetic legacy',doctor:doctor.ok,engines:probes,repeat_changed:0,upgrade_changed:0,owner_bytes_preserved:true}));
});
test('missing ownership evidence refuses migration before changing the project',t=>{
  const f=legacy(t,{syntheticOnly:true}),before=all(f.root);unlinkSync(join(f.source,'config/legacy-installations.json'));
  assert.throws(()=>migrateProject(f.root,{config}),/ENOENT/);assert.deepEqual(all(f.root),before);
});
