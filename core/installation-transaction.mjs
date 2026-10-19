// A complete plan is validated before the first mutation. Recovery never overwrites a third party.
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync, rmdirSync, openSync,closeSync,fstatSync,ftruncateSync,writeSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolveProjectPath, projectRelativePath, loadProjectConfig, CONFIG_PATH } from './project-config.mjs';
import { projectAllowedPaths } from './project-write-policy.mjs';
import { replaceFileSync, retryWindowsFileOperation } from '../lib/replace-file.mjs';
import { enterLoopMutationAt, isPidAlive, ownerState } from './loop-lock.mjs';
import { assertBeforeImages, clearBeforeImages, isBeforeStoragePath, prepareBeforeImages, readBeforeImage } from './installation-journal-storage.mjs';

const JOURNAL = '.0-code/run/installation-transaction.json';
const LOCK = '.0-code/run/installation.lock';
const RUN_IGNORE = '.0-code/run/.gitignore';
export const GROUP_JOURNAL = '.0-code/run/installation-group.json';
const STAGING_CONFLICTS=[JOURNAL+'.staging-conflict',GROUP_JOURNAL+'.staging-conflict'];
export const hashBytes = bytes => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
const contained = (root,path) => resolveProjectPath(root,path,{allowFramework:true});
export function normalizeInstallationPaths(paths=null) {
  if(paths===null)return null;
  if(!Array.isArray(paths))throw new Error('Authorized installation paths must be an array');
  return Object.freeze(paths.map(entry=>{
    if(!entry||typeof entry!=='object'||typeof entry.recursive!=='boolean')throw new Error('Invalid authorized installation path');
    return Object.freeze({path:projectRelativePath(entry.path,{allowFramework:true}),recursive:entry.recursive});
  }));
}
function assertWriteAllowed(paths,path) {
  if(paths===null)return;
  path=projectRelativePath(path,{allowFramework:true});
  const key=value=>process.platform==='win32'?value.toLowerCase():value;
  if(!paths.some(entry=>key(path)===key(entry.path)||entry.recursive&&key(path).startsWith(key(entry.path)+'/')))
    throw new Error('Installation path is outside the authorized native locations: '+path);
}
function assertDirectoryAllowed(paths,path) {
  if(paths===null)return;
  const normalized=projectRelativePath(path,{allowFramework:true});
  const key=value=>process.platform==='win32'?value.toLowerCase():value;
  if(!paths.some(entry=>key(normalized)===key(entry.path)||key(entry.path).startsWith(key(normalized)+'/')
    ||entry.recursive&&key(normalized).startsWith(key(entry.path)+'/')))
    throw new Error('Installation directory is outside the authorized native locations: '+path);
}

function snapshotFile(file) {
  let stat;
  try { stat=lstatSync(file); } catch(error) { if(error.code==='ENOENT') return {bytes:null,hash:null,mode:null}; throw error; }
  if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1) throw new Error('Not an ordinary installation file');
  const bytes=readFileSync(file);
  return {bytes,hash:hashBytes(bytes),mode:stat.mode & 0o777};
}
export function fileSnapshot(root,path) {
  return snapshotFile(contained(root,path));
}

export function assertCycleRelocationStopped(root, paths) {
  for (const lockPath of paths) {
    for (const path of [lockPath, lockPath.replace(/\.loop\.lock$/, '.loop-children')]) {
      const {bytes}=fileSnapshot(root,path);if(bytes===null)continue;
      let value;try {value=JSON.parse(bytes.toString('utf8'));}catch {throw new Error('Ambiguous cycle runtime: '+path);}
      if(path===lockPath) {
        if(!value||!Number.isInteger(value.pid)||value.pid<=0||!value.engine||!value.startedAt)throw new Error('Ambiguous cycle lock: '+path);
        if(isPidAlive(value.pid)||!['dead','stale'].includes(ownerState(value)))throw new Error('Stop the active cycle before document relocation or recovery');
      } else {
        if(!Array.isArray(value?.pids)||value.pids.some(pid=>!Number.isInteger(pid)||pid<=0))throw new Error('Ambiguous cycle children: '+path);
        if(value.pids.some(isPidAlive))throw new Error('Stop active cycle children before document relocation or recovery');
      }
    }
  }
}
export function enterCycleRelocationGuard(root, paths) {
  assertCycleRelocationStopped(root,paths);
  const leaves=[],missing=new Set();
  for(const path of paths) {
    let directory=dirname(path).replaceAll('\\','/');
    while(directory!=='.'&&!existsSync(contained(root,directory))) {missing.add(directory);directory=dirname(directory).replaceAll('\\','/');}
  }
  const release=()=>{
    const failures=[];
    for(const leave of [...leaves].reverse())try {leave();}catch(error){failures.push(error);}
    if(failures.length)throw failures.length===1?failures[0]:new AggregateError(failures,'Cycle guards could not all be released');
    return removeEmpty(root,[...missing],{deferBusy:true});
  };
  try {
    for(const path of paths) {
      const leave=enterLoopMutationAt(contained(root,path));
      if(!leave)throw new Error('Cycle lock mutation is active; retry document relocation or recovery');
      leaves.push(leave);
    }
    assertCycleRelocationStopped(root,paths);return release;
  } catch(error) {return runThenRelease(release,()=>{throw error;});}
}

export class InstallationPlan {
  constructor(root,{allowedPaths=null}={}) { this.root=resolve(root);this.allowedPaths=normalizeInstallationPaths(allowedPaths);this.changes=[];this.conflicts=[]; }
  change(path,content,{overwrite=false,expectedHash,mode=0o644,preserveMode=true}={}) {
    const normalized=projectRelativePath(path,{allowFramework:true});
    assertWriteAllowed(this.allowedPaths,normalized);
    if(normalized===JOURNAL || normalized===GROUP_JOURNAL || isBeforeStoragePath(normalized) || STAGING_CONFLICTS.some(path=>normalized===path||normalized.startsWith(path+'/')) || normalized===RUN_IGNORE || normalized===LOCK || normalized.startsWith(LOCK+'/')) throw new Error('Installation plan uses transaction internals');
    if(this.changes.some(entry=>entry.path===normalized)) throw new Error('Duplicate path in installation plan');
    const before=fileSnapshot(this.root,normalized),after=content===null?null:Buffer.from(content);
    const afterHash=hashBytes(after);
    const targetMode=preserveMode?before.mode??mode:mode;
    if(expectedHash!==undefined && before.hash!==expectedHash) this.conflicts.push({path:normalized,reason:'File changed after ownership was recorded'});
    if(before.hash===afterHash && (process.platform==='win32'||after===null||before.mode===targetMode)) return false;
    if(before.bytes!==null && !overwrite) this.conflicts.push({path:normalized,reason:'Existing project file has different contents'});
    this.changes.push({path:normalized,before:before.bytes,beforeHash:before.hash,beforeMode:before.mode,after,afterHash,mode:targetMode});
    return true;
  }
  assertReady() {
    for(const path of this.cycleLockPaths||[])assertWriteAllowed(this.allowedPaths,path);
    if(this.conflicts.length) { const error=new Error('Installation intersections require a decision');error.conflicts=this.conflicts;throw error; }
    for(const entry of this.changes) {
      assertWriteAllowed(this.allowedPaths,entry.path);
      if(this.changes.some(other=>other!==entry && entry.path.startsWith(other.path+'/'))) throw new Error('Installation file paths overlap');
      if(fileSnapshot(this.root,entry.path).hash!==entry.beforeHash) throw new Error(`Installation target changed: ${entry.path}`);
    }
    this.preflight?.();
  }
  summary() { return this.changes.map(entry=>({path:entry.path,operation:entry.after===null?'remove':entry.before===null?'create':'update'})); }
}

function missingDirectories(root,changes) {
  const missing=new Set();
  for(const entry of [...changes,{path:JOURNAL}]) {
    let directory=dirname(contained(root,entry.path));
    while(directory!==root && !existsSync(directory)) {
      missing.add(relative(root,directory).replaceAll('\\','/'));directory=dirname(directory);
    }
  }
  return [...missing].sort((a,b)=>a.split('/').length-b.split('/').length);
}
function removeEmpty(root,directories,{deferBusy=false}={}) {
  const warnings=[];
  for(const path of [...directories].sort((a,b)=>b.split('/').length-a.split('/').length)) {
    try { retryWindowsFileOperation(()=>rmdirSync(contained(root,path)),{
      validate:()=>contained(root,path),retryCodes:['EPERM','EACCES','EBUSY','ENOTEMPTY']}); }
    catch(error) {
      if(['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code))continue;
      // Only guard-created directories are optional; real mutex and recovery cleanup stay strict.
      if(!deferBusy||process.platform!=='win32'||error.code!=='EBUSY')throw error;
      let stat;
      try {stat=lstatSync(contained(root,path));}catch(inspectionError){if(inspectionError.code==='ENOENT')continue;throw inspectionError;}
      if(!stat.isDirectory())throw error;
      const warning={code:'RELOCATION_DIRECTORY_CLEANUP_DEFERRED',path,errorCode:error.code,
        message:'Directory retained after cycle guards were released; retry optional cleanup later'};
      process.stderr.write('0-CODE cleanup warning: '+JSON.stringify(warning)+'\n');
      warnings.push(warning);
    }
  }
  return warnings;
}
function runThenRelease(leave,action) {
  let result,failure,failed=false;
  try {result=action();}catch(error){failed=true;failure=error;}
  let warnings;
  try {warnings=leave?.()||[];}
  catch(cleanupError){throw failed?new AggregateError([failure,cleanupError],'Installation and cycle guard release failed',{cause:failure}):cleanupError;}
  if(failed) {
    if(!warnings.length)throw failure;
    // A frozen Error or a primitive exception must survive without an attempted mutation.
    const diagnostic=new Error(failure instanceof Error?failure.message:'Installation failed; optional cycle directory cleanup was deferred',{cause:failure});
    if(failure?.code!==undefined)diagnostic.code=failure.code;
    diagnostic.cleanupWarnings=warnings;
    throw diagnostic;
  }
  return warnings.length?{...result,cleanupWarnings:[...(result?.cleanupWarnings||[]),...warnings]}:result;
}
function stagingPath(path) {return join(dirname(path),`.0code-${randomUUID()}.tmp`).replaceAll('\\','/');}
function validateStaging(root,path,target,occupied=[]) {
  if(path===undefined)return;
  const key=value=>{const normalized=projectRelativePath(value,{allowFramework:true});return process.platform==='win32'?normalized.toLowerCase():normalized;};
  target=projectRelativePath(target,{allowFramework:true});
  if(typeof path!=='string'||projectRelativePath(path,{allowFramework:true})!==path
    ||dirname(path)!==dirname(target)||!/^\.0code-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/.test(path.split('/').at(-1))
    ||occupied.some(other=>key(path)===key(other)||key(path).startsWith(key(other)+'/')||key(other).startsWith(key(path)+'/')))
    throw new Error('Invalid installation staging path');
  contained(root,path);occupied.push(path);
}
function journalStaging(journal) {
  const files=journal.changes.filter(entry=>entry.staging!==undefined).map(entry=>({path:entry.staging,hashes:[entry.beforeHash,entry.afterHash]}));
  if(journal.runtimeIgnoreStaging!==undefined)files.push({path:journal.runtimeIgnoreStaging,hashes:[hashBytes(Buffer.from('*\n'))]});
  return files;
}
function assertStaging(root,path,hashes) {
  if(path===undefined)return;
  const current=fileSnapshot(root,path).hash;
  if(current!==null&&!hashes.includes(current))throw new Error('Recovery intersects changed staging: '+path);
  return current;
}
function clearStaging(root,path,hashes) {
  if(path===undefined)return;
  if(assertStaging(root,path,hashes)!==null)unlinkSync(contained(root,path));
}
function assertJournalStaging(root,journal,{unused=false}={}) {
  for(const entry of journalStaging(journal)) {
    assertStaging(root,entry.path,entry.hashes);
    if(unused&&fileSnapshot(root,entry.path).hash!==null)throw new Error('Installation staging already exists');
  }
}
function clearJournalStaging(root,journal) {for(const entry of journalStaging(journal))clearStaging(root,entry.path,entry.hashes);}
function publish(root,path,bytes,mode,expected,registeredStaging,publicationJournal) {
  const destination=contained(root,path);
  if(snapshotFile(destination).hash!==expected) throw new Error(`Installation target changed: ${path}`);
  if(bytes===null) { if(expected!==null) unlinkSync(destination);return; }
  if(!existsSync(dirname(destination)))mkdirSync(dirname(destination),{recursive:true});
  const staging=contained(root,registeredStaging??stagingPath(path));
  const fingerprint=hashBytes(bytes);let owner;
  const validate=()=>{
    const current=snapshotFile(staging),stat=lstatSync(staging);
    if(current.hash!==fingerprint||stat.dev!==owner.dev||stat.ino!==owner.ino)throw new Error('Installation staging changed: '+path);
  };
  try {
    try {writeFileSync(staging,bytes,{flag:'wx',mode});}
    catch(error) {
      if(error.code==='EEXIST') {
        error.installationStagingConflict=registeredStaging??relative(root,staging).replaceAll('\\','/');
        const journal=publicationJournal??(existsSync(contained(root,GROUP_JOURNAL))?GROUP_JOURNAL:existsSync(contained(root,JOURNAL))?JOURNAL:null);
        if(journal)try {recordStagingConflict(root,journal,error);}catch(recordError){error.cause=recordError;}
      }
      throw error;
    }
    owner=lstatSync(staging);
    replaceFileSync(staging,destination,{validate() {
      if(fileSnapshot(root,path).hash!==expected) throw new Error(`Installation target changed: ${path}`);
      validate();
    }});
    chmodSync(destination,mode);
  } finally {
    // A failed exclusive create never grants ownership of somebody else's file.
    if(owner)try {validate();unlinkSync(staging);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
function restoreJournal(root,journal,{journalPath=JOURNAL}={}) {
  assertNoStagingConflict(root);
  assertBeforeImages(root,journal);
  // Check the entire journal before restoring one file: an unexpected byte belongs to somebody else.
  for(const entry of journal.changes) {
    const current=fileSnapshot(root,entry.path).hash;
    if(current!==entry.beforeHash && current!==entry.afterHash) throw new Error(`Recovery intersection: ${entry.path}`);
  }
  assertJournalStaging(root,journal);clearJournalStaging(root,journal);
  for(const entry of [...journal.changes].reverse()) {
    const current=fileSnapshot(root,entry.path).hash;
    if(current!==entry.beforeHash) publish(root,entry.path,readBeforeImage(root,journal,entry),entry.beforeMode??0o644,current,entry.staging,journalPath);
  }
}
function validJournal(root,journal) {
  if(!journal || journal.schema_version!==1 || !Array.isArray(journal.changes) || !Array.isArray(journal.missingDirectories)) throw new Error('Invalid installation recovery journal');
  const seen=new Set();
  if(journal.cycleLockPaths!==undefined) {
    if(!Array.isArray(journal.cycleLockPaths)||!journal.cycleLockPaths.length||new Set(journal.cycleLockPaths).size!==journal.cycleLockPaths.length
      ||journal.cycleLockPaths.some(path=>typeof path!=='string'||!/(?:^|\/)\.loop\.lock$/.test(path)||projectRelativePath(path,{allowFramework:true})!==path))
      throw new Error('Invalid relocation recovery lock paths');
    for(const path of journal.cycleLockPaths)contained(root,path);
  }
  for(const entry of journal.changes) {
    if(typeof entry.path!=='string'||seen.has(entry.path)||entry.path===JOURNAL||isBeforeStoragePath(entry.path)||STAGING_CONFLICTS.some(path=>{const value=projectRelativePath(entry.path,{allowFramework:true});return value===path||value.startsWith(path+'/');})||entry.path===RUN_IGNORE||entry.path===LOCK||entry.path.startsWith(LOCK+'/')) throw new Error('Invalid installation recovery entry');
    seen.add(entry.path);
    contained(root,entry.path);
    if(!Object.hasOwn(entry,'beforeFile')) {
      if(entry.before!==null && typeof entry.before!=='string' || Object.hasOwn(entry,'beforeFileIdentity')) throw new Error('Invalid recovery bytes');
      if(hashBytes(entry.before===null?null:Buffer.from(entry.before,'base64'))!==entry.beforeHash) throw new Error('Invalid recovery fingerprint');
    }
    if(entry.afterHash!==null && !/^[a-f0-9]{64}$/.test(entry.afterHash)) throw new Error('Invalid recovery fingerprint');
  }
  const occupied=[...seen,JOURNAL,GROUP_JOURNAL,RUN_IGNORE,LOCK];
  for(const entry of journal.changes)validateStaging(root,entry.staging,entry.path,occupied);
  if(journal.runtimeIgnoreStaging!==undefined&&!journal.runtimeIgnoreCreated)throw new Error('Invalid runtime ignore staging');
  validateStaging(root,journal.runtimeIgnoreStaging,RUN_IGNORE,occupied);
  for(const path of journal.missingDirectories) contained(root,path);
  assertBeforeImages(root,journal);
  return journal;
}
function assertMutationAvailable(root) {
  assertNoStagingConflict(root);
  const lock=contained(root,LOCK);
  if(!existsSync(lock)) return;
  let owner;try { owner=JSON.parse(fileSnapshot(root,LOCK+'/owner.json').bytes.toString('utf8')); } catch { throw new Error('Installation lock ownership cannot be verified'); }
  if(owner.stagingConflict!==undefined)throw new Error('Installation staging ownership conflict requires owner review');
  if(owner.host!==hostname() || !Number.isSafeInteger(owner.pid)||owner.pid<=0) throw new Error('Installation lock ownership cannot be verified');
  try { process.kill(owner.pid,0);throw new Error('Another installation transaction is active'); }
  catch(error) { if(error.code!=='ESRCH') throw error; }
}
function releaseDeadLock(root) {
  const lock=contained(root,LOCK);
  assertMutationAvailable(root);
  if(!existsSync(lock))return;
  // Never erase an unexpected file placed inside the lock.
  const ownerFile=contained(root,LOCK+'/owner.json');
  // Only this one file belongs to the verified dead process; rmdir refuses other data.
  const original=readFileSync(ownerFile);
  unlinkSync(ownerFile);
  try { retryWindowsFileOperation(()=>rmdirSync(lock),{validate:()=>contained(root,LOCK)}); } catch(error) { writeFileSync(ownerFile,original,{flag:'wx'});throw error; }
}
function acquireMutationLock(root) {
  const lock=contained(root,LOCK);
  mkdirSync(dirname(lock),{recursive:true});
  try { mkdirSync(lock); } catch(error) { throw new Error('Another installation transaction is active',{cause:error}); }
  try { writeFileSync(contained(root,LOCK+'/owner.json'),JSON.stringify({pid:process.pid,host:hostname()})+'\n',{flag:'wx',mode:0o600}); }
  catch(error) { rmdirSync(lock);throw error; }
}
function releaseMutationLock(root) {
  // A failed exclusive create must remain blocked even through an outer finally.
  try {assertNoStagingConflict(root);}catch(error){if(STAGING_CONFLICTS.some(path=>existsSync(contained(root,path))))return;throw error;}
  const owner=JSON.parse(fileSnapshot(root,LOCK+'/owner.json').bytes.toString('utf8'));
  if(owner.stagingConflict!==undefined)return;
  unlinkSync(contained(root,LOCK+'/owner.json'));retryWindowsFileOperation(()=>rmdirSync(contained(root,LOCK)),{validate:()=>contained(root,LOCK)});
}
function assertNoStagingConflict(root) {
  for(const path of STAGING_CONFLICTS)if(fileSnapshot(root,path).hash!==null)throw new Error('Installation staging ownership conflict requires owner review');
}
function recordStagingConflict(root,journal,error) {
  // EEXIST proves this process did not create the stage, even when its bytes match.
  // Keep the original before-images intact and require owner review on later recovery.
  try {writeFileSync(contained(root,journal+'.staging-conflict'),JSON.stringify({schema_version:1,staging:error.installationStagingConflict})+'\n',{flag:'wx',mode:0o600});}
  catch(recordError) {
    if(recordError.code==='EEXIST')return;
    // If the directory cannot accept a sidecar, poison the owned lock instead.
    // A partial write also fails closed because its owner can no longer be verified.
    const descriptor=openSync(contained(root,LOCK+'/owner.json'),'r+');
    try {
      const stat=fstatSync(descriptor),expected=Buffer.from(JSON.stringify({pid:process.pid,host:hostname()})+'\n');
      if(!stat.isFile()||stat.nlink!==1||!readFileSync(descriptor).equals(expected))throw new Error('Installation lock ownership cannot be verified');
      const blocked=Buffer.from(JSON.stringify({pid:process.pid,host:hostname(),stagingConflict:error.installationStagingConflict})+'\n');
      ftruncateSync(descriptor,0);
      if(writeSync(descriptor,blocked,0,blocked.length,0)!==blocked.length)throw new Error('Incomplete staging-conflict lock record');
    }finally {closeSync(descriptor);}
  }
}

export function recoverInstallation(root,{allowedPaths}={}) {
  root=resolve(root);
  assertNoStagingConflict(root);
  if(existsSync(contained(root,GROUP_JOURNAL)))throw new Error('A coordinated installation requires recovery with all authorized profile roots');
  const file=contained(root,JOURNAL);
  if(!existsSync(file)) return {recovered:false};
  assertMutationAvailable(root);
  const snapshot=fileSnapshot(root,JOURNAL);
  let journal;try { journal=validJournal(root,JSON.parse(snapshot.bytes.toString('utf8'))); } catch { throw new Error('Invalid installation recovery journal'); }
  const authorized=normalizeInstallationPaths(allowedPaths===undefined
    ?fileSnapshot(root,CONFIG_PATH).bytes===null?null:projectAllowedPaths(loadProjectConfig({projectDir:root}).config)
    :allowedPaths);
  for(const entry of journal.changes)assertWriteAllowed(authorized,entry.path);
  for(const path of journal.missingDirectories)assertDirectoryAllowed(authorized,path);
  for(const path of journal.cycleLockPaths||[])assertWriteAllowed(authorized,path);
  assertJournalStaging(root,journal);
  if(journal.runtimeIgnoreCreated) {
    const ignore=fileSnapshot(root,RUN_IGNORE).bytes;
    if(ignore!==null&&!ignore.equals(Buffer.from('*\n')))throw new Error('Recovery runtime ignore changed');
  }
  const leave=journal.cycleLockPaths?enterCycleRelocationGuard(root,journal.cycleLockPaths):null;
  const result=runThenRelease(leave,()=>{
    releaseDeadLock(root);
    acquireMutationLock(root);
    try {
      restoreJournal(root,journal);unlinkSync(file);
      // Forget the recovery journal before its images: a crash can orphan images, never leave an unusable journal.
      clearBeforeImages(root,journal);
      if(journal.runtimeIgnoreCreated) { try { unlinkSync(contained(root,RUN_IGNORE)); } catch(error) { if(error.code!=='ENOENT') throw error; } }
    } finally { releaseMutationLock(root); }
    return {recovered:true,files:journal.changes.length};
  });
  removeEmpty(root,journal.missingDirectories);
  return result;
}

export function applyInstallationPlan(plan,{removeRuntimeIgnore=false}={}) {
  plan.assertReady();
  const leave = plan.enterGuard?.();
  return runThenRelease(leave,()=>applyGuardedInstallationPlan(plan,{removeRuntimeIgnore}));
}

function applyGuardedInstallationPlan(plan,{removeRuntimeIgnore=false}={}) {
  plan.assertReady();
  if(!plan.changes.length) return {changed:0};
  const root=plan.root,file=contained(root,JOURNAL);
  if(existsSync(contained(root,GROUP_JOURNAL)))throw new Error('A coordinated installation requires recovery with all authorized profile roots');
  if(existsSync(file)) throw new Error('Unfinished installation transaction; recover it before continuing');
  releaseDeadLock(root);
  const missing=missingDirectories(root,plan.changes);
  const previousIgnore=fileSnapshot(root,RUN_IGNORE);
  if(previousIgnore.bytes!==null && previousIgnore.bytes.toString('utf8')!=='*\n') throw new Error('Installation runtime ignore intersects existing project data');
  try { acquireMutationLock(root); } catch(error) { removeEmpty(root,missing);throw error; }
  let complete=false,journalWritten=false,retainLock=false,journal;
  try {
    // A second installer or editor might have touched a destination while we acquired the lock.
    plan.assertReady();
    const {fields,...storage}=prepareBeforeImages(root,plan.changes);
    journal={schema_version:1,missingDirectories:missing,runtimeIgnoreCreated:previousIgnore.bytes===null,...storage,
      ...(plan.cycleLockPaths?{cycleLockPaths:[...plan.cycleLockPaths]}:{}),
      ...(previousIgnore.bytes===null?{runtimeIgnoreStaging:stagingPath(RUN_IGNORE)}:{}),changes:plan.changes.map((entry,index)=>({path:entry.path,staging:stagingPath(entry.path),
        ...fields[index],beforeHash:entry.beforeHash,beforeMode:entry.beforeMode,afterHash:entry.afterHash}))};
    validJournal(root,journal);assertJournalStaging(root,journal,{unused:true});
    writeFileSync(file,JSON.stringify(journal)+'\n',{flag:'wx',mode:0o600});journalWritten=true;
    if(previousIgnore.bytes===null) publish(root,RUN_IGNORE,Buffer.from('*\n'),0o644,null,journal.runtimeIgnoreStaging);
    for(const [index,entry] of plan.changes.entries()) publish(root,entry.path,entry.after,entry.mode,entry.beforeHash,journal.changes[index].staging);
    assertBeforeImages(root,journal);
    unlinkSync(file);journalWritten=false;
    complete=true;
  } catch(error) {
    if(journalWritten&&error.installationStagingConflict) {
      retainLock=true;
      throw new Error('Installation staging ownership conflict; recovery journal retained for owner review',{cause:error});
    }
    if(journalWritten) {
      try { restoreJournal(root,journal);unlinkSync(file);journalWritten=false; }
      catch(recoveryError) { throw new Error('Installation failed; recovery journal retained',{cause:recoveryError}); }
    }
    throw error;
  } finally {
    try {
      if(journal&&!existsSync(file))clearBeforeImages(root,journal);
      if(complete&&removeRuntimeIgnore) unlinkSync(contained(root,RUN_IGNORE));
      if(!existsSync(file) && !complete&&previousIgnore.bytes===null) {
        try { unlinkSync(contained(root,RUN_IGNORE)); } catch(error) { if(error.code!=='ENOENT') throw error; }
      }
    } finally {
      if(!retainLock)releaseMutationLock(root);
      if(!complete&&!journalWritten) removeEmpty(root,missing);
    }
  }
  return {changed:plan.changes.length};
}

// The coordinator shares path validation, locks, guarded atomic writes and recovery with one-root plans.
export const transactionIO=Object.freeze({contained,missingDirectories,removeEmpty,publish,restoreJournal,validJournal,
  stagingPath,validateStaging,journalStaging,assertStaging,clearStaging,assertJournalStaging,clearJournalStaging,
  assertNoStagingConflict,recordStagingConflict,
  assertMutationAvailable,releaseDeadLock,acquireMutationLock,releaseMutationLock,assertWriteAllowed,assertDirectoryAllowed,JOURNAL,RUN_IGNORE});
