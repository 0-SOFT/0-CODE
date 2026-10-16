import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fileSnapshot } from '../../core/installation-transaction.mjs';
import { doctorProject } from '../../core/project-doctor.mjs';
import { scanProject } from '../../core/project-inventory.mjs';
import { installProject, planProjectInstallation, readInstallationReceipt, uninstallProject, upgradeProject } from '../../core/project-installation.mjs';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
const repository=fileURLToPath(new URL('../../',import.meta.url));
const scratch=join(dirname(repository.replace(/[\\/]$/,'')),'scratch','tmp');mkdirSync(scratch,{recursive:true});
const configuration=(extra={})=>({engines:['claude','codex','opencode'],language:'ru',
  modules:Object.fromEntries(Object.keys(PROJECT_MODULES).map(id=>[id,false])),...extra});
function fixture(t,files={}) {
  const root=mkdtempSync(join(scratch,'installation-'));t.after(()=>cleanupTempDir(root));
  for(const [path,value] of Object.entries(files)) {mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),typeof value==='string'?value:JSON.stringify(value));}
  return root;
}
function projectFiles(root) {
  const map=new Map();
  function visit(directory,path='') {
    for(const entry of readdirSync(directory,{withFileTypes:true})) {
      const child=path?path+'/'+entry.name:entry.name;
      if(child==='.0-code'||child==='docs') continue;
      if(entry.isDirectory()) visit(join(directory,entry.name),child);
      else map.set(child,readFileSync(join(directory,entry.name)).toString('base64'));
    }
  }visit(root);return [...map].sort(([a],[b])=>a.localeCompare(b));
}
test('git clones preserve all namespace receipt bytes despite autocrlf',t=>{
  const area=fixture(t),root=join(area,'source'),clone=join(area,'clone');mkdirSync(root);
  const attributes='*.mjs filter=owner text eol=crlf\n';writeFileSync(join(root,'.gitattributes'),attributes);
  installProject(root,{config:configuration()});
  const git=(cwd,args)=>{const result=spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return result.stdout;};
  git(root,['init']);git(root,['config','user.name','Verification']);git(root,['config','user.email','verification@invalid.local']);git(root,['config','filter.owner.clean','sed s/^/OWNER:/']);
  git(root,['add','.']);git(root,['commit','-m','Installed namespace']);
  git(area,['-c','core.autocrlf=true','clone',root,clone]);
  for(const entry of readInstallationReceipt(clone).files.filter(entry=>entry.path.startsWith('.0-code/')))
    assert.equal(fileSnapshot(clone,entry.path).hash,entry.hash,entry.path);
  assert.equal(readFileSync(join(root,'.gitattributes'),'utf8'),attributes);
  assert.equal(git(root,['ls-files','.0-code/run']).trim(),'');
});

test('isolated core lifecycle preserves colliding source folders and project bytes exactly',async t=>{
  const root=fixture(t,{'core/main.py':'project core\r\n','lib/data.py':'project library','hooks/action.py':'project hooks',
    'CLAUDE.md':'# Existing rules\r\nKeep these exact bytes.\r\n','AGENTS.md':'# Other engine\nProject rules.',
    '.claude/settings.json':'{ "hooks": {"PreToolUse":[{"matcher":"Write","hooks":[{"type":"command","command":"node project-check.js"}]}]}, "env":{"LOCAL":"private-fixture"} }\r\n'});
  const before=projectFiles(root),planned=planProjectInstallation(root,{config:configuration()});
  assert.deepEqual(projectFiles(root),before);assert.equal(existsSync(join(root,'.0-code')),false);
  assert.ok(planned.plan.summary().some(entry=>entry.path==='.0-code/VERSION'));
  const installed=installProject(root,{config:configuration()});assert.ok(installed.result.changed>0);
  assert.equal(existsSync(join(root,'.0-code/core/supervisor.mjs')),true);
  assert.equal(existsSync(join(root,'ecosystem.json')),false);
  assert.equal(existsSync(join(root,'.0-code/hooks/usage-statusline.mjs')),false);
  const settings=JSON.parse(readFileSync(join(root,'.claude/settings.json'),'utf8'));
  assert.equal(settings.env.LOCAL,'private-fixture');assert.equal(settings.hooks.PreToolUse[0].hooks[0].command,'node project-check.js');
  assert.match(settings.hooks.Stop[0].hooks[0].command,/\.0-code\/hooks\/run-hook.cmd/);
  assert.match(readFileSync(join(root,'AGENTS.md'),'utf8'),/^# Other engine\nProject rules\./);
  const receiptText=readFileSync(join(root,'.0-code/installation.json'),'utf8');assert.equal(receiptText.includes('private-fixture'),false);
  assert.equal(installProject(root).result.changed,0);
  assert.equal(upgradeProject(root).result.changed,0);
  const plugin=await import(pathToFileURL(join(root,'.opencode/plugins/0-code-safety-guard.js')).href);
  const guard=await plugin.SafetyGuard({directory:root});
  await assert.rejects(guard['tool.execute.before']({tool:'bash'},{args:{command:'git push --force'}}),/force/i);
  await guard['tool.execute.before']({tool:'bash'},{args:{command:'git status'}});
  uninstallProject(root);
  assert.equal(existsSync(join(root,'.0-code')),false);assert.deepEqual(projectFiles(root),before);
  assert.equal(existsSync(join(root,'docs/STATE.md')),true);assert.equal(existsSync(join(root,'docs/ROADMAP.md')),true);
});

test('native ownership survives a Git clone without private backups and preserves later owner additions',t=>{
  const area=fixture(t),root=join(area,'source');mkdirSync(root);
  const originals={'CLAUDE.md':'# Owner instructions\n','.claude/settings.json':'{ "owner":"private-fixture", "hooks":{"PreToolUse":[]} }\n'};
  for(const [path,bytes] of Object.entries(originals)){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),bytes);}
  installProject(root,{config:configuration()});
  const git=(cwd,args)=>{const result=spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return result.stdout;};
  git(root,['init']);git(root,['config','user.name','Verification']);git(root,['config','user.email','verification@invalid.local']);git(root,['add','.']);git(root,['commit','-m','Installed namespace']);
  assert.equal(git(root,['ls-files','.0-code/run']).trim(),'');
  assert.equal(readFileSync(join(root,'.0-code/installation.json'),'utf8').includes('private-fixture'),false);
  for(const action of ['uninstall','upgrade']) {
    const clone=join(area,action);git(area,['-c','core.autocrlf=true','clone',root,clone]);
    assert.equal(existsSync(join(clone,'.0-code/run/backups')),false);
    if(action==='upgrade') {
      const settings=JSON.parse(readFileSync(join(clone,'.claude/settings.json'),'utf8'));settings.env.LOCAL='later owner value';settings.newField=42;
      writeFileSync(join(clone,'.claude/settings.json'),JSON.stringify(settings,null,2)+'\r\n');
      const owned=doctorProject(clone,{env:{...process.env,PATH:''}}).checks.find(check=>check.id==='owned-files');assert.equal(owned.ok,true,owned.reason);
      upgradeProject(clone);assert.equal(installProject(clone).result.changed,0);
    }
    uninstallProject(clone);assert.equal(existsSync(join(clone,'.0-code')),false);
    assert.equal(readFileSync(join(clone,'CLAUDE.md'),'utf8'),originals['CLAUDE.md'].replaceAll('\n','\r\n'));
    const settings=JSON.parse(readFileSync(join(clone,'.claude/settings.json'),'utf8'));
    assert.equal(settings.owner,'private-fixture');assert.deepEqual(settings.hooks,{PreToolUse:[]});assert.equal(settings.permissions,undefined);
    if(action==='upgrade'){assert.deepEqual(settings.env,{LOCAL:'later owner value'});assert.equal(settings.newField,42);}
    else {assert.equal(settings.env,undefined);assert.equal(readFileSync(join(clone,'.claude/settings.json'),'utf8'),originals['.claude/settings.json'].replaceAll('\n','\r\n'));}
  }
});
test('a foreign Stop, guard, malformed settings or occupied framework path refuses before writes',t=>{
  for(const files of [
    {'.claude/settings.json':{hooks:{Stop:[{hooks:[{type:'command',command:'node own-loop.js'}]}]}}},
    {'.claude/settings.json':{hooks:{PreToolUse:[{hooks:[{type:'command',command:'node own-safety-guard.js'}]}]}}},
    {'.claude/settings.json':'null'},
    {'.claude/settings.json':'{broken'},
    {'.claude/settings.json':{permissions:{ask:['Bash(*)']}}},
    {'.0-code/own.txt':'project data'},
  ]) {
    const root=fixture(t,files),before=projectFiles(root);
    assert.throws(()=>installProject(root,{config:configuration()}));assert.deepEqual(projectFiles(root),before);
    if(files['.0-code/own.txt']) assert.equal(readFileSync(join(root,'.0-code/own.txt'),'utf8'),'project data');
    else assert.equal(existsSync(join(root,'.0-code')),false);
  }
});
test('custom roles preserve an existing plan and machine state and keep their own template priority',t=>{
  const state='---\nschema_version: 1\nproject_name: project\ncurrent_stage: 2\ncurrent_version: "7.0.0"\n---\n# Existing journal\n';
  const root=fixture(t,{'work/status.md':state,'CHANGELOG.md':'# Project history\n','patterns/cycle.md':'Own template'});
  const config=configuration({documents:{state:{path:'work/status.md'},roadmap:{path:'CHANGELOG.md'},templates:{path:'patterns'},decisions:{path:'docs/adr'}}});
  installProject(root,{config});assert.equal(readFileSync(join(root,'work/status.md'),'utf8'),state);
  assert.equal(readFileSync(join(root,'CHANGELOG.md'),'utf8'),'# Project history\n');assert.equal(existsSync(join(root,'docs/STATE.md')),false);
  uninstallProject(root);assert.equal(readFileSync(join(root,'work/status.md'),'utf8'),state);assert.equal(readFileSync(join(root,'patterns/cycle.md'),'utf8'),'Own template');
});
test('module changes add and remove owned assets, preserving the editable project configuration',t=>{
  const root=fixture(t);installProject(root,{config:configuration()});
  const configFile=join(root,'.0-code/config.json'),config=JSON.parse(readFileSync(configFile,'utf8'));
  config.modules.audits=true;config.modules.telegram=true;config.language='de';writeFileSync(configFile,JSON.stringify(config));
  const upgraded=upgradeProject(root);assert.ok(upgraded.result.changed>0);
  assert.equal(existsSync(join(root,'.0-code/core/audit-ledger.mjs')),true);
  assert.equal(existsSync(join(root,'.0-code/lib/telegram-notify.sh')),true);
  assert.equal(JSON.parse(readFileSync(configFile,'utf8')).language,'de');
  config.modules.audits=false;config.modules.telegram=false;writeFileSync(configFile,JSON.stringify(config));upgradeProject(root);
  assert.equal(existsSync(join(root,'.0-code/core/audit-ledger.mjs')),false);assert.equal(existsSync(join(root,'.0-code/lib/telegram-notify.sh')),false);
  uninstallProject(root);assert.equal(existsSync(join(root,'.0-code')),false);
});
test('modified installed files and new unowned files survive refused upgrade and uninstall',t=>{
  const root=fixture(t);installProject(root,{config:configuration()});
  const file=join(root,'.0-code/core/gates.mjs');writeFileSync(file,'changed after installation');
  assert.throws(()=>upgradeProject(root),/changed outside/);assert.throws(()=>uninstallProject(root),/changed outside/);
  assert.equal(readFileSync(file,'utf8'),'changed after installation');
  const other=fixture(t);installProject(other,{config:configuration()});writeFileSync(join(other,'.0-code/own.txt'),'project extension');
  assert.throws(()=>uninstallProject(other),/Unowned/);assert.equal(readFileSync(join(other,'.0-code/own.txt'),'utf8'),'project extension');
});
test('receipt and state ownership checks never accept arbitrary shapes or hash claims',t=>{
  const root=fixture(t,{'.0-code/installation.json':'{"schema_version":1}'});assert.throws(()=>readInstallationReceipt(root),/Invalid/);
  const other=fixture(t,{'docs/STATE.md':'# Human notes'});assert.throws(()=>installProject(other,{config:configuration()}),/machine state/);
  assert.equal(existsSync(join(other,'.0-code')),false);assert.equal(readFileSync(join(other,'docs/STATE.md'),'utf8'),'# Human notes');
});

test('doctor never executes a guard whose installed bytes failed ownership',t=>{
  const root=fixture(t);installProject(root,{config:configuration({engines:['codex']})});
  const marker=join(root,'unexpected-execution.txt');
  writeFileSync(join(root,'.0-code/core/backends/codex-hook.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');`);
  const report=doctorProject(root);assert.equal(report.ok,false);
  assert.equal(report.checks.find(check=>check.id==='owned-files').ok,false);
  assert.equal(report.checks.some(check=>check.id.startsWith('guard-')),false);
  assert.equal(existsSync(marker),false);
});

const matrix=[
  {name:'empty repository',files:{}},
  {name:'Python source folder collisions',files:{'core/main.py':'print("owner")\r\n','lib/data.py':'OWNER = True\n','hooks/check.py':'# Owner hook\n','pyproject.toml':'[project]\nname = "owner-project"\nversion = "1.0.0"\n'}},
  {name:'JS monorepo with native owner tools',files:{'package.json':JSON.stringify({name:'owner-monorepo',type:'commonjs',private:true,workspaces:['packages/*'],scripts:{test:'node --test'}}),
    'packages/app/main.js':'export const owner = true;\n','.claude/skills/owner-review/SKILL.md':'---\nname: owner-review\ndescription: Review the owner project.\n---\nUse its own tests.\n',
    '.claude/commands/owner-check.md':'Check the owner project using $ARGUMENTS.\n','.claude/settings.json':JSON.stringify({hooks:{PreToolUse:[{matcher:'Write',hooks:[{type:'command',command:'node owner-check.js'}]}]},env:{OWNER:'fixture'}}),
    'owner-check.js':'process.exit(0);\n','.mcp.json':JSON.stringify({mcpServers:{owner:{command:process.execPath,args:['owner-mcp.mjs']}}}),
    'owner-mcp.mjs':'process.stdin.resume();\n'}},
  {name:'custom document roles and existing CHANGELOG',files:{'CHANGELOG.md':'# Owner history\r\nKeep exactly.  \r\n','docs/adr/0001.md':'# Owner architecture\n','patterns/cycle.md':'# Owner cycle template\n'},
    config:{documents:{state:{path:'work/status.md'},roadmap:{path:'CHANGELOG.md'},decisions:{path:'docs/adr'},templates:{path:'patterns'}}}},
];
for(const item of matrix)test('lifecycle matrix: '+item.name,t=>{
  const root=fixture(t,item.files),before=new Map(Object.keys(item.files).map(path=>[path,readFileSync(join(root,path))]));
  const scan=scanProject(root);assert.ok(scan.inventory);assert.equal(existsSync(join(root,'.0-code')),false);
  if(item.name.startsWith('JS')){assert.ok(scan.inventory.tools.some(tool=>tool.kind==='mcp'));assert.ok(scan.inventory.checks.length>0);assert.equal(scan.conflicts.length,0);}
  const config=configuration(item.config),installed=installProject(root,{config});assert.ok(installed.result.changed>0);
  const doctor=doctorProject(root);assert.equal(doctor.ok,true,JSON.stringify(doctor.checks.filter(check=>!check.ok)));
  assert.equal(installProject(root).result.changed,0);assert.equal(upgradeProject(root).result.changed,0);
  uninstallProject(root);assert.equal(existsSync(join(root,'.0-code')),false);
  for(const [path,bytes] of before)assert.deepEqual(readFileSync(join(root,path)),bytes,path);
  const remaining=new Map(projectFiles(root));
  for(const path of before.keys())remaining.delete(path);
  const state=config.documents?.state?.path||'docs/STATE.md',roadmap=config.documents?.roadmap?.path||'docs/ROADMAP.md';
  remaining.delete(state);remaining.delete(roadmap);assert.equal(remaining.size,0,JSON.stringify([...remaining.keys()]));
  t.diagnostic(JSON.stringify({case:item.name,doctor:true,engines:doctor.checks.filter(check=>check.id.startsWith('engine-')).map(check=>check.id.slice(7)),repeat_changed:0,upgrade_changed:0,owner_files:before.size,owner_bytes_preserved:true}));
});
