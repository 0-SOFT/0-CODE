import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planProjectMigration, migrateProject } from '../../core/project-migration.mjs';
import { upgradeProject, uninstallProject, requireOwnership, readInstallationReceipt } from '../../core/project-installation.mjs';
import { applyInstallationPlan, hashBytes } from '../../core/installation-transaction.mjs';
import { DOCUMENT_DEFAULTS, normalizeProjectConfig, loadProjectConfig } from '../../core/project-config.mjs';
import { validateRetainedFiles } from '../../core/project-adoption.mjs';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';
import { doctorProject } from '../../core/project-doctor.mjs';
import { planProjectStart } from '../../core/project-start.mjs';
import { claudeProjectArgs, ClaudeBackend } from '../../core/backends/claude.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
import { parseOptions } from '../../tools/0code.mjs';
const repo=fileURLToPath(new URL('../../',import.meta.url));
const scratch=join(dirname(repo.replace(/[\\/]$/,'')),'scratch/tmp');
mkdirSync(scratch,{recursive:true});
const config={engines:['claude'],modules:Object.fromEntries(Object.keys(PROJECT_MODULES).map(id=>[id,false])),
  documents:{...DOCUMENT_DEFAULTS,logs:{path:'.0-code/run/logs',name:'<date>_<id>.jsonl'}},
  instructions:{claude:'session-hook',claude_settings:'.0-code/claude/settings.json',project_rules:['.0-code/docs/owner.md']},inventory:{tools:[],checks:[]}};
function fixture(t) {
  const root=mkdtempSync(join(scratch,'adoption-'));t.after(()=>cleanupTempDir(root));
  const put=(path,bytes)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),bytes);};
  const command=name=>'"${CLAUDE_PROJECT_DIR}/.0-code/hooks/run-hook.cmd" '+name;
  const overlay={env:{OWNER_LIMIT:'keep'},permissions:{deny:['Bash(git push:*)']},hooks:{
    PreToolUse:[{matcher:'*',hooks:[{type:'command',command:command('safety-guard')}]}],
    Stop:[{matcher:'',hooks:[{type:'command',command:command('ralph-loop-stop')}]}]}};
  put('.0-code/config.json',JSON.stringify(config));put('.0-code/AGENT.md','old generated guide and owner rules\r\n');
  put('.0-code/core/project-config.mjs','locally changed code, never execute');
  put('.0-code/bin/0code','#!/bin/bash\nowner launcher\n');put('.0-code/claude/settings.json',JSON.stringify(overlay,null,2)+'\n');
  put('.0-code/claude/mcp.json','{"mcpServers":{}}\n');put('.0-code/README.md','Owner readme\r\n');
  put('.0-code/docs/owner.md','Owner rules\r\n');put('.0-code/docs/ROADMAP.md','Owner roadmap\r\n');
  put('.0-code/docs/STATE.md','---\nschema_version: 1\nproject_name: fixture\ncurrent_stage: 0\ncurrent_version: "0.0.1"\niteration: 0\nrunning_jobs: []\n---\n\nExact owner journal\r\n');
  put('CLAUDE.md','Owner instruction\r\n');put('.claude/settings.json','{"env":{"OWNER":"unchanged"}}\r\n');
  const paths=['.0-code/config.json','.0-code/AGENT.md','.0-code/core/project-config.mjs','.0-code/bin/0code','.0-code/claude/settings.json','.0-code/claude/mcp.json','.0-code/README.md'];
  const manifest={schema_version:1,files:paths.map(path=>({path,sha256:hashBytes(readFileSync(join(root,path))),action:/\/bin\/|\/claude\/|\/README.md$/.test(path)?'preserve':'replace'}))};
  return {root,put,manifest,overlay,options:{source:repo,config,adoptionManifest:manifest}};
}
function snapshot(root) {
  const visit=path=>readdirSync(join(root,path),{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?visit(path+'/'+entry.name):[[path+'/'+entry.name,hashBytes(readFileSync(join(root,path,entry.name)))]]);
  return visit('').sort(([a],[b])=>a.localeCompare(b));
}
test('reviewed adoption preserves owner bytes and settings; upgrade and repeated migration change zero',t=>{
  const f=fixture(t),before=snapshot(f.root),prepared=planProjectMigration(f.root,f.options);
  assert.deepEqual(snapshot(f.root),before);
  assert.ok(prepared.adoption.backups.length===3);
  applyInstallationPlan(prepared.plan);
  const receipt=readInstallationReceipt(f.root);requireOwnership(f.root,receipt);
  assert.equal(receipt.files.some(entry=>entry.path==='CLAUDE.md'),false);
  assert.deepEqual(receipt.retainedFiles,['.0-code/bin/0code','.0-code/claude/mcp.json','.0-code/README.md']);
  for(const path of ['CLAUDE.md','.claude/settings.json','.0-code/bin/0code','.0-code/claude/mcp.json','.0-code/README.md','.0-code/docs/STATE.md','.0-code/docs/ROADMAP.md'])
    assert.equal(hashBytes(readFileSync(join(f.root,path))),before.find(([name])=>name==='/'+path)[1]);
  const overlay=JSON.parse(readFileSync(join(f.root,'.0-code/claude/settings.json')));
  assert.deepEqual(overlay.hooks.Stop,f.overlay.hooks.Stop);assert.deepEqual(overlay.permissions.deny,f.overlay.permissions.deny);
  assert.ok(overlay.hooks.SessionStart);assert.match(readFileSync(join(f.root,'.0-code/AGENT.md'),'utf8'),/\.0-code\/docs\/owner.md/);
  assert.equal(upgradeProject(f.root,{source:repo}).result.changed,0);
  assert.equal(migrateProject(f.root,f.options).result.changed,0);
  f.put('.0-code/bin/0code','owner may edit retained launcher');requireOwnership(f.root,readInstallationReceipt(f.root));
  f.put('.0-code/core/project-config.mjs','tampered production code');
  assert.throws(()=>requireOwnership(f.root,readInstallationReceipt(f.root)),/changed outside upgrade/);
});
test('uninstall restores the session overlay and retains owner extensions and documents',t=>{
  const f=fixture(t),overlay=readFileSync(join(f.root,'.0-code/claude/settings.json'));
  migrateProject(f.root,f.options);uninstallProject(f.root);
  assert.deepEqual(readFileSync(join(f.root,'.0-code/claude/settings.json')),overlay);
  for(const path of ['.0-code/bin/0code','.0-code/claude/mcp.json','.0-code/README.md','.0-code/docs/STATE.md'])assert.ok(existsSync(join(f.root,path)));
});
test('root STATE adoption preserves bytes, remains idempotent and refuses both live lock locations',t=>{
  for (const lockPath of [null, '.loop.lock', '.0-code/run/.loop.lock']) {
    const f=fixture(t),stateBytes=readFileSync(join(f.root,'.0-code/docs/STATE.md'));
    const rootConfig={...config,documents:{...config.documents,state:{path:'STATE.md'}}};
    f.put('STATE.md',stateBytes);
    unlinkSync(join(f.root,'.0-code/docs/STATE.md'));
    f.put('.0-code/config.json',JSON.stringify(rootConfig));
    const manifest={...f.manifest,files:f.manifest.files.map(entry=>entry.path==='.0-code/config.json'
      ?{...entry,sha256:hashBytes(readFileSync(join(f.root,entry.path)))}:entry)};
    const options={...f.options,config:rootConfig,adoptionManifest:manifest};
    if (lockPath) {
      f.put(lockPath,JSON.stringify({pid:process.pid,engine:'claude',startedAt:new Date().toISOString()}));
      const before=snapshot(f.root);
      assert.throws(()=>planProjectMigration(f.root,options),/lock|cycle|running|active/i);
      assert.deepEqual(snapshot(f.root),before);
      continue;
    }
    const before=snapshot(f.root),prepared=planProjectMigration(f.root,options);
    assert.deepEqual(snapshot(f.root),before);
    applyInstallationPlan(prepared.plan);
    assert.deepEqual(readFileSync(join(f.root,'STATE.md')),stateBytes);
    assert.equal(loadProjectConfig({projectDir:f.root}).config.documents.state.path,'STATE.md');
    assert.equal(migrateProject(f.root,options).result.changed,0);
    assert.equal(upgradeProject(f.root,{source:repo}).result.changed,0);
  }
});
test('manifest rejects unreviewed files, wrong hashes, duplicate paths, unsafe actions and fields without writes',t=>{
  for(const variant of ['hash','duplicate','case','outside','documents','runtime','runtime-case','extension-case','receipt','retain-code','replace-extension','field','unknown','missing','empty']) {
    const f=fixture(t),manifest=structuredClone(f.manifest);
    if(variant==='hash')manifest.files[0].sha256='0'.repeat(64);
    if(variant==='duplicate')manifest.files.push(manifest.files[0]);
    if(variant==='case')manifest.files.push({...manifest.files[0],path:manifest.files[0].path.toUpperCase()});
    if(variant==='outside')manifest.files[0].path='CLAUDE.md';
    if(variant==='documents')manifest.files[0].path='.0-code/docs/STATE.md';
    if(variant==='runtime')manifest.files[0].path='.0-code/run/file';
    if(variant==='runtime-case')manifest.files[0].path='.0-code/RUN/file';
    if(variant==='extension-case'){f.put('.0-code/BIN/another','owner');manifest.files.push({path:'.0-code/BIN/another',sha256:hashBytes(Buffer.from('owner')),action:'replace'});}
    if(variant==='receipt')manifest.files[0].path='.0-code/installation.json';
    if(variant==='retain-code')manifest.files[2].action='preserve';
    if(variant==='replace-extension')manifest.files[3].action='replace';
    if(variant==='field')manifest.unknown=true;
    if(variant==='unknown')f.put('.0-code/core/unreviewed.mjs','unknown');
    if(variant==='missing')manifest.files[0].path='.0-code/missing';
    if(variant==='empty')manifest.files=[];
    const before=snapshot(f.root);
    assert.throws(()=>planProjectMigration(f.root,{...f.options,adoptionManifest:manifest}));
    assert.deepEqual(snapshot(f.root),before,variant);
  }
});
test('planning and application refuse an active cycle, running jobs, late state edits and late manifest edits',t=>{
  for(const variant of ['active','jobs','state-after','file-after','unknown-after','lock']) {
    const f=fixture(t);
    if(variant==='active')f.put('.0-code/docs/STATE.md',readFileSync(join(f.root,'.0-code/docs/STATE.md'),'utf8').replace('current_stage: 0','current_stage: 2'));
    if(variant==='jobs')f.put('.0-code/docs/STATE.md',readFileSync(join(f.root,'.0-code/docs/STATE.md'),'utf8').replace('running_jobs: []','running_jobs: ["pending"]'));
    if(variant==='lock')f.put('.0-code/run/.loop.lock',JSON.stringify({pid:process.pid,engine:'claude',startedAt:new Date().toISOString()}));
    if(['active','jobs','lock'].includes(variant)) {
      const before=snapshot(f.root);assert.throws(()=>planProjectMigration(f.root,f.options));assert.deepEqual(snapshot(f.root),before);
    } else {
      const plan=planProjectMigration(f.root,f.options).plan;
      f.put(variant==='state-after'?'.0-code/docs/STATE.md':variant==='unknown-after'?'.0-code/core/late.mjs':'.0-code/bin/0code','changed after plan');
      const before=snapshot(f.root);assert.throws(()=>applyInstallationPlan(plan),/changed|Unreviewed/);assert.deepEqual(snapshot(f.root),before);
    }
  }
});
test('a replacement config cannot hide the active original STATE behind an idle dummy',t=>{
  const f=fixture(t);
  f.put('.0-code/docs/dummy.md',readFileSync(join(f.root,'.0-code/docs/STATE.md')));
  f.put('.0-code/docs/STATE.md',readFileSync(join(f.root,'.0-code/docs/STATE.md'),'utf8').replace('current_stage: 0','current_stage: 2'));
  const before=snapshot(f.root);
  assert.throws(()=>planProjectMigration(f.root,{...f.options,config:{...config,documents:{...config.documents,state:{path:'.0-code/docs/dummy.md'}}}}),/preserves existing document roles/);
  assert.deepEqual(snapshot(f.root),before);
});
test('retained paths never exempt framework code or collide with owned entries',()=>{
  for(const paths of [['.0-code/core/evil.mjs'],['.0-code/bin/../core/evil.mjs'],['.0-code/bin/a','.0-code/bin/a'],null])assert.throws(()=>validateRetainedFiles(paths));
  assert.throws(()=>validateRetainedFiles(['.0-code/bin/a'],[{path:'.0-code/bin/a'}]));
});
test('runtime logs resolve both directory and filename while permanent roles cannot use run',()=>{
  const project=loadProjectConfig({projectDir:repo,config});
  assert.equal(project.documentRelative('logs'),'.0-code/run/logs');
  assert.equal(project.documentRelative('logs',{date:'2026-01-01',id:'test'}),'.0-code/run/logs/2026-01-01_test.jsonl');
  for(const path of ['.0-code/run','.0-code/run/logging','.0-code/run/logs/../core'])assert.throws(()=>normalizeProjectConfig({...config,documents:{...config.documents,logs:{path,name:'<id>.jsonl'}}}));
  assert.throws(()=>normalizeProjectConfig({...config,documents:{state:{path:'.0-code/run/logs/STATE.md'}}}));
});
test('adoption CLI has an explicit migrate-only option and rejects malformed retained receipts',t=>{
  assert.ok(parseOptions(['migrate','--adopt-manifest','reviewed.json']).adoptionManifestFile);
  assert.throws(()=>parseOptions(['install','--adopt-manifest','reviewed.json']));
  const f=fixture(t);migrateProject(f.root,f.options);
  const receipt=readInstallationReceipt(f.root);f.put('.0-code/installation.json',JSON.stringify({...receipt,retainedFiles:['.0-code/core/evil.mjs']}));
  assert.throws(()=>readInstallationReceipt(f.root),/retained/);
});
test('session settings preserve owner edits, diagnose removed loop hooks and advertise the correct driver',t=>{
  const f=fixture(t);migrateProject(f.root,f.options);
  f.put('cycle.md','---\nversion: "1.0.0"\nstage: 2\n---\nAuthorized fixture cycle.\n');
  assert.deepEqual(planProjectStart(f.root,join(f.root,'cycle.md')).drivers[0].argv,['claude','--settings','.0-code/claude/settings.json']);
  const settingsPath='.0-code/claude/settings.json',settings=JSON.parse(readFileSync(join(f.root,settingsPath)));
  f.put(settingsPath,JSON.stringify({...settings,env:{...settings.env,OWNER_ADDED:'retained'}}));
  assert.ok(upgradeProject(f.root,{source:repo}).result.changed>0);
  assert.equal(JSON.parse(readFileSync(join(f.root,settingsPath))).env.OWNER_ADDED,'retained');
  const changed=JSON.parse(readFileSync(join(f.root,settingsPath)));delete changed.hooks.Stop;
  f.put(settingsPath,JSON.stringify(changed));
  const doctor=doctorProject(f.root);
  assert.equal(doctor.checks.find(check=>check.id==='claude-session-settings').ok,false);
});
test('backend session overlay resolves relative cwd and leaves ordinary project settings alone',async t=>{
  const f=fixture(t),before=readFileSync(join(f.root,'.claude/settings.json'));
  assert.deepEqual(claudeProjectArgs(relative(process.cwd(),f.root)),['--settings',join(f.root,'.0-code/claude/settings.json')]);
  await new ClaudeBackend().ensureReady({cwd:f.root});
  assert.deepEqual(readFileSync(join(f.root,'.claude/settings.json')),before);
});
test('adoption refuses disabled hooks, changed native guards, inconsistent session config and altered repeat manifests',t=>{
  for(const variant of ['disabled','guard','stop','repeat']) {
    const f=fixture(t);
    if(variant==='repeat') {
      migrateProject(f.root,f.options);
      assert.throws(()=>planProjectMigration(f.root,{...f.options,adoptionManifest:{...f.manifest,files:[...f.manifest.files].reverse()}}),/differs/);
      continue;
    }
    const overlay=structuredClone(f.overlay);
    if(variant==='disabled')overlay.disableAllHooks=true;
    else overlay.hooks[variant==='guard'?'PreToolUse':'Stop'][0].hooks[0].command='owner modified safety-guard command';
    f.put('.0-code/claude/settings.json',JSON.stringify(overlay));
    const manifest={...f.manifest,files:f.manifest.files.map(entry=>entry.path==='.0-code/claude/settings.json'?{...entry,sha256:hashBytes(readFileSync(join(f.root,entry.path)))}:entry)};
    const before=snapshot(f.root);assert.throws(()=>planProjectMigration(f.root,{...f.options,adoptionManifest:manifest}));assert.deepEqual(snapshot(f.root),before);
  }
  assert.throws(()=>normalizeProjectConfig({...config,instructions:{...config.instructions,claude:'project-file'}}),/Session settings/);
  assert.throws(()=>normalizeProjectConfig({...config,instructions:{...config.instructions,project_rules:['.0-code/core/evil.mjs']}}),/outside framework/);
});
