import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installProject, planProjectInstallation, upgradeProject, uninstallProject } from '../../core/project-installation.mjs';
import { doctorProject } from '../../core/project-doctor.mjs';
import { normalizeProjectConfig, loadProjectConfig } from '../../core/project-config.mjs';
import { ClaudeBackend } from '../../core/backends/claude.mjs';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';
import { projectContext } from '../../hooks/project-context.mjs';
import { runLoop } from '../../core/supervisor.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url));
const scratch=join(dirname(repo.replace(/[\\/]$/,'')),'scratch','tmp');
const config=(extra={})=>({engines:['claude'],modules:Object.fromEntries(Object.keys(PROJECT_MODULES).map(id=>[id,false])),...extra});
const hookConfig=(extra={})=>config({instructions:{claude:'session-hook'},...extra});
function fixture(t,files={}) {
  mkdirSync(scratch,{recursive:true});
  const root=mkdtempSync(join(scratch,'context-'));t.after(()=>cleanupTempDir(root));
  for(const [path,bytes] of Object.entries(files)) {mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),bytes);}
  return root;
}
function snapshot(root) {
  const files=[];
  function visit(dir,path='') {for(const entry of readdirSync(dir,{withFileTypes:true})) {
    const next=path?path+'/'+entry.name:entry.name;
    if(entry.isDirectory())visit(join(dir,entry.name),next);else files.push([next,readFileSync(join(dir,entry.name)).toString('base64')]);
  }}
  visit(root);return files.sort(([a],[b])=>a.localeCompare(b));
}
const contextCheck=root=>doctorProject(root).checks.find(check=>check.id==='claude-context');

test('only selected engines receive their root instruction block and native descriptors',t=>{
  for(const engine of ['claude','codex','opencode']) {
    const root=fixture(t),prepared=installProject(root,{config:config({engines:[engine]})});
    assert.equal(existsSync(join(root,'CLAUDE.md')),engine==='claude');
    assert.equal(existsSync(join(root,'AGENTS.md')),engine!=='claude');
    const external=prepared.receipt.files.map(entry=>entry.path).filter(path=>!path.startsWith('.0-code/'));
    assert.equal(external.some(path=>path.startsWith('.claude/')),engine==='claude');
    assert.equal(external.some(path=>path.startsWith('.agents/')),engine==='codex'||engine==='opencode');
    assert.equal(external.some(path=>path.startsWith('.opencode/')),engine==='opencode');
    uninstallProject(root);
    assert.deepEqual(readdirSync(root),['.0-code']);
  }
});

test('session-hook lifecycle never creates or edits CLAUDE.md, including arbitrary owner bytes',async t=>{
  for(const owner of [null,Buffer.from([0xff,0,13,10]),Buffer.from('# Owner\r\n<!-- BEGIN 0-CODE -->\nOwner marker\n')]) {
    const root=fixture(t,owner===null?{}:{'CLAUDE.md':owner}),before=snapshot(root);
    const planned=planProjectInstallation(root,{config:hookConfig()});assert.deepEqual(snapshot(root),before);
    assert.equal(planned.plan.changes.some(entry=>entry.path==='CLAUDE.md'),false);
    const installed=installProject(root,{config:hookConfig()});
    assert.equal(installed.receipt.files.some(entry=>entry.path==='CLAUDE.md'),false);
    const check=contextCheck(root);assert.equal(check.ok,true,check.reason);
    assert.equal(installProject(root).result.changed,0);
    assert.equal(upgradeProject(root).result.changed,0);
    await assert.rejects(new ClaudeBackend().installInstructions({targetDir:root,content:'replace'}),/Use 0code upgrade/);
    uninstallProject(root);
    assert.equal(existsSync(join(root,'CLAUDE.md')),owner!==null);
    if(owner!==null)assert.deepEqual(readFileSync(join(root,'CLAUDE.md')),owner);
    assert.deepEqual(snapshot(root).filter(([path])=>!path.startsWith('.0-code/')),before);
  }
});

test('native wrapper returns full internal context for startup, resume, clear, compact and subagents',t=>{
  const root=fixture(t);installProject(root,{config:hookConfig()});
  const expected=readFileSync(join(root,'.0-code/AGENT.md'),'utf8');
  for(const event of [
    ...['startup','resume','clear','compact'].map(source=>({hook_event_name:'SessionStart',source})),
    {hook_event_name:'SubagentStart',agent_type:'reviewer'},
  ]) {
    const result=spawnSync('bash',[join(root,'.0-code/hooks/run-hook.cmd'),'project-context'],
      {cwd:scratch,env:{...process.env,CLAUDE_PROJECT_DIR:root},input:JSON.stringify(event),encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(result.status,0,result.stderr||result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout),{hookSpecificOutput:{hookEventName:event.hook_event_name,additionalContext:expected}});
  }
});

test('native doctor wrapper preserves literal shell metacharacters in the project path',t=>{
  const area=fixture(t),root=join(area,'literal %USERPROFILE% & (!safe)');mkdirSync(root);
  installProject(root,{config:hookConfig()});const check=contextCheck(root);assert.equal(check.ok,true,check.reason);
});

test('existing context hooks, owner fields and later additions survive removal',t=>{
  const own={type:'command',command:'node owner-context.js'},original=JSON.stringify({hooks:{SessionStart:[{hooks:[own]}]},owner:1})+'\r\n';
  const root=fixture(t,{'.claude/settings.json':original});installProject(root,{config:hookConfig()});
  const path=join(root,'.claude/settings.json'),settings=JSON.parse(readFileSync(path));
  assert.deepEqual(settings.hooks.SessionStart[0].hooks,[own]);
  assert.equal(settings.hooks.SessionStart.length,2);settings.later='keep';writeFileSync(path,JSON.stringify(settings));
  upgradeProject(root);uninstallProject(root);
  assert.deepEqual(JSON.parse(readFileSync(path)),{hooks:{SessionStart:[{hooks:[own]}]},owner:1,later:'keep'});
});

test('switching an owned CLAUDE block to strict no-write mode refuses before any write',t=>{
  const root=fixture(t,{'CLAUDE.md':'# Owner\r\n'});installProject(root,{config:config()});
  const before=snapshot(root);
  assert.throws(()=>upgradeProject(root,{config:hookConfig()}),/First uninstall/);
  assert.deepEqual(snapshot(root),before);
  uninstallProject(root);installProject(root,{config:hookConfig()});
  assert.deepEqual(readFileSync(join(root,'CLAUDE.md')),Buffer.from('# Owner\r\n'));
});

test('strict mode rejects case aliases in explicit document roles without writes',t=>{
  for(const path of ['CLAUDE.md','claude.md','Claude.MD']) {
    const root=fixture(t),before=snapshot(root);
    assert.throws(()=>installProject(root,{config:hookConfig({documents:{state:{path}}})}),/cannot.*CLAUDE/);
    assert.deepEqual(snapshot(root),before);
  }
});

test('document role protection covers existing state bytes and computed report/template filenames',t=>{
  const root=fixture(t,{'CLAUDE.md':'---\nschema_version: 1\nproject_name: fixture\ncurrent_version: "1.0.0"\ncurrent_stage: 2\n---\n'}),before=snapshot(root);
  assert.throws(()=>installProject(root,{config:hookConfig({documents:{state:{path:'CLAUDE.md'}}})}),/cannot.*CLAUDE/);
  assert.deepEqual(snapshot(root),before);
  const project=loadProjectConfig({projectDir:root,config:hookConfig({documents:{reports:{path:'.',name:'<name>.md'},templates:{path:'.',name:'<name>.md'}}})});
  for(const role of ['reports','templates'])for(const name of ['CLAUDE','claude','Claude'])assert.throws(()=>project.documentPath(role,{name}),/cannot.*CLAUDE/);
  assert.equal(project.documentRelative('reports',{name:'allowed'}),'allowed.md');
});

test('explicit updater and supervisor state paths cannot bypass no-write mode',async t=>{
  const root=fixture(t);installProject(root,{config:hookConfig()});
  writeFileSync(join(root,'CLAUDE.md'),readFileSync(join(root,'.0-code/docs/STATE.md')));
  const before=snapshot(root);
  const result=spawnSync(process.execPath,[join(root,'.0-code/lib/update-state.mjs'),join(root,'CLAUDE.md')],
    {cwd:root,input:JSON.stringify({last_action:'attempted explicit update'}),encoding:'utf8',windowsHide:true});
  assert.notEqual(result.status,0);assert.match(result.stderr,/cannot write CLAUDE/);assert.deepEqual(snapshot(root),before);
  await assert.rejects(runLoop({projectDir:root,stateFile:join(root,'CLAUDE.md'),backend:{id:'claude'}}),/cannot write CLAUDE/);
  assert.deepEqual(snapshot(root),before);
});

test('a mutable config cannot make uninstall edit an owned CLAUDE block under strict mode',t=>{
  const root=fixture(t);installProject(root,{config:config()});
  const path=join(root,'.0-code/config.json'),settings=JSON.parse(readFileSync(path));settings.instructions.claude='session-hook';writeFileSync(path,JSON.stringify(settings));
  const before=snapshot(root);assert.throws(()=>uninstallProject(root),/never writes CLAUDE/);assert.deepEqual(snapshot(root),before);
});

test('switching back to project-file removes owned context hooks and preserves owner hooks',t=>{
  const own={hooks:[{type:'command',command:'node owner-context.js'}]};
  const root=fixture(t,{'.claude/settings.json':JSON.stringify({hooks:{SessionStart:[own]}})});
  installProject(root,{config:hookConfig()});upgradeProject(root,{config:config()});
  assert.deepEqual(JSON.parse(readFileSync(join(root,'.claude/settings.json'))).hooks.SessionStart,[own]);
  assert.equal(existsSync(join(root,'.0-code/hooks/project-context.mjs')),false);
  assert.match(readFileSync(join(root,'CLAUDE.md'),'utf8'),/BEGIN 0-CODE/);
});

test('doctor rejects disabled, missing or changed context hooks instead of claiming readiness',t=>{
  for(const change of ['disabled','local-disabled','missing','owned']) {
    const root=fixture(t);installProject(root,{config:hookConfig()});
    if(change==='owned')rmSync(join(root,'.0-code/hooks/project-context.mjs'));
    else if(change==='local-disabled')writeFileSync(join(root,'.claude/settings.local.json'),'{"disableAllHooks":true}');
    else {
      const path=join(root,'.claude/settings.json'),settings=JSON.parse(readFileSync(path));
      if(change==='disabled')settings.disableAllHooks=true;else delete settings.hooks.SessionStart;
      writeFileSync(path,JSON.stringify(settings));
    }
    const check=contextCheck(root);assert.equal(check.ok,false,change);
  }
});

test('invalid mode, disabled hooks and malformed events fail explicitly',t=>{
  assert.equal(normalizeProjectConfig({}).instructions.claude,'project-file');
  for(const instructions of [null,[],{claude:'none'},{other:true}])assert.throws(()=>normalizeProjectConfig({instructions}));
  const root=fixture(t,{'.claude/settings.json':'{"disableAllHooks":true}'}),before=snapshot(root);
  assert.throws(()=>installProject(root,{config:hookConfig()}),/hooks to be enabled/);assert.deepEqual(snapshot(root),before);
  assert.throws(()=>projectContext({hook_event_name:'Stop'},{cwd:root,env:{}}),/Unsupported/);
  assert.throws(()=>projectContext({hook_event_name:'SessionStart'},{cwd:scratch,env:{}}),/Installed/);
});

test('context loads only its enabled installed project, including invocation from a nested directory',t=>{
  const root=fixture(t),nested=join(root,'app');mkdirSync(nested);
  installProject(root,{config:hookConfig()});
  const event={hook_event_name:'SessionStart',cwd:nested};
  assert.match(projectContext(event,{env:{}}).hookSpecificOutput.additionalContext,/0-CODE cycle instructions/);
  writeFileSync(join(root,'.0-code/AGENT.md'),Buffer.from([0xff]));
  assert.throws(()=>projectContext(event,{env:{}}),/UTF-8/);
  const other=fixture(t);installProject(other,{config:config()});
  assert.deepEqual(projectContext({hook_event_name:'SessionStart',cwd:other},{env:{}}),{});
});
