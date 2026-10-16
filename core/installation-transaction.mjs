// A complete plan is validated before the first mutation. Recovery never overwrites a third party.
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolveProjectPath, projectRelativePath } from './project-config.mjs';
import { replaceFileSync, retryWindowsFileOperation } from '../lib/replace-file.mjs';

const JOURNAL = '.0-code/run/installation-transaction.json';
const LOCK = '.0-code/run/installation.lock';
const RUN_IGNORE = '.0-code/run/.gitignore';
export const GROUP_JOURNAL = '.0-code/run/installation-group.json';
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
    throw new Error('Installation path is outside the authorized native locations');
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

export class InstallationPlan {
  constructor(root,{allowedPaths=null}={}) { this.root=resolve(root);this.allowedPaths=normalizeInstallationPaths(allowedPaths);this.changes=[];this.conflicts=[]; }
  change(path,content,{overwrite=false,expectedHash,mode=0o644,preserveMode=true}={}) {
    const normalized=projectRelativePath(path,{allowFramework:true});
    assertWriteAllowed(this.allowedPaths,normalized);
    if(normalized===JOURNAL || normalized===GROUP_JOURNAL || normalized===RUN_IGNORE || normalized===LOCK || normalized.startsWith(LOCK+'/')) throw new Error('Installation plan uses transaction internals');
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
    if(this.conflicts.length) { const error=new Error('Installation intersections require a decision');error.conflicts=this.conflicts;throw error; }
    for(const entry of this.changes) {
      assertWriteAllowed(this.allowedPaths,entry.path);
      if(this.changes.some(other=>other!==entry && entry.path.startsWith(other.path+'/'))) throw new Error('Installation file paths overlap');
      if(fileSnapshot(this.root,entry.path).hash!==entry.beforeHash) throw new Error(`Installation target changed: ${entry.path}`);
    }
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
function removeEmpty(root,directories) {
  for(const path of [...directories].sort((a,b)=>b.split('/').length-a.split('/').length)) {
    try { retryWindowsFileOperation(()=>rmdirSync(contained(root,path)),{
      validate:()=>contained(root,path),retryCodes:['EPERM','EACCES','EBUSY','ENOTEMPTY']}); }
    catch(error) { if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code)) throw error; }
  }
}
function publish(root,path,bytes,mode,expected) {
  const destination=contained(root,path);
  if(snapshotFile(destination).hash!==expected) throw new Error(`Installation target changed: ${path}`);
  if(bytes===null) { if(expected!==null) unlinkSync(destination);return; }
  if(!existsSync(dirname(destination)))mkdirSync(dirname(destination),{recursive:true});
  const staging=join(dirname(destination),`.0code-${randomUUID()}.tmp`);
  try {
    writeFileSync(staging,bytes,{flag:'wx',mode});
    replaceFileSync(staging,destination,{validate() {
      if(fileSnapshot(root,path).hash!==expected) throw new Error(`Installation target changed: ${path}`);
    }});
    chmodSync(destination,mode);
  } finally { try { unlinkSync(staging); } catch(error) { if(error.code!=='ENOENT') throw error; } }
}
function restoreJournal(root,journal) {
  // Check the entire journal before restoring one file: an unexpected byte belongs to somebody else.
  for(const entry of journal.changes) {
    const current=fileSnapshot(root,entry.path).hash;
    if(current!==entry.beforeHash && current!==entry.afterHash) throw new Error(`Recovery intersection: ${entry.path}`);
  }
  for(const entry of [...journal.changes].reverse()) {
    const current=fileSnapshot(root,entry.path).hash;
    if(current!==entry.beforeHash) publish(root,entry.path,entry.before===null?null:Buffer.from(entry.before,'base64'),entry.beforeMode??0o644,current);
  }
}
function validJournal(root,journal) {
  if(!journal || journal.schema_version!==1 || !Array.isArray(journal.changes) || !Array.isArray(journal.missingDirectories)) throw new Error('Invalid installation recovery journal');
  const seen=new Set();
  for(const entry of journal.changes) {
    if(typeof entry.path!=='string'||seen.has(entry.path)||entry.path===JOURNAL||entry.path===RUN_IGNORE||entry.path===LOCK||entry.path.startsWith(LOCK+'/')) throw new Error('Invalid installation recovery entry');
    seen.add(entry.path);
    contained(root,entry.path);
    if(entry.before!==null && typeof entry.before!=='string') throw new Error('Invalid recovery bytes');
    if(hashBytes(entry.before===null?null:Buffer.from(entry.before,'base64'))!==entry.beforeHash
      || (entry.afterHash!==null && !/^[a-f0-9]{64}$/.test(entry.afterHash))) throw new Error('Invalid recovery fingerprint');
  }
  for(const path of journal.missingDirectories) contained(root,path);
  return journal;
}
function assertMutationAvailable(root) {
  const lock=contained(root,LOCK);
  if(!existsSync(lock)) return;
  let owner;try { owner=JSON.parse(fileSnapshot(root,LOCK+'/owner.json').bytes.toString('utf8')); } catch { throw new Error('Installation lock ownership cannot be verified'); }
  if(owner.host!==hostname() || !Number.isSafeInteger(owner.pid)||owner.pid<=0) throw new Error('Installation lock ownership cannot be verified');
  try { process.kill(owner.pid,0);throw new Error('Another installation transaction is active'); }
  catch(error) { if(error.code!=='ESRCH') throw error; }
}
function releaseDeadLock(root) {
  const lock=contained(root,LOCK);
  if(!existsSync(lock))return;
  assertMutationAvailable(root);
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
function releaseMutationLock(root) { unlinkSync(contained(root,LOCK+'/owner.json'));retryWindowsFileOperation(()=>rmdirSync(contained(root,LOCK)),{validate:()=>contained(root,LOCK)}); }

export function recoverInstallation(root) {
  root=resolve(root);
  if(existsSync(contained(root,GROUP_JOURNAL)))throw new Error('A coordinated installation requires recovery with all authorized profile roots');
  const file=contained(root,JOURNAL);
  if(!existsSync(file)) return {recovered:false};
  releaseDeadLock(root);
  const snapshot=fileSnapshot(root,JOURNAL);
  let journal;try { journal=validJournal(root,JSON.parse(snapshot.bytes.toString('utf8'))); } catch { throw new Error('Invalid installation recovery journal'); }
  acquireMutationLock(root);
  try {
    restoreJournal(root,journal);unlinkSync(file);
    if(journal.runtimeIgnoreCreated) { try { unlinkSync(contained(root,RUN_IGNORE)); } catch(error) { if(error.code!=='ENOENT') throw error; } }
  } finally { releaseMutationLock(root); }
  removeEmpty(root,journal.missingDirectories);
  return {recovered:true,files:journal.changes.length};
}

export function applyInstallationPlan(plan,{removeRuntimeIgnore=false}={}) {
  plan.assertReady();
  if(!plan.changes.length) return {changed:0};
  const root=plan.root,lock=contained(root,LOCK),file=contained(root,JOURNAL);
  if(existsSync(contained(root,GROUP_JOURNAL)))throw new Error('A coordinated installation requires recovery with all authorized profile roots');
  if(existsSync(file)) throw new Error('Unfinished installation transaction; recover it before continuing');
  releaseDeadLock(root);
  const missing=missingDirectories(root,plan.changes);
  const previousIgnore=fileSnapshot(root,RUN_IGNORE);
  if(previousIgnore.bytes!==null && previousIgnore.bytes.toString('utf8')!=='*\n') throw new Error('Installation runtime ignore intersects existing project data');
  try { acquireMutationLock(root); } catch(error) { removeEmpty(root,missing);throw error; }
  let complete=false,journalWritten=false;
  const journal={schema_version:1,missingDirectories:missing,runtimeIgnoreCreated:previousIgnore.bytes===null,changes:plan.changes.map(entry=>({path:entry.path,
    before:entry.before===null?null:entry.before.toString('base64'),beforeHash:entry.beforeHash,beforeMode:entry.beforeMode,afterHash:entry.afterHash}))};
  try {
    // A second installer or editor might have touched a destination while we acquired the lock.
    plan.assertReady();
    if(previousIgnore.bytes===null) publish(root,RUN_IGNORE,Buffer.from('*\n'),0o644,null);
    writeFileSync(file,JSON.stringify(journal)+'\n',{flag:'wx',mode:0o600});journalWritten=true;
    for(const entry of plan.changes) publish(root,entry.path,entry.after,entry.mode,entry.beforeHash);
    complete=true;
  } catch(error) {
    if(journalWritten) {
      try { restoreJournal(root,journal);unlinkSync(file);journalWritten=false; }
      catch(recoveryError) { throw new Error('Installation failed; recovery journal retained',{cause:recoveryError}); }
    }
    throw error;
  } finally {
    if(complete && journalWritten) unlinkSync(file);
    if(complete&&removeRuntimeIgnore) unlinkSync(contained(root,RUN_IGNORE));
    releaseMutationLock(root);
    if(!existsSync(file) && !complete&&previousIgnore.bytes===null) {
      try { unlinkSync(contained(root,RUN_IGNORE)); } catch(error) { if(error.code!=='ENOENT') throw error; }
    }
    if(!complete) removeEmpty(root,missing);
  }
  return {changed:plan.changes.length};
}

// The coordinator shares path validation, locks, guarded atomic writes and recovery with one-root plans.
export const transactionIO=Object.freeze({contained,missingDirectories,removeEmpty,publish,restoreJournal,validJournal,
  assertMutationAvailable,releaseDeadLock,acquireMutationLock,releaseMutationLock,assertWriteAllowed,JOURNAL,RUN_IGNORE});
