import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,symlinkSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {cloneFixtureRepository,isTransientCloneLock} from '../helpers/git-fixture.mjs';
import {cleanupTempDir} from '../helpers/index.mjs';

const lockBytes=Buffer.from('Fixture lock\r\n\0Owner bytes');
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'git-clone-refusal-'));t.after(()=>cleanupTempDir(root));
  return {root,source:join(root,'source'),target:join(root,'clone with spaces'),
    failure:{status:128,signal:null,stdout:'',stderr:'Diagnostic text is not a lock protocol'}};
}
function lockAt(target) {
  const lock=join(target,'.git','config.lock');mkdirSync(dirname(lock),{recursive:true});writeFileSync(lock,lockBytes);return lock;
}
function native(result) {const {destination,...value}=result;return value;}
function withLstat(t,inspect,run) {
  const original=fs.lstatSync,mocked=t.mock.method(fs,'lstatSync',path=>inspect(path,original));syncBuiltinESMExports();
  try {run();} finally {mocked.mock.restore();syncBuiltinESMExports();}
}
function assertLinkMetadataRejected(t,f,paths) {
  // Windows temporary filesystems may not support native links; POSIX tests use real links below.
  for(const linked of paths)withLstat(t,(path,original)=>path===linked
    ?{isDirectory:()=>false,isFile:()=>false,isSymbolicLink:()=>true}:original(path),
  ()=>assert.equal(isTransientCloneLock(f.failure,f.target,'win32'),false));
}
function git(args,options={}) {
  const result=spawnSync('git',args,{encoding:'utf8',windowsHide:true,...options});
  assert.equal(result.status,0,result.stderr);return result;
}
function nativeLockFixture(t) {
  const f=fixture(t),template=join(f.root,'template');mkdirSync(template);writeFileSync(join(template,'config.lock'),lockBytes);
  git(['init',f.source]);writeFileSync(join(f.source,'source.txt'),'Cloned by real Git\n');
  git(['-C',f.source,'add','.']);
  git(['-C',f.source,'-c','user.name=Verification','-c','user.email=verification@invalid.local','commit','-m','Fixture']);
  return {...f,template};
}

test('clone lock classification uses the actual regular lock independently of stderr',t=>{
  const f=fixture(t),lock=lockAt(f.target);
  for(const stderr of ['',undefined,'Fehler beim Sperren','unrelated diagnostic',Buffer.from('other bytes')])
    assert.equal(isTransientCloneLock({...f.failure,stderr},f.target,'win32'),true);
  assert.equal(isTransientCloneLock(f.failure,f.target,process.platform),process.platform==='win32');
  assert.equal(isTransientCloneLock(f.failure,f.target+'-other','win32'),false);
  assert.deepEqual(readFileSync(lock),lockBytes);
});

test('platform, exit status, launch errors and signals cannot be replaced by lock evidence',t=>{
  const f=fixture(t);lockAt(f.target);
  for(const platform of ['linux','darwin'])assert.equal(isTransientCloneLock(f.failure,f.target,platform),false);
  for(const status of [0,1,127,null,undefined,'128'])assert.equal(isTransientCloneLock({...f.failure,status},f.target,'win32'),false);
  for(const extra of [{error:new Error('spawn failed')},{signal:'SIGTERM'},{error:{code:'ENOENT'}}])
    assert.equal(isTransientCloneLock({...f.failure,...extra},f.target,'win32'),false);
});

test('the former exact stderr without a surviving lock never permits retry',t=>{
  const f=fixture(t),config=join(resolve(f.target),'.git','config').replaceAll('\\','/');
  const failure={...f.failure,stderr:`error: could not lock config file ${config}: File exists\nfatal: could not set 'core.repositoryformatversion' to '0'\n`};
  assert.equal(isTransientCloneLock(failure,f.target,'win32'),false);
  let calls=0;const result=cloneFixtureRepository(f.source,f.target,{platform:'win32',launch:()=>{calls++;return failure;}});
  assert.equal(calls,1);assert.deepEqual(native(result),failure);assert.equal(existsSync(f.target),false);
});

test('missing and wrong-type destination, .git and config.lock paths are not evidence',t=>{
  const f=fixture(t),targets=['missing','file-target','missing-git','file-git','missing-lock','directory-lock'].map(name=>join(f.root,name));
  writeFileSync(targets[1],'owner target');mkdirSync(targets[2]);mkdirSync(targets[3]);writeFileSync(join(targets[3],'.git'),'owner git');
  mkdirSync(join(targets[4],'.git'),{recursive:true});mkdirSync(join(targets[5],'.git','config.lock'),{recursive:true});
  for(const target of targets)assert.equal(isTransientCloneLock(f.failure,target,'win32'),false,target);
  assert.equal(readFileSync(targets[1],'utf8'),'owner target');assert.equal(readFileSync(join(targets[3],'.git'),'utf8'),'owner git');
});

test('linked destinations and .git directories cannot borrow another lock',t=>{
  if(process.platform==='win32') {
    const f=fixture(t),lock=lockAt(f.target);assertLinkMetadataRejected(t,f,[f.target,join(f.target,'.git')]);
    assert.deepEqual(readFileSync(lock),lockBytes);return;
  }
  const f=fixture(t),owner=join(f.root,'owner');const lock=lockAt(owner);
  symlinkSync(owner,f.target,'dir');
  const other=join(f.root,'other');mkdirSync(other);symlinkSync(join(owner,'.git'),join(other,'.git'),'dir');
  for(const target of [f.target,other])assert.equal(isTransientCloneLock(f.failure,target,'win32'),false);
  assert.deepEqual(readFileSync(lock),lockBytes);
});

test('a symbolic config.lock file is not regular lock evidence',t=>{
  if(process.platform==='win32') {
    const f=fixture(t),lock=lockAt(f.target);assertLinkMetadataRejected(t,f,[lock]);assert.deepEqual(readFileSync(lock),lockBytes);return;
  }
  const f=fixture(t),owner=join(f.root,'owner.lock');writeFileSync(owner,lockBytes);mkdirSync(join(f.target,'.git'),{recursive:true});
  symlinkSync(owner,join(f.target,'.git','config.lock'),'file');
  assert.equal(isTransientCloneLock(f.failure,f.target,'win32'),false);assert.deepEqual(readFileSync(owner),lockBytes);
});

test('unexpected filesystem errors propagate instead of permitting a retry',t=>{
  const f=fixture(t),lock=lockAt(f.target),error=Object.assign(new Error('Cannot inspect lock'),{code:'EACCES'});
  withLstat(t,(path,original)=>{if(path===lock)throw error;return original(path);},()=>{
    assert.throws(()=>isTransientCloneLock(f.failure,f.target,'win32'),value=>value===error);
    let calls=0;
    assert.throws(()=>cloneFixtureRepository(f.source,f.target,{platform:'win32',launch:()=>{calls++;return f.failure;}}),value=>value===error);
    assert.equal(calls,1);
  });
});

test('persistent locks exhaust three attempts in fresh siblings and preserve every destination',t=>{
  const f=fixture(t),destinations=[],attempts=[],retries=[];
  const result=cloneFixtureRepository(f.source,f.target,{platform:'win32',onAttempt:row=>attempts.push(row),onRetry:row=>retries.push(row),launch:(_bin,args)=>{
    const destination=args.at(-1);destinations.push(destination);lockAt(destination);writeFileSync(join(destination,'owner.txt'),'Owner bytes\r\n');return f.failure;
  }});
  assert.equal(destinations.length,3);assert.equal(retries.length,2);assert.equal(new Set(destinations).size,3);assert.deepEqual(native(result),f.failure);
  assert.equal(result.destination,destinations.at(-1));assert.ok(attempts.every(row=>row.occupied&&row.transient));
  for(const destination of destinations) {
    assert.equal(dirname(destination),dirname(f.target));assert.equal(readFileSync(join(destination,'owner.txt'),'utf8'),'Owner bytes\r\n');
    assert.deepEqual(readFileSync(join(destination,'.git','config.lock')),lockBytes);
  }
});

test('an initially occupied destination is preserved even with valid lock evidence',t=>{
  const f=fixture(t),lock=lockAt(f.target);writeFileSync(join(f.target,'owner.txt'),'Owner bytes\r\n');let calls=0;
  const result=cloneFixtureRepository(f.source,f.target,{platform:'win32',launch:()=>{calls++;return f.failure;},onRetry:()=>assert.fail('occupied destination retried')});
  assert.equal(calls,1);assert.deepEqual(native(result),f.failure);assert.equal(readFileSync(join(f.target,'owner.txt'),'utf8'),'Owner bytes\r\n');
  assert.deepEqual(readFileSync(lock),lockBytes);
});

test('an unrelated Git refusal is returned immediately without a retry',t=>{
  const f=fixture(t),failure={status:128,stdout:'',stderr:'fatal: repository does not exist'};let calls=0;
  const result=cloneFixtureRepository(f.source,f.target,{platform:'win32',launch:()=>{calls++;return failure;}});
  assert.equal(calls,1);assert.deepEqual(native(result),failure);
});

test('a failed launch or signal never becomes a successful clone or a retry',t=>{
  for(const extra of [{status:null,error:new Error('ENOENT')},{signal:'SIGTERM'}]) {
    const f=fixture(t),failure={...f.failure,...extra};let calls=0;
    const result=cloneFixtureRepository(f.source,f.target,{platform:'win32',launch:()=>{calls++;lockAt(f.target);return failure;}});
    assert.equal(calls,1);assert.deepEqual(native(result),failure);assert.deepEqual(readFileSync(join(f.target,'.git','config.lock')),lockBytes);
  }
});

test('a destination appearing before the next launch refuses without touching either destination',t=>{
  const f=fixture(t);let calls=0,next;
  const result=cloneFixtureRepository(f.source,f.target,{platform:'win32',launch:()=>{calls++;lockAt(f.target);return f.failure;},onRetry:row=>{
    next=row.next;mkdirSync(next);writeFileSync(join(next,'owner.txt'),'Later owner bytes');
  }});
  assert.equal(calls,1);assert.deepEqual(native(result),f.failure);assert.equal(result.destination,f.target);assert.notEqual(next,f.target);
  assert.equal(readFileSync(join(next,'owner.txt'),'utf8'),'Later owner bytes');assert.deepEqual(readFileSync(join(f.target,'.git','config.lock')),lockBytes);
});

test('real Git init leaves a config lock that is classified without inspecting stderr',t=>{
  const f=nativeLockFixture(t),result=spawnSync('git',['init','--template='+f.template,f.target],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,128,result.stderr);assert.equal(result.error,undefined);assert.equal(result.signal,null);
  assert.deepEqual(readFileSync(join(f.target,'.git','config.lock')),lockBytes);
  for(const stderr of ['', 'Fehler beim Sperren'])assert.equal(isTransientCloneLock({...result,stderr},f.target,'win32'),true);
  assert.equal(isTransientCloneLock(result,f.target),process.platform==='win32');
});

test('a controlled real init-lock refusal retries into a real clone and preserves the lock bytes',t=>{
  const f=nativeLockFixture(t);let calls=0;
  const result=cloneFixtureRepository(f.source,f.target,{platform:'win32',launch:(bin,args,options)=>{
    calls++;
    // The first command is deliberately init: clone cleans up its lock before returning.
    const actual=spawnSync(bin,calls===1?['init','--template='+f.template,args.at(-1)]:args,options);
    if(calls===1){assert.equal(actual.status,128,actual.stderr);assert.equal(isTransientCloneLock(actual,f.target,'win32'),true);}
    return actual;
  }});
  assert.equal(calls,2);assert.equal(result.status,0,result.stderr);assert.notEqual(result.destination,f.target);
  assert.equal(readFileSync(join(result.destination,'source.txt'),'utf8'),'Cloned by real Git\r\n');
  assert.deepEqual(readFileSync(join(f.target,'.git','config.lock')),lockBytes);assert.deepEqual(readFileSync(join(f.template,'config.lock')),lockBytes);
  git(['-C',result.destination,'rev-parse','--is-inside-work-tree']);
});

test('a real clone that cleans up its config lock returns the Git failure without retry',t=>{
  const f=nativeLockFixture(t),attempts=[];let calls=0;
  const result=cloneFixtureRepository(f.source,f.target,{platform:'win32',env:{...process.env,GIT_TEMPLATE_DIR:f.template},onAttempt:row=>attempts.push(row),launch:(bin,args,options)=>{
    calls++;return spawnSync(bin,args,options);
  },onRetry:()=>assert.fail('clone cleanup left no evidence for retry')});
  assert.equal(calls,1);assert.equal(result.status,128,result.stderr);assert.equal(result.error,undefined);assert.equal(result.signal,null);
  assert.equal(existsSync(join(f.target,'.git','config.lock')),false);assert.equal(isTransientCloneLock(result,f.target,'win32'),false);
  assert.equal(attempts.length,1);assert.equal(attempts[0].transient,false);assert.deepEqual(readFileSync(join(f.template,'config.lock')),lockBytes);
});
