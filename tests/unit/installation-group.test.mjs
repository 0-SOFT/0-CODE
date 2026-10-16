import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { InstallationPlan, applyInstallationPlan, recoverInstallation, GROUP_JOURNAL, hashBytes } from '../../core/installation-transaction.mjs';
import { applyInstallationGroup, recoverInstallationGroup } from '../../core/installation-group.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
import { holdWindowsReadLock } from '../helpers/windows-file-lock.mjs';
const repo=fileURLToPath(new URL('../../',import.meta.url)),base=join(dirname(repo.replace(/[\\/]$/,'')),'scratch','tmp');mkdirSync(base,{recursive:true});
function fixture(t) {const root=mkdtempSync(join(base,'group-'));t.after(()=>cleanupTempDir(root));
  const project=join(root,'project'),profile=join(root,'profile');mkdirSync(project);mkdirSync(profile);return {root,project,profile};}
function put(root,path,value) {mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),value);}
function plan(root,path,value,overwrite=true) {const result=new InstallationPlan(root);result.change(path,value,{overwrite});return result;}
test('coordinated plans preflight all actual roots, preserve earlier scopes on collision and reject overlapping capabilities',t=>{
  const {project,profile}=fixture(t);put(profile,'settings.json','Owner settings\r\n');
  const a=plan(project,'added.md','new'),b=plan(profile,'settings.json','replaced',false);
  assert.throws(()=>applyInstallationGroup([a,b]),/intersections/);
  assert.deepEqual(readdirSync(project),[]);assert.deepEqual(readdirSync(profile),['settings.json']);
  assert.throws(()=>applyInstallationGroup([a,plan(join(project,'nested'),'native','new')]),/overlap/);
  assert.throws(()=>applyInstallationGroup([a,a]),/distinct/);
  assert.throws(()=>applyInstallationGroup([a],{primary:profile}),/authorized/);
  assert.throws(()=>applyInstallationGroup([]),/ordinary/);
  assert.throws(()=>new InstallationPlan(project).change(GROUP_JOURNAL,'new'),/internals/);
});
test('coordinated commit applies both roots, cleans journals, retains runtime ignore and repeats without writing',t=>{
  const {project,profile}=fixture(t);put(profile,'settings.json','Owner settings\r\n');
  assert.deepEqual(applyInstallationGroup([plan(project,'added.md','new'),plan(profile,'settings.json','Owner settings\r\nNative link\n')]),{changed:2,roots:2});
  assert.equal(readFileSync(join(profile,'settings.json'),'utf8'),'Owner settings\r\nNative link\n');
  for(const root of [project,profile]) {assert.equal(existsSync(join(root,GROUP_JOURNAL)),false);assert.equal(existsSync(join(root,'.0-code/run/installation.lock')),false);
    assert.equal(readFileSync(join(root,'.0-code/run/.gitignore'),'utf8'),'*\n');}
  assert.deepEqual(recoverInstallationGroup(project,[project,profile]),{recovered:false});
  assert.deepEqual(applyInstallationGroup([plan(project,'added.md','new'),plan(profile,'settings.json','Owner settings\r\nNative link\n')]),{changed:0});
});
test('bounded native files can share the home ancestor with a project, without authorizing any other home file',t=>{
  const {root,project,profile}=fixture(t),allowedPaths=[{path:'.claude.json',recursive:false}];
  const home=new InstallationPlan(root,{allowedPaths});home.change('.claude.json','Native user registry');
  assert.throws(()=>home.change('auth.json','never'),/authorized native/);
  assert.throws(()=>new InstallationPlan(root,{allowedPaths:[{path:'../outside',recursive:true}]}));
  assert.throws(()=>new InstallationPlan(root,{allowedPaths:[{path:'native',recursive:'yes'}]}),/Invalid authorized/);
  assert.deepEqual(applyInstallationGroup([home,plan(project,'AGENTS.md','Project rules')],{primary:project}),{changed:2,roots:2});
  assert.equal(readFileSync(join(root,'.claude.json'),'utf8'),'Native user registry');
  const overlapping=new InstallationPlan(root,{allowedPaths:[{path:'profile',recursive:true}]});overlapping.change('profile/added','new');
  assert.throws(()=>applyInstallationGroup([overlapping,plan(profile,'other','new')]),/overlap/);
  const group=recoveryFiles(project,root);
  assert.throws(()=>recoverInstallationGroup(project,[project,{root,allowedPaths}]),/authorized native/);
  assert.equal(readFileSync(join(root,'added'),'utf8'),'after');
});
test('a persistent real Windows lock in the final scope rolls back files already published in the earlier scope',
  {skip:process.platform!=='win32'},async t=>{
    const {project,profile}=fixture(t),roots=[project,profile].sort((a,b)=>hashBytes(Buffer.from(a.toLowerCase())).localeCompare(hashBytes(Buffer.from(b.toLowerCase())),'en'));
    for(const root of roots)put(root,'settings.json','Owner settings\r\n');
    const plans=roots.map(root=>plan(root,'settings.json','Installed settings'));
    const reader=await holdWindowsReadLock(join(roots[1],'settings.json'),0);
    try {
      assert.throws(()=>applyInstallationGroup(plans,{primary:project}),error=>{
        t.diagnostic(`Rollback trigger: ${error.code}; ${error.message}`);
        return ['EPERM','EACCES','EBUSY'].includes(error.code);
      });
      for(const root of roots) {
        assert.equal(readFileSync(join(root,'settings.json'),'utf8'),'Owner settings\r\n');
        assert.equal(existsSync(join(root,GROUP_JOURNAL)),false);
        if(existsSync(join(root,'.0-code')))t.diagnostic(`Remaining runtime: ${JSON.stringify(readdirSync(join(root,'.0-code'),{recursive:true}))}`);
        assert.equal(existsSync(join(root,'.0-code')),false);
      }
    }finally {reader.release();assert.equal(await reader.closed,0);}
  });
test('a real writer killed during cross-root installation restores both scopes; unknown edits and capabilities refuse before recovery',async t=>{
  const {project,profile}=fixture(t),roots=[project,profile];
  for(const root of roots)put(root,'settings.json','Owner settings\r\n');
  let child,stopped=false;
  const watchers=roots.map(root=>watch(root,(_event,file)=>{if(file?.toString()==='checkpoint'&&child&&!stopped){stopped=true;child.kill('SIGKILL');}}));
  let stderr='';
  try {
    child=spawn(process.execPath,[fileURLToPath(new URL('../helpers/installation-group-worker.mjs',import.meta.url)),...roots],{stdio:['ignore','ignore','pipe'],windowsHide:true,shell:false});
    child.stderr.on('data',part=>{stderr+=part;});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Real installation writer never reached checkpoint'));},20000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);assert.notEqual(code,0,stderr);resolve();});});
  }finally {watchers.forEach(watcher=>watcher.close());if(child?.exitCode===null)child.kill('SIGKILL');}
  assert.equal(stopped,true);assert.equal(existsSync(join(project,GROUP_JOURNAL)),true);
  assert.throws(()=>recoverInstallation(project),/authorized profile roots/);
  assert.throws(()=>applyInstallationPlan(plan(profile,'unrelated','new')),/authorized profile roots/);
  assert.throws(()=>recoverInstallationGroup(project,[project]),/exact authorized/);
  const checkpoint=roots.find(root=>existsSync(join(root,'checkpoint'))),known=readFileSync(join(checkpoint,'checkpoint'));
  put(checkpoint,'checkpoint','Owner later edit');
  assert.throws(()=>recoverInstallationGroup(project,roots),/changed file/);
  assert.equal(readFileSync(join(checkpoint,'checkpoint'),'utf8'),'Owner later edit');
  assert.equal(existsSync(join(project,GROUP_JOURNAL)),true);put(checkpoint,'checkpoint',known);
  const result=recoverInstallationGroup(project,roots);assert.equal(result.recovered,true);assert.equal(result.committed,false);
  for(const root of roots) {
    assert.equal(readFileSync(join(root,'settings.json'),'utf8'),'Owner settings\r\n');
    assert.equal(existsSync(join(root,'checkpoint')),false);assert.equal(existsSync(join(root,'pending')),false);
    assert.equal(existsSync(join(root,'.0-code')),false);
  }
});
function recoveryFiles(project,profile,{phase='applying'}={}) {
  const id='12345678-1234-4234-8234-123456789abc',idOf=root=>hashBytes(Buffer.from(process.platform==='win32'?root.toLowerCase():root));
  const group={schema_version:2,id,primary:idOf(project),phase,scopes:[project,profile].map(root=>({id:idOf(root),runtimeIgnoreCreated:true,
    missingDirectories:['.0-code','.0-code/run'],changes:[{path:'added',before:null,beforeHash:null,beforeMode:null,afterHash:hashBytes(Buffer.from('after'))}]}))};
  for(const root of [project,profile]) {put(root,'added','after');put(root,'.0-code/run/.gitignore','*\n');
    put(root,GROUP_JOURNAL,JSON.stringify(root===project?group:{schema_version:2,id,primary:group.primary})+'\n');}
  return group;
}
test('committed recovery finishes cleanup and retains successful bytes; foreign markers and active locks are preserved',t=>{
  const {project,profile}=fixture(t),roots=[project,profile];recoveryFiles(project,profile,{phase:'committed'});
  assert.equal(recoverInstallationGroup(project,roots).committed,true);
  for(const root of roots){assert.equal(readFileSync(join(root,'added'),'utf8'),'after');assert.equal(existsSync(join(root,GROUP_JOURNAL)),false);}
  const other=fixture(t),group=recoveryFiles(other.project,other.profile);
  put(other.profile,GROUP_JOURNAL,JSON.stringify({schema_version:2,id:'foreign',primary:group.primary})+'\n');
  assert.throws(()=>recoverInstallationGroup(other.project,[other.project,other.profile]),/another transaction/);
  put(other.profile,GROUP_JOURNAL,JSON.stringify({schema_version:2,id:group.id,primary:group.primary})+'\n');
  put(other.profile,'.0-code/run/installation.lock/owner.json',JSON.stringify({pid:process.pid,host:hostname()}));
  assert.throws(()=>recoverInstallationGroup(other.project,[other.project,other.profile]),/active/);
  assert.equal(readFileSync(join(other.project,'added'),'utf8'),'after');
  assert.equal(existsSync(join(other.project,GROUP_JOURNAL)),true);
});
test('malformed journals and native runtime intersections cannot authorize a write',t=>{
  const {project,profile}=fixture(t),roots=[project,profile];
  put(project,GROUP_JOURNAL,'{}');assert.throws(()=>recoverInstallationGroup(project,roots),/Invalid/);
  assert.throws(()=>recoverInstallationGroup(profile,roots),/primary.*missing/);
  assert.throws(()=>applyInstallationGroup([plan(project,'new','new'),plan(profile,'new','new')]),/Recover unfinished/);
  const other=fixture(t);put(other.profile,'.0-code/run/.gitignore','Owner ignore');
  assert.throws(()=>applyInstallationGroup([plan(other.project,'new','new'),plan(other.profile,'new','new')]),/existing data/);
  assert.equal(existsSync(join(other.project,'new')),false);
  const group=recoveryFiles(other.project,other.profile);group.scopes[0].changes[0].path='../outside';put(other.project,GROUP_JOURNAL,JSON.stringify(group)+'\n');
  assert.throws(()=>recoverInstallationGroup(other.project,[other.project,other.profile]));
  assert.equal(readFileSync(join(other.profile,'added'),'utf8'),'after');
});
