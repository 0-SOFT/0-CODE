import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { InstallationPlan, applyInstallationPlan, fileSnapshot, hashBytes, recoverInstallation } from '../../core/installation-transaction.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const scratch=join(dirname(root.replace(/[\\/]$/,'')),'scratch','tmp');mkdirSync(scratch,{recursive:true});
function fixture(t,nativeLinks=false) { const dir=mkdtempSync(join(nativeLinks?tmpdir():scratch,'transaction-'));t.after(()=>cleanupTempDir(dir));return dir; }
function put(root,path,bytes) {mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),bytes);}

test('a conflicting plan leaves every project byte and directory untouched',t=>{
  const root=fixture(t);put(root,'AGENTS.md','own rules\r\n');
  const plan=new InstallationPlan(root);plan.change('.0-code/VERSION','2.0.0\n');plan.change('AGENTS.md','replacement');
  assert.throws(()=>applyInstallationPlan(plan),/intersections/);
  assert.deepEqual(readdirSync(root),['AGENTS.md']);assert.equal(readFileSync(join(root,'AGENTS.md'),'utf8'),'own rules\r\n');
});
test('successful transaction creates, appends and deletes using the observed original bytes',t=>{
  const root=fixture(t);put(root,'AGENTS.md','own rules\r\n');put(root,'obsolete.txt','obsolete');
  const plan=new InstallationPlan(root);plan.change('.0-code/VERSION','2.0.0\n');
  plan.change('AGENTS.md','own rules\r\n\nframework link\n',{overwrite:true});plan.change('obsolete.txt',null,{overwrite:true});
  assert.equal(applyInstallationPlan(plan).changed,3);
  assert.equal(readFileSync(join(root,'.0-code/VERSION'),'utf8'),'2.0.0\n');assert.equal(existsSync(join(root,'obsolete.txt')),false);
  assert.equal(readFileSync(join(root,'.0-code/run/.gitignore'),'utf8'),'*\n');
  assert.equal(existsSync(join(root,'.0-code/run/installation-transaction.json')),false);
  assert.deepEqual(plan.summary().map(entry=>entry.operation),['create','update','remove']);
  assert.deepEqual(recoverInstallation(root),{recovered:false});
});
test('same bytes are a no-op; stale ownership and edits after planning refuse before writing',t=>{
  const root=fixture(t);put(root,'keep.txt','first');
  const noop=new InstallationPlan(root);assert.equal(noop.change('keep.txt','first'),false);assert.equal(applyInstallationPlan(noop).changed,0);
  assert.equal(existsSync(join(root,'.0-code')),false);
  const stale=new InstallationPlan(root);stale.change('keep.txt','second',{overwrite:true,expectedHash:hashBytes(Buffer.from('old'))});
  assert.throws(()=>applyInstallationPlan(stale),/intersections/);
  const changed=new InstallationPlan(root);changed.change('keep.txt','second',{overwrite:true});put(root,'keep.txt','editor change');
  assert.throws(()=>applyInstallationPlan(changed),/target changed/);assert.equal(readFileSync(join(root,'keep.txt'),'utf8'),'editor change');
});
test('directory and parent-child intersections cannot cause a partial installation',t=>{
  const root=fixture(t);mkdirSync(join(root,'directory'));
  assert.throws(()=>new InstallationPlan(root).change('directory','bytes'),/ordinary/);
  const overlap=new InstallationPlan(root);overlap.change('file','bytes');overlap.change('file/child','bytes');
  assert.throws(()=>applyInstallationPlan(overlap),/overlap/);assert.equal(existsSync(join(root,'file')),false);
  assert.throws(()=>new InstallationPlan(root).change('../outside','bytes'));
  assert.throws(()=>new InstallationPlan(root).change('.git/config','bytes'));
  assert.throws(()=>new InstallationPlan(root).change('.0-code/run/installation-transaction.json','bytes'),/internals/);
});
function crashJournal(root,{edited=false}={}) {
  const before=Buffer.from('original private settings\r\n'),after=Buffer.from('installed settings');
  put(root,'settings.json',edited?'later edit':after);put(root,'added.txt','new file');
  const journal={schema_version:1,missingDirectories:['.0-code','.0-code/run'],changes:[
    {path:'settings.json',before:before.toString('base64'),beforeHash:hashBytes(before),beforeMode:0o644,afterHash:hashBytes(after)},
    {path:'added.txt',before:null,beforeHash:null,beforeMode:null,afterHash:hashBytes(Buffer.from('new file'))},
  ]};put(root,'.0-code/run/installation-transaction.json',JSON.stringify(journal));return before;
}
test('real files from an interrupted transaction restore exactly and remove added files',t=>{
  const root=fixture(t),before=crashJournal(root);
  assert.deepEqual(recoverInstallation(root),{recovered:true,files:2});
  assert.deepEqual(readFileSync(join(root,'settings.json')),before);assert.equal(existsSync(join(root,'added.txt')),false);
  assert.equal(existsSync(join(root,'.0-code')),false);
});
test('recovery detects edits and active locks without overwriting or discarding its journal',t=>{
  const root=fixture(t);crashJournal(root,{edited:true});assert.throws(()=>recoverInstallation(root),/intersection/);
  assert.equal(readFileSync(join(root,'settings.json'),'utf8'),'later edit');assert.equal(existsSync(join(root,'added.txt')),true);
  put(root,'.0-code/run/installation.lock/owner.json',JSON.stringify({pid:process.pid,host:hostname()}));assert.throws(()=>recoverInstallation(root),/active/);
  assert.equal(existsSync(join(root,'.0-code/run/installation-transaction.json')),true);
});
test('recovery releases a lock only when its recorded local process has really exited',t=>{
  const root=fixture(t);crashJournal(root);
  const exited=spawnSync(process.execPath,['--version'],{encoding:'utf8'});assert.equal(exited.status,0);
  put(root,'.0-code/run/installation.lock/owner.json',JSON.stringify({pid:exited.pid,host:hostname()}));
  assert.equal(recoverInstallation(root).recovered,true);assert.equal(existsSync(join(root,'.0-code')),false);
});
test('malformed recovery journals and a foreign runtime ignore cannot be applied',t=>{
  const root=fixture(t);put(root,'.0-code/run/installation-transaction.json','{"schema_version":1}');
  assert.throws(()=>recoverInstallation(root),/Invalid/);
  const other=fixture(t);put(other,'.0-code/run/.gitignore','project-owned ignore');const plan=new InstallationPlan(other);plan.change('new','text');
  assert.throws(()=>applyInstallationPlan(plan),/intersects/);assert.equal(existsSync(join(other,'new')),false);
  assert.equal(fileSnapshot(other,'absent').hash,null);
});

const transactionModule = new URL('../../core/installation-transaction.mjs',import.meta.url).href;
function cleanupFailure(root,mode) {
  const source=`
    import fs from 'node:fs';
    import {join,resolve} from 'node:path';
    import {syncBuiltinESMExports} from 'node:module';
    import {InstallationPlan,applyInstallationPlan,enterCycleRelocationGuard,transactionIO} from ${JSON.stringify(transactionModule)};
    import {enterLoopMutationAt} from ${JSON.stringify(new URL('../../core/loop-lock.mjs',import.meta.url).href)};
    const root=process.argv[1],mode=process.argv[2],rmdir=fs.rmdirSync;
    const paths=['.loop.lock','.0-code/run/.loop.lock'];
    fs.rmdirSync=(path,...args)=>{
      const target=join(root,mode==='mutex'?'.0-code/run/.loop.lock.guard':'.0-code/run');
      if(!mode.endsWith('-clean')&&typeof path==='string'&&resolve(path)===resolve(target))throw Object.assign(new Error('injected cleanup '+mode),{code:mode.includes('EIO')?'EIO':'EBUSY'});
      return rmdir(path,...args);
    };
    syncBuiltinESMExports();
    const plan=new InstallationPlan(root);let preflights=0,result,error;
    if(mode!=='noop'&&mode!=='owner')plan.change('result.txt','committed bytes');
    plan.cycleLockPaths=paths;
    plan.enterGuard=()=>enterCycleRelocationGuard(root,paths);
    plan.preflight=()=>{
      if(++preflights!==2)return;
      if(mode==='preflight-null')throw null;
      if(mode==='preflight-undefined')throw undefined;
      if(mode==='preflight-zero'||mode==='preflight-zero-clean')throw 0;
      if(mode==='preflight-empty')throw '';
      if(mode==='preflight-frozen')throw Object.freeze(new Error('frozen preflight refusal'));
      if(mode.startsWith('preflight'))throw new Error('original preflight refusal');
      if(mode==='owner')fs.writeFileSync(join(root,'.0-code/run/owner.txt'),'owner runtime bytes');
    };
    try {
      if(mode==='shared'){fs.mkdirSync(join(root,'.0-code/run'),{recursive:true});transactionIO.removeEmpty(root,['.0-code/run']);}
      else result=applyInstallationPlan(plan);
    }catch(failure){
      const describe=value=>({type:typeof value,isNull:value===null,isUndefined:value===undefined,
        primitive:typeof value==='string'||typeof value==='number'?value:undefined,
        frozenError:value instanceof Error?Object.isFrozen(value):undefined,message:value?.message,code:value?.code});
      error={...describe(failure),name:failure?.name,cleanupWarnings:failure?.cleanupWarnings,
        cause:failure&&Object.hasOwn(failure,'cause')?describe(failure.cause):undefined,errors:failure?.errors?.map(describe)};
    }
    const rootGuardReleased=!fs.existsSync(join(root,'.loop.lock.guard'));
    const runtimeGuardReleased=!fs.existsSync(join(root,'.0-code/run/.loop.lock.guard'));
    const installationLockReleased=!fs.existsSync(join(root,'.0-code/run/installation.lock'));
    let reacquired=false;
    if(rootGuardReleased&&runtimeGuardReleased){const leaves=paths.map(path=>enterLoopMutationAt(join(root,path)));reacquired=leaves.every(Boolean);for(const leave of leaves.reverse())leave?.();}
    console.log(JSON.stringify({result,error,rootGuardReleased,runtimeGuardReleased,installationLockReleased,reacquired,
      owner:fs.readFileSync(join(root,'owner.txt'),'utf8'),
      runtimeOwner:fs.existsSync(join(root,'.0-code/run/owner.txt'))?fs.readFileSync(join(root,'.0-code/run/owner.txt'),'utf8'):null,
      committed:fs.existsSync(join(root,'result.txt'))?fs.readFileSync(join(root,'result.txt'),'utf8'):null}));
  `;
  return spawnSync(process.execPath,['--input-type=module','-e',source,root,mode],{encoding:'utf8',windowsHide:true,shell:false,timeout:10000});
}
test('guard directory EBUSY keeps committed and no-op results explicit after releasing real mutexes',t=>{
  for(const mode of ['commit','noop','owner']) {
    const root=fixture(t);put(root,'owner.txt','untouched owner bytes');
    const child=cleanupFailure(root,mode);assert.equal(child.status,0,child.stderr);
    const observed=JSON.parse(child.stdout);
    assert.equal(observed.owner,'untouched owner bytes');
    assert.equal(observed.committed,mode==='commit'?'committed bytes':null);
    assert.equal(observed.runtimeOwner,mode==='owner'?'owner runtime bytes':null);
    assert.ok(observed.rootGuardReleased&&observed.runtimeGuardReleased&&observed.installationLockReleased&&observed.reacquired);
    if(process.platform==='win32') {
      assert.equal(observed.error,undefined);assert.equal(observed.result.changed,mode==='commit'?1:0);
      assert.equal(observed.result.cleanupWarnings[0].code,'RELOCATION_DIRECTORY_CLEANUP_DEFERRED');
      assert.equal(observed.result.cleanupWarnings[0].path,'.0-code/run');
      assert.match(child.stderr,/0-CODE cleanup warning: .*"errorCode":"EBUSY"/);
    } else {assert.equal(observed.error.code,'EBUSY');assert.doesNotMatch(child.stderr,/cleanup warning/);}
  }
});
test('guard cleanup preserves preflight errors and aggregates independent nonretryable failures',t=>{
  for(const mode of ['preflight-EBUSY','preflight-EIO','EIO','preflight-null','preflight-undefined','preflight-zero','preflight-empty','preflight-frozen','preflight-zero-clean']) {
    const root=fixture(t);put(root,'owner.txt','untouched owner bytes');
    const child=cleanupFailure(root,mode);assert.equal(child.status,0,child.stderr);
    const observed=JSON.parse(child.stdout);assert.equal(observed.owner,'untouched owner bytes');
    assert.ok(observed.rootGuardReleased&&observed.runtimeGuardReleased&&observed.installationLockReleased&&observed.reacquired);
    if(mode==='EIO') {assert.equal(observed.error.code,'EIO');assert.equal(observed.committed,'committed bytes');}
    else if(['preflight-null','preflight-undefined','preflight-zero','preflight-empty','preflight-frozen','preflight-zero-clean'].includes(mode)) {
      assert.equal(observed.committed,null);
      const original=mode==='preflight-zero-clean'?observed.error:process.platform==='win32'?observed.error.cause:observed.error.errors[0];
      if(mode==='preflight-null')assert.equal(original.isNull,true);
      else if(mode==='preflight-undefined')assert.equal(original.isUndefined,true);
      else if(mode==='preflight-empty')assert.equal(original.primitive,'');
      else if(mode==='preflight-frozen') {assert.equal(original.message,'frozen preflight refusal');assert.equal(original.frozenError,true);}
      else assert.equal(original.primitive,0);
      if(mode!=='preflight-zero-clean'&&process.platform==='win32')assert.equal(observed.error.cleanupWarnings[0].errorCode,'EBUSY');
    }
    else {
      assert.equal(observed.committed,null);
      if(mode==='preflight-EBUSY'&&process.platform==='win32') {
        assert.equal(observed.error.message,'original preflight refusal');assert.equal(observed.error.cleanupWarnings[0].errorCode,'EBUSY');
      } else {
        assert.equal(observed.error.name,'AggregateError');
        assert.equal(observed.error.errors[0].message,'original preflight refusal');
        assert.equal(observed.error.errors[1].code,mode==='preflight-EIO'?'EIO':'EBUSY');
      }
    }
    if(['preflight-EIO','EIO','preflight-zero-clean'].includes(mode))assert.doesNotMatch(child.stderr,/cleanup warning/);
  }
});
test('real mutex EBUSY and shared group cleanup retain their strict error contract',t=>{
  for(const mode of ['mutex','shared']) {
    const root=fixture(t);put(root,'owner.txt','untouched owner bytes');
    const child=cleanupFailure(root,mode);assert.equal(child.status,0,child.stderr);
    const observed=JSON.parse(child.stdout);assert.equal(observed.error.code,'EBUSY');assert.doesNotMatch(child.stderr,/cleanup warning/);
    assert.equal(observed.owner,'untouched owner bytes');assert.equal(observed.error.cleanupWarnings,undefined);
    assert.equal(observed.rootGuardReleased,true);
    assert.equal(observed.runtimeGuardReleased,mode==='shared');
  }
});
const largeBytes = () => Buffer.alloc(10 * 1024 * 1024, 0xa7);
function projectSnapshot(root) {
  const visit = path => readdirSync(join(root,path),{withFileTypes:true}).flatMap(entry=>{
    const name = path ? path+'/'+entry.name : entry.name, absolute = join(root,name), stat = lstatSync(absolute);
    if(stat.isSymbolicLink())return [[name,'link',readlinkSync(absolute)]];
    return entry.isDirectory() ? [[name,'directory'],...visit(name)] : [[name,hashBytes(readFileSync(absolute)),stat.nlink]];
  });
  return visit('').sort(([a],[b])=>a.localeCompare(b));
}
function largeTransaction(root,mode) {
  // The subprocess fails only after real writes. Its dead lock exercises the public recovery entry point.
  const source = `
    import fs from 'node:fs';
    import {basename,dirname} from 'node:path';
    import {syncBuiltinESMExports} from 'node:module';
    import {InstallationPlan,applyInstallationPlan} from ${JSON.stringify(transactionModule)};
    const root=process.argv[1],mode=process.argv[2],plan=new InstallationPlan(root),write=fs.writeFileSync;
    const originals=mode==='aggregate'?fs.readdirSync(root).filter(path=>path.startsWith('part-'))
      :mode==='shared-interrupt'?['large.bin','large-copy.bin']:['large.bin'];
    for(const path of originals)plan.change(path,null,{overwrite:true});
    plan.change('settings.json','installed settings',{overwrite:true});
    plan.change('pending/added.bin',Buffer.from('new bytes'));
    plan.cycleLockPaths=['.0-code/run/.loop.lock','cycles/.loop.lock'];
    const before=plan.changes[0].before;
    let injected=false,journal;
    fs.writeFileSync=(path,data,options)=>{
      if(mode==='partial-before'&&typeof path==='number'&&!injected){
        injected=true;write(path,Buffer.from(data).subarray(0,8192));throw new Error('injected partial before-image failure');
      }
      if(typeof path==='string'&&basename(path)==='installation-transaction.json'){
        journal=JSON.parse(data);
        if(mode==='pre-journal')throw new Error('injected journal publication failure');
      }
      write(path,data,options);
      const pending=typeof path==='string'&&basename(dirname(path))==='pending'&&/^\\.0code-.*\\.tmp$/.test(basename(path));
      if(pending&&!injected){
        injected=true;
        if(mode==='interrupt'||mode==='shared-interrupt')process.exit(23);
        if(mode==='rollback')throw new Error('injected forward publication failure');
      }
    };
    syncBuiltinESMExports();
    try {
      const result=applyInstallationPlan(plan);
      if(plan.changes[0].before!==before||!before.equals(Buffer.alloc(before.length,0xa7)))throw new Error('plan before-image mutated');
      console.log(JSON.stringify({result,journal}));
    } catch(error) {console.log(JSON.stringify({error:error.message,journal}));process.exitCode=17;}
  `;
  return spawnSync(process.execPath,['--input-type=module','-e',source,root,mode],{encoding:'utf8',windowsHide:true,shell:false,timeout:30000});
}
function largeFixture(t,nativeLinks=false) {
  const root=fixture(t,nativeLinks);put(root,'large.bin',largeBytes());put(root,'settings.json','original private settings\r\n');return root;
}
function interruptedLarge(t,nativeLinks=false,shared=false) {
  const root=largeFixture(t,nativeLinks);if(shared)put(root,'large-copy.bin',largeBytes());
  const before=projectSnapshot(root),result=largeTransaction(root,shared?'shared-interrupt':'interrupt');
  assert.equal(result.status,23,result.stderr);
  const journalPath=join(root,'.0-code/run/installation-transaction.json');
  const journal=JSON.parse(readFileSync(journalPath,'utf8'));
  assert.ok(readFileSync(journalPath).length<8192);
  assert.deepEqual(journal.cycleLockPaths,['.0-code/run/.loop.lock','cycles/.loop.lock']);
  const entry=journal.changes.find(entry=>entry.path==='large.bin');
  assert.equal(Object.hasOwn(entry,'before'),false);assert.ok(entry.beforeFile);
  assert.equal(lstatSync(join(root,entry.beforeFile)).size,10*1024*1024);
  assert.equal(existsSync(join(root,'large.bin')),false);
  assert.equal(readFileSync(join(root,'settings.json'),'utf8'),'installed settings');
  return {root,before,journal,journalPath,entry};
}

test('10 MiB before-images stay binary, preserve the plan buffers, and clean only their own storage on success',t=>{
  const root=largeFixture(t);put(root,'.0-code/run/installation-before-owner/keep.bin','owner bytes');
  const result=largeTransaction(root,'success');assert.equal(result.status,0,result.stderr);
  const {journal,result:applied}=JSON.parse(result.stdout);assert.equal(applied.changed,3);
  assert.deepEqual(journal.cycleLockPaths,['.0-code/run/.loop.lock','cycles/.loop.lock']);
  assert.ok(journal.beforeDirectory);assert.equal(Object.hasOwn(journal.changes[0],'before'),false);
  assert.equal(existsSync(join(root,journal.beforeDirectory)),false);
  assert.equal(readFileSync(join(root,'.0-code/run/installation-before-owner/keep.bin'),'utf8'),'owner bytes');
  assert.equal(existsSync(join(root,'.0-code/run/installation-transaction.json')),false);
  assert.equal(existsSync(join(root,'large.bin')),false);
  assert.equal(readFileSync(join(root,'pending/added.bin'),'utf8'),'new bytes');
  assert.throws(()=>new InstallationPlan(root).change('.0-code/run/installation-before-owner/keep.bin','replace'),/internals/);
});
test('10 MiB automatic rollback and pre-journal failures restore the complete original snapshot',t=>{
  for(const mode of ['rollback','pre-journal','partial-before']) {
    const root=largeFixture(t),before=projectSnapshot(root),result=largeTransaction(root,mode);
    assert.equal(result.status,17,result.stderr);assert.match(JSON.parse(result.stdout).error,/injected/);
    assert.deepEqual(projectSnapshot(root),before,mode);
  }
});
test('the aggregate before-image size selects binary storage even when each individual file is small',t=>{
  const root=fixture(t);
  for(let index=0;index<9;index++)put(root,`part-${index}.bin`,Buffer.alloc(1024*1024,0xa7));
  put(root,'settings.json','original private settings\r\n');
  const result=largeTransaction(root,'aggregate');assert.equal(result.status,0,result.stderr);
  const {journal,result:applied}=JSON.parse(result.stdout);assert.equal(applied.changed,11);
  assert.equal(journal.changes.filter(entry=>entry.beforeFile).length,10);
  assert.equal(existsSync(join(root,journal.beforeDirectory)),false);
  assert.equal(readdirSync(root).some(path=>path.startsWith('part-')),false);
});
test('recovery after a real 10 MiB interrupted application restores all bytes and removes its storage',t=>{
  const {root,before}=interruptedLarge(t);
  assert.deepEqual(recoverInstallation(root),{recovered:true,files:3});assert.deepEqual(projectSnapshot(root),before);
});
test('missing, corrupt, unknown and replaced before-images refuse recovery before every filesystem write',t=>{
  for(const mutation of ['missing','corrupt','unknown','same-bytes-replacement','outside-directory','replaced-directory']) {
    const {root,journal,journalPath,entry}=interruptedLarge(t),sidecar=join(root,entry.beforeFile);
    if(mutation==='missing')unlinkSync(sidecar);
    if(mutation==='corrupt')writeFileSync(sidecar,'changed before-image');
    if(mutation==='unknown')put(root,journal.beforeDirectory+'/owner.bin','owner bytes');
    if(mutation==='same-bytes-replacement') {renameSync(sidecar,join(root,'owner-original.bin'));writeFileSync(sidecar,largeBytes());}
    if(mutation==='outside-directory') {writeFileSync(join(root,'owner.bin'),largeBytes());writeFileSync(journalPath,JSON.stringify({...journal,changes:journal.changes.map(change=>change===entry?{...change,beforeFile:'owner.bin'}:change)}));}
    if(mutation==='replaced-directory') {
      renameSync(join(root,journal.beforeDirectory),join(root,'owner-original-directory'));
      mkdirSync(join(root,journal.beforeDirectory));
      for(const change of journal.changes.filter(change=>change.beforeFile))writeFileSync(join(root,change.beforeFile),readFileSync(join(root,'owner-original-directory',change.beforeHash+'.bin')));
    }
    const before=projectSnapshot(root);
    assert.throws(()=>recoverInstallation(root),/Invalid installation recovery journal/,mutation);
    assert.deepEqual(projectSnapshot(root),before,mutation);
  }
});
test('hard-linked and symbolic before-images cannot authorize recovery or cleanup',t=>{
  for(const mutation of process.platform==='win32'?['hardlink']:['hardlink','symlink']) {
    const {root,entry}=interruptedLarge(t,true),sidecar=join(root,entry.beforeFile),owner=join(root,'owner.bin');
    if(mutation==='hardlink') {
      try {linkSync(sidecar,owner);} catch(error) {
        if(process.platform!=='win32'||error.code!=='EISDIR'||!lstatSync(sidecar).isFile())throw error;
        t.skip('this Windows filesystem cannot create hard links to regular files (EISDIR)');
        return;
      }
    }
    else {renameSync(sidecar,owner);symlinkSync(owner,sidecar);}
    const before=projectSnapshot(root);assert.throws(()=>recoverInstallation(root),/Invalid installation recovery journal/);
    assert.deepEqual(projectSnapshot(root),before);
  }
});
test('every shared before-image reference validates before deduplication and any recovery write',t=>{
  for(const before of [null,'unexpected inline bytes']) {
    const {root,journal,journalPath}=interruptedLarge(t,false,true);
    const first=journal.changes.find(entry=>entry.path==='large.bin'),duplicate=journal.changes.find(entry=>entry.path==='large-copy.bin');
    assert.equal(first.beforeFile,duplicate.beforeFile);
    writeFileSync(journalPath,JSON.stringify({...journal,changes:journal.changes.map(entry=>entry===first?{...entry,before}:entry)}));
    const snapshot=projectSnapshot(root);
    assert.throws(()=>recoverInstallation(root),/Invalid installation recovery journal/);
    assert.deepEqual(projectSnapshot(root),snapshot);
  }
});
