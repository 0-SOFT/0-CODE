import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {cloneFixtureRepository,isTransientCloneLock} from '../helpers/git-fixture.mjs';
import {cleanupTempDir} from '../helpers/index.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'git-clone-refusal-'));t.after(()=>cleanupTempDir(root));
  const source=join(root,'source'),target=join(root,'clone with spaces');
  const failure={status:128,stdout:'',stderr:`error: could not lock config file ${join(resolve(target),'.git','config').replaceAll('\\','/')}: File exists\nfatal: could not set 'core.repositoryformatversion' to '0'\n`};
  return {source,target,failure};
}
function native(result) {const {destination,...value}=result;return value;}
function failureAt(target) {return {status:128,stdout:'',stderr:`error: could not lock config file ${join(resolve(target),'.git','config').replaceAll('\\','/')}: File exists\nfatal: could not set 'core.repositoryformatversion' to '0'\n`};}

test('clone lock classification requires Windows, the exact destination and both native errors',t=>{
  const f=fixture(t);
  assert.equal(isTransientCloneLock(f.failure,f.target,'win32'),true);
  assert.equal(isTransientCloneLock(f.failure,f.target,'linux'),false);
  assert.equal(isTransientCloneLock(f.failure,f.target+'-other','win32'),false);
  assert.equal(isTransientCloneLock({...f.failure,status:1},f.target,'win32'),false);
  assert.equal(isTransientCloneLock({...f.failure,error:new Error('spawn failed')},f.target,'win32'),false);
  assert.equal(isTransientCloneLock({...f.failure,stderr:f.failure.stderr.split('\n')[0]},f.target,'win32'),false);
});

test('persistent clone lock exhausts its bound and returns the native failure',t=>{
  const f=fixture(t);let calls=0;const retries=[];
  const result=cloneFixtureRepository(f.source,f.target,{platform:'win32',launch:()=>{calls++;return f.failure;},onRetry:row=>retries.push(row)});
  assert.equal(calls,3);assert.equal(retries.length,2);assert.deepEqual(native(result),f.failure);
});

test('a surviving destination is never removed or retried after a clone lock failure',t=>{
  const f=fixture(t);mkdirSync(f.target);writeFileSync(join(f.target,'owner.txt'),'Owner bytes\r\n');let calls=0;
  const result=cloneFixtureRepository(f.source,f.target,{platform:'win32',launch:()=>{calls++;return f.failure;},onRetry:()=>assert.fail('occupied destination retried')});
  assert.equal(calls,1);assert.deepEqual(native(result),f.failure);assert.equal(readFileSync(join(f.target,'owner.txt'),'utf8'),'Owner bytes\r\n');
});

test('an unrelated Git refusal is returned immediately without a retry',t=>{
  const f=fixture(t),failure={status:128,stdout:'',stderr:'fatal: repository does not exist'};let calls=0;
  const result=cloneFixtureRepository(f.source,f.target,{platform:'win32',launch:()=>{calls++;return failure;}});
  assert.equal(calls,1);assert.deepEqual(native(result),failure);
});

test('a failed launch never becomes a successful clone or a retry',t=>{
  const f=fixture(t),failure={status:null,error:new Error('ENOENT'),stdout:'',stderr:''};let calls=0;
  const result=cloneFixtureRepository(f.source,f.target,{platform:'win32',launch:()=>{calls++;return failure;}});
  assert.equal(calls,1);assert.deepEqual(native(result),failure);
});

test('a destination left by failed Git is preserved while bounded retries use distinct fresh siblings',t=>{
  const f=fixture(t),destinations=[],attempts=[];
  const result=cloneFixtureRepository(f.source,f.target,{platform:'win32',onAttempt:row=>attempts.push(row),launch:(_bin,args)=>{
    const destination=args.at(-1);destinations.push(destination);mkdirSync(destination);writeFileSync(join(destination,'owner.txt'),'Owner bytes');return failureAt(destination);
  }});
  assert.equal(destinations.length,3);assert.equal(new Set(destinations).size,3);assert.equal(result.status,128);
  assert.equal(result.destination,destinations.at(-1));assert.ok(attempts.every(row=>row.occupied&&row.transient));
  for(const destination of destinations) {assert.equal(dirname(destination),dirname(f.target));assert.equal(readFileSync(join(destination,'owner.txt'),'utf8'),'Owner bytes');}
});

test('a destination appearing before the next launch refuses without touching its bytes',t=>{
  const f=fixture(t);let calls=0;
  const result=cloneFixtureRepository(f.source,f.target,{platform:'win32',launch:()=>{calls++;return f.failure;},onRetry:row=>{
    mkdirSync(row.next);writeFileSync(join(row.next,'owner.txt'),'Later owner bytes');
  }});
  assert.equal(calls,1);assert.equal(result.status,128);assert.equal(readFileSync(join(f.target,'owner.txt'),'utf8'),'Later owner bytes');
});

test('a real Git config-lock refusal can retry into a fresh clone while preserving the failed destination',t=>{
  const f=fixture(t),template=join(dirname(f.target),'template');mkdirSync(template);writeFileSync(join(template,'config.lock'),'fixture lock');
  const initialized=spawnSync('git',['init',f.source],{encoding:'utf8',windowsHide:true});assert.equal(initialized.status,0,initialized.stderr);
  let calls=0;
  const result=cloneFixtureRepository(f.source,f.target,{platform:'win32',env:{...process.env,GIT_TEMPLATE_DIR:template},launch:(bin,args,options)=>{
    calls++;const nativeResult=spawnSync(bin,args,options);
    if(calls===1) {
      assert.equal(nativeResult.status,128,nativeResult.stderr);assert.equal(isTransientCloneLock(nativeResult,f.target,'win32'),true);
      mkdirSync(f.target,{recursive:true});writeFileSync(join(f.target,'owner.txt'),'Preserved after native failure');unlinkSync(join(template,'config.lock'));
    }
    return nativeResult;
  }});
  assert.equal(calls,2);assert.equal(result.status,0,result.stderr);assert.notEqual(result.destination,f.target);
  assert.equal(existsSync(join(result.destination,'.git','config')),true);assert.equal(readFileSync(join(f.target,'owner.txt'),'utf8'),'Preserved after native failure');
});
