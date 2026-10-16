import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,readdirSync,unlinkSync,linkSync,symlinkSync,lstatSync,readlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {GROUP_JOURNAL,InstallationPlan,applyInstallationPlan,hashBytes,recoverInstallation,transactionIO} from '../../core/installation-transaction.mjs';
import {recoverInstallationGroup} from '../../core/installation-group.mjs';
import {cleanupTempDir} from '../helpers/index.mjs';
const repo=fileURLToPath(new URL('../../',import.meta.url)),base=join(dirname(repo.replace(/[\\/]$/,'')),'scratch','tmp');
mkdirSync(base,{recursive:true});
function fixture(t,nativeLinks=false) {
  // The workspace drive rejects links; use a disposable native Windows temp directory for link controls.
  const parent=nativeLinks&&process.platform==='win32'?join(process.env.LOCALAPPDATA,'Temp'):base;
  const area=mkdtempSync(join(parent,'staging-'));t.after(()=>cleanupTempDir(area));
  const roots=['project','profile'].map(name=>{const root=join(area,name);mkdirSync(root);writeFileSync(join(root,'settings.json'),'Owner settings\r\n');return root;});
  return {area,roots};
}
const rootFor=(roots,id)=>roots.find(root=>hashBytes(Buffer.from(process.platform==='win32'?root.toLowerCase():root))===id);
async function interrupted(t,mode,phase,roots) {
  const child=spawn(process.execPath,[fileURLToPath(new URL('../helpers/installation-staging-worker.mjs',import.meta.url)),mode,phase,...roots],
    {stdio:['ignore','pipe','pipe'],windowsHide:true,shell:false});
  let output='',stderr='',checkpoint;
  child.stderr.on('data',part=>{stderr+=part;});
  child.stdout.on('data',part=>{
    output+=part;
    if(!checkpoint&&output.includes('\n')) {checkpoint=JSON.parse(output.split('\n')[0]);child.kill('SIGKILL');}
  });
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const code=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Writer never reached real staging checkpoint: '+stderr));},30000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{clearTimeout(timer);resolve(code);});
  });
  assert.notEqual(code,0,stderr);assert.ok(checkpoint,stderr);assert.equal(checkpoint.phase,phase);
  assert.equal(existsSync(checkpoint.path),true);return checkpoint;
}
function restored(roots) {
  for(const root of roots) {
    assert.equal(readFileSync(join(root,'settings.json'),'utf8'),'Owner settings\r\n');
    assert.deepEqual(readdirSync(root),['settings.json']);
  }
}
function snapshot(root) {
  return readdirSync(root,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>{
    const path=join(entry.parentPath??entry.path,entry.name);return [path,readFileSync(path).toString('base64')];
  }).sort(([a],[b])=>a.localeCompare(b));
}
test('SIGKILL after actual entry, runtime-ignore and commit staging restores every coordinated root',async t=>{
  for(const phase of ['entry','ignore','commit']) {
    const {roots}=fixture(t),checkpoint=await interrupted(t,'group',phase,roots);
    const group=JSON.parse(readFileSync(join(roots[0],GROUP_JOURNAL),'utf8'));
    if(phase==='entry') {
      const leg=group.scopes.find(leg=>leg.changes.some(entry=>join(rootFor(roots,leg.id),entry.staging)===checkpoint.path));
      assert.ok(leg);assert.equal(hashBytes(readFileSync(checkpoint.path)),leg.changes.find(entry=>entry.path==='pending/0.bin').afterHash);
    }
    assert.deepEqual(recoverInstallationGroup(roots[0],roots),{recovered:true,committed:false,files:4});restored(roots);
  }
});
test('single-root journals record staging before the first runtime-ignore write',async t=>{
  for(const phase of ['entry','ignore']) {
    const {roots}=fixture(t);await interrupted(t,'single',phase,[roots[0]]);
    assert.deepEqual(recoverInstallation(roots[0]),{recovered:true,files:2});restored(roots);
  }
});
test('a second real SIGKILL during rollback reuses the registered staging path on the next recovery',async t=>{
  const {roots}=fixture(t);await interrupted(t,'group','entry',roots);
  const checkpoint=await interrupted(t,'group-recover','recovery',roots);
  assert.equal(readFileSync(checkpoint.path,'utf8'),'Owner settings\r\n');
  assert.equal(recoverInstallationGroup(roots[0],roots).recovered,true);restored(roots);
});
test('unknown, partial or hard-linked staging refuses all scopes before changing files or journals',async t=>{
  const {area,roots}=fixture(t,true),checkpoint=await interrupted(t,'group','entry',roots);
  const known=readFileSync(checkpoint.path),group=JSON.parse(readFileSync(join(roots[0],GROUP_JOURNAL),'utf8'));
  const other=group.scopes.find(leg=>!leg.changes.some(entry=>join(rootFor(roots,leg.id),entry.staging)===checkpoint.path));
  // Put unknown bytes in the other scope while the original known stage still exists.
  const stageRoot=rootFor(roots,other.id);
  const stage=join(stageRoot,other.changes.find(entry=>entry.path==='pending/0.bin').staging);mkdirSync(dirname(stage),{recursive:true});
  for(const bytes of [Buffer.from('Owner later edit'),known.subarray(0,128)]) {
    writeFileSync(stage,bytes);const before=snapshot(area);
    assert.throws(()=>recoverInstallationGroup(roots[0],roots),/changed staging/);assert.deepEqual(snapshot(area),before);
  }
  unlinkSync(stage);const owner=join(area,'owner.bin');writeFileSync(owner,known);
  linkSync(owner,stage);
  const beforeLink=snapshot(area);assert.throws(()=>recoverInstallationGroup(roots[0],roots),/ordinary/);assert.deepEqual(snapshot(area),beforeLink);unlinkSync(stage);
  if(process.platform!=='win32') {
    symlinkSync(owner,stage);const before=snapshot(area);
    assert.throws(()=>recoverInstallationGroup(roots[0],roots),/ordinary|link/i);assert.deepEqual(snapshot(area),before);
    assert.equal(lstatSync(stage).isSymbolicLink(),true);assert.equal(readlinkSync(stage),owner);unlinkSync(stage);
  }
  assert.equal(recoverInstallationGroup(roots[0],roots).recovered,true);restored(roots);
});
test('staging validation rejects wrong parents and overlapping targets, and failed exclusive create preserves owner bytes',t=>{
  const {roots}=fixture(t),root=roots[0],stage=transactionIO.stagingPath('pending/file');
  assert.throws(()=>transactionIO.validateStaging(root,stage,'elsewhere/file'),/staging path/);
  assert.throws(()=>transactionIO.validateStaging(root,stage,'pending/file',[stage+'/child']),/staging path/);
  assert.throws(()=>transactionIO.validateStaging(root,stage,'pending/file',[stage.replaceAll('/','\\')]),/staging path/);
  const change=path=>({path,before:null,beforeHash:null,beforeMode:null,afterHash:hashBytes(Buffer.from('after'))});
  assert.throws(()=>transactionIO.validJournal(root,{schema_version:1,missingDirectories:[],changes:[{...change('pending/file'),staging:stage},change(stage.replaceAll('/','\\'))]}),/staging path/);
  mkdirSync(dirname(join(root,stage)),{recursive:true});writeFileSync(join(root,stage),'Owner stage');
  assert.throws(()=>transactionIO.publish(root,'pending/file',Buffer.from('Installed'),0o644,null,stage),error=>error.code==='EEXIST');
  assert.equal(readFileSync(join(root,stage),'utf8'),'Owner stage');assert.equal(existsSync(join(root,'pending/file')),false);
});

test('unknown runtime-ignore and commit staging preserves every file and marker before recovery',async t=>{
  for(const phase of ['ignore','commit']) {
    const {area,roots}=fixture(t),checkpoint=await interrupted(t,'group',phase,roots),known=readFileSync(checkpoint.path);
    writeFileSync(checkpoint.path,'Owner staging edit');const before=snapshot(area);
    assert.throws(()=>recoverInstallationGroup(roots[0],roots),/changed staging/);assert.deepEqual(snapshot(area),before);
    writeFileSync(checkpoint.path,known);assert.equal(recoverInstallationGroup(roots[0],roots).recovered,true);restored(roots);
  }
});
test('exclusive-create conflicts retain matching foreign bytes, journals and a permanent recovery refusal in both apply APIs',t=>{
  for(const mode of ['single','group'])for(const phase of ['collide','collide-sidecar-failure']) {
    const {area,roots}=fixture(t),authorized=mode==='single'?[roots[0]]:roots;
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../helpers/installation-staging-worker.mjs',import.meta.url)),mode,phase,...authorized],
      {encoding:'utf8',windowsHide:true,shell:false});
    assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/ownership conflict/);
    const journalPath=mode==='single'?transactionIO.JOURNAL:GROUP_JOURNAL,journal=JSON.parse(readFileSync(join(roots[0],journalPath),'utf8'));
    const legs=mode==='single'?[{root:roots[0],...journal}]:journal.scopes.map(leg=>({root:rootFor(roots,leg.id),...leg}));
    const stage=legs.flatMap(leg=>leg.changes.map(entry=>({root:leg.root,path:join(leg.root,entry.staging),entry}))).find(value=>existsSync(value.path));
    assert.ok(stage);assert.equal(hashBytes(readFileSync(stage.path)),stage.entry.afterHash);
    const markers=authorized.filter(root=>existsSync(join(root,journalPath+'.staging-conflict')));
    assert.deepEqual(markers,phase==='collide'?[stage.root]:[]);
    const before=snapshot(area);
    assert.throws(()=>mode==='single'?recoverInstallation(roots[0]):recoverInstallationGroup(roots[0],roots),/ownership conflict/);
    const next=new InstallationPlan(roots[0]);next.change('later','new');
    assert.throws(()=>applyInstallationPlan(next),/ownership conflict|authorized profile roots|Unfinished installation transaction/);
    assert.deepEqual(snapshot(area),before);
    assert.throws(()=>new InstallationPlan(roots[0]).change(journalPath+'.staging-conflict/child','never'),/internals/);
  }
});
test('a stage changed after a successful real write is never renamed or removed',t=>{
  const {area,roots}=fixture(t),result=spawnSync(process.execPath,[fileURLToPath(new URL('../helpers/installation-staging-worker.mjs',import.meta.url)),'group','mutate',...roots],
    {encoding:'utf8',windowsHide:true,shell:false});
  assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/recovery journal retained/);
  const group=JSON.parse(readFileSync(join(roots[0],GROUP_JOURNAL),'utf8'));
  const stages=group.scopes.flatMap(leg=>leg.changes.map(entry=>({root:rootFor(roots,leg.id),entry})));
  const stage=stages.find(value=>existsSync(join(value.root,value.entry.staging)));assert.ok(stage);
  assert.equal(readFileSync(join(stage.root,stage.entry.staging),'utf8'),'Owner changed after stage write');
  assert.equal(existsSync(join(stage.root,stage.entry.path)),false);const before=snapshot(area);
  assert.throws(()=>recoverInstallationGroup(roots[0],roots),/changed staging/);assert.deepEqual(snapshot(area),before);
});

test('same-hash exclusive-create conflicts during recovery and automatic rollback remain permanently blocked',async t=>{
  for(const mode of ['single','group'])for(const operation of ['recover','rollback']) {
    const {area,roots}=fixture(t),authorized=mode==='single'?[roots[0]]:roots;
    if(operation==='recover')await interrupted(t,mode,'entry',authorized);
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../helpers/installation-staging-worker.mjs',import.meta.url)),
      operation==='recover'?mode+'-recover':mode,operation==='recover'?'collide-recovery':'collide-rollback',...authorized],{encoding:'utf8',windowsHide:true,shell:false});
    assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/ownership conflict|recovery journal retained|EEXIST/);
    assert.ok(authorized.some(root=>existsSync(join(root,(mode==='single'?transactionIO.JOURNAL:GROUP_JOURNAL)+'.staging-conflict'))));
    const before=snapshot(area);
    assert.throws(()=>mode==='single'?recoverInstallation(roots[0]):recoverInstallationGroup(roots[0],roots),/ownership conflict/);
    assert.deepEqual(snapshot(area),before);
  }
});
test('a hard-linked lock owner is preserved when a failed sidecar cannot record a staging conflict',t=>{
  for(const mode of ['single','group']) {
    const {area,roots}=fixture(t,true),authorized=mode==='single'?[roots[0]]:roots;
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../helpers/installation-staging-worker.mjs',import.meta.url)),mode,'collide-owner-hardlink',...authorized],
      {encoding:'utf8',windowsHide:true,shell:false});
    assert.equal(result.status,1,result.stderr);
    const shared=authorized.map(root=>join(root,'shared-owner.json')).find(existsSync);assert.ok(shared);
    const journal=JSON.parse(readFileSync(join(roots[0],mode==='single'?transactionIO.JOURNAL:GROUP_JOURNAL),'utf8'));
    const legs=mode==='single'?[{root:roots[0],...journal}]:journal.scopes.map(leg=>({root:rootFor(roots,leg.id),...leg}));
    const stage=legs.flatMap(leg=>leg.changes.map(entry=>({path:join(leg.root,entry.staging),entry}))).find(value=>existsSync(value.path));
    assert.ok(stage);assert.equal(hashBytes(readFileSync(stage.path)),stage.entry.afterHash);
    const owner=JSON.parse(readFileSync(shared,'utf8'));assert.equal(owner.pid,result.pid);assert.equal(owner.stagingConflict,undefined);
    assert.equal(lstatSync(shared).nlink,2);const before=snapshot(area);
    assert.throws(()=>mode==='single'?recoverInstallation(roots[0]):recoverInstallationGroup(roots[0],roots),/ordinary|ownership cannot be verified/);
    assert.deepEqual(snapshot(area),before);
  }
});
test('coordinated recovery records a rollback collision even when its secondary marker is missing',async t=>{
  const {area,roots}=fixture(t),id=root=>hashBytes(Buffer.from(process.platform==='win32'?root.toLowerCase():root));
  const authorized=[...roots].sort((a,b)=>id(b).localeCompare(id(a),'en'));
  await interrupted(t,'group','entry',authorized);
  assert.equal(readFileSync(join(authorized[1],'settings.json'),'utf8'),'Installed settings');
  unlinkSync(join(authorized[1],GROUP_JOURNAL));
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../helpers/installation-staging-worker.mjs',import.meta.url)),'group-recover','collide-recovery',...authorized],
    {encoding:'utf8',windowsHide:true,shell:false});
  assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/EEXIST/);
  assert.equal(existsSync(join(authorized[1],GROUP_JOURNAL+'.staging-conflict')),true);
  const before=snapshot(area);assert.throws(()=>recoverInstallationGroup(authorized[0],authorized),/ownership conflict/);assert.deepEqual(snapshot(area),before);
});
