// Cross-root transactions use explicitly supplied capabilities; a journal cannot authorize a path.
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { relative, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InstallationPlan, fileSnapshot, hashBytes, GROUP_JOURNAL, normalizeInstallationPaths, transactionIO as io } from './installation-transaction.mjs';
const rootKey=root=>process.platform==='win32'?resolve(root).toLowerCase():resolve(root);
const rootId=root=>hashBytes(Buffer.from(rootKey(root)));
const bytes=value=>Buffer.from(JSON.stringify(value)+'\n');
function scopesFor(roots) {
  const scopes=roots.map(value=>{
    const root=typeof value==='string'?value:value.root;
    return {root:resolve(root),id:rootId(root),allowedPaths:normalizeInstallationPaths(typeof value==='string'?null:value.allowedPaths??null)};
  }).sort((a,b)=>a.id.localeCompare(b.id,'en'));
  if(new Set(scopes.map(scope=>scope.id)).size!==scopes.length)throw new Error('Coordinated roots must be distinct');
  const footprints=scope=>scope.allowedPaths===null?[{path:rootKey(scope.root),recursive:true}]:[
    ...scope.allowedPaths.map(entry=>({path:rootKey(resolve(scope.root,entry.path)),recursive:entry.recursive})),
    {path:rootKey(resolve(scope.root,'.0-code/run')),recursive:true}];
  const contains=(a,b)=>{const path=relative(a.path,b.path);return path===''||a.recursive&&!isAbsolute(path)&&path!=='..'&&!path.startsWith('..'+(process.platform==='win32'?'\\':'/'));};
  for(const a of scopes)for(const b of scopes)if(a!==b)
    for(const x of footprints(a))for(const y of footprints(b))if(contains(x,y)||contains(y,x))throw new Error('Coordinated write locations must not overlap');
  for(const scope of scopes)io.contained(scope.root,GROUP_JOURNAL);
  return scopes;
}
function inspectMarkers(scopes,group,{allowMissing=false}={}) {
  for(const scope of scopes) {
    const data=fileSnapshot(scope.root,GROUP_JOURNAL).bytes;
    if(data===null) {if(allowMissing)continue;throw new Error('Coordinated recovery marker is missing');}
    let marker;try{marker=JSON.parse(data.toString('utf8'));}catch{throw new Error('Invalid coordinated recovery marker');}
    if(marker.schema_version!==2||marker.id!==group.id||marker.primary!==group.primary)
      throw new Error('Coordinated recovery marker belongs to another transaction');
    const expected=scope.id===group.primary?group:{schema_version:2,id:group.id,primary:group.primary};
    if(!data.equals(bytes(expected)))throw new Error('Coordinated recovery marker changed');
  }
}
function validateGroup(group,scopes,primary) {
  if(!group||group.schema_version!==2||typeof group.id!=='string'||!/^[a-f0-9-]{36}$/.test(group.id)
    ||group.primary!==rootId(primary)||!['applying','committed'].includes(group.phase)||!Array.isArray(group.scopes))
    throw new Error('Invalid coordinated recovery journal');
  const capabilities=new Map(scopes.map(scope=>[scope.id,scope.root])),seen=new Set();
  for(const leg of group.scopes) {
    if(!capabilities.has(leg.id)||seen.has(leg.id))throw new Error('Coordinated recovery requires the exact authorized roots');
    seen.add(leg.id);
    io.validJournal(capabilities.get(leg.id),{schema_version:1,...leg});
    const scope=scopes.find(scope=>scope.id===leg.id);
    for(const entry of leg.changes)io.assertWriteAllowed(scope.allowedPaths,entry.path);
    if(typeof leg.runtimeIgnoreCreated!=='boolean'||leg.changes.some(entry=>entry.path===GROUP_JOURNAL))
      throw new Error('Invalid coordinated recovery entry');
  }
  if(seen.size!==scopes.length)throw new Error('Coordinated recovery requires the exact authorized roots');
  const leg=group.scopes.find(leg=>leg.id===group.primary);
  io.validateStaging(primary,group.commitStaging,GROUP_JOURNAL,[...leg.changes.map(entry=>entry.path),
    ...io.journalStaging(leg).map(entry=>entry.path),io.JOURNAL,GROUP_JOURNAL,io.RUN_IGNORE,'.0-code/run/installation.lock']);
  return group;
}
function lockAll(scopes) {
  for(const scope of scopes)io.assertMutationAvailable(scope.root);
  for(const scope of scopes)io.releaseDeadLock(scope.root);
  const acquired=[];
  try {for(const scope of scopes){io.acquireMutationLock(scope.root);acquired.push(scope);}}
  catch(error) {for(const scope of acquired.reverse())io.releaseMutationLock(scope.root);throw error;}
  return ()=>{let failure;for(const scope of [...acquired].reverse())try{io.releaseMutationLock(scope.root);}catch(error){failure??=error;}if(failure)throw failure;};
}
function assertKnown(group,scopes) {
  const byId=new Map(scopes.map(scope=>[scope.id,scope.root]));
  for(const leg of group.scopes) {
    const root=byId.get(leg.id);
    io.assertNoStagingConflict(root);
    const ignore=fileSnapshot(root,io.RUN_IGNORE).bytes;
    if(ignore!==null&&!ignore.equals(Buffer.from('*\n')))throw new Error('Coordinated runtime ignore changed');
    io.assertJournalStaging(root,leg);
    for(const entry of leg.changes) {
      const current=fileSnapshot(root,entry.path).hash;
      if(group.phase==='committed'?current!==entry.afterHash:current!==entry.beforeHash&&current!==entry.afterHash)
        throw new Error('Coordinated recovery intersects a changed file: '+entry.path);
    }
  }
  io.assertStaging(byId.get(group.primary),group.commitStaging,[hashBytes(bytes({...group,phase:'committed'}))]);
}
function clearMarkers(group,scopes,primary) {
  inspectMarkers(scopes,group,{allowMissing:true});
  for(const scope of [...scopes].sort((a,b)=>Number(a.id===group.primary)-Number(b.id===group.primary))) {
    const path=io.contained(scope.root,GROUP_JOURNAL);if(existsSync(path))unlinkSync(path);
  }
}
function restore(group,scopes,primary) {
  assertKnown(group,scopes);const byId=new Map(scopes.map(scope=>[scope.id,scope.root]));
  io.clearStaging(primary,group.commitStaging,[hashBytes(bytes({...group,phase:'committed'}))]);
  if(group.phase==='applying')for(const leg of [...group.scopes].reverse())io.restoreJournal(byId.get(leg.id),leg,{journalPath:GROUP_JOURNAL});
  if(group.phase==='committed')for(const leg of group.scopes)io.clearJournalStaging(byId.get(leg.id),leg);
  if(group.phase==='applying')for(const leg of group.scopes)if(leg.runtimeIgnoreCreated) {
    const path=io.contained(byId.get(leg.id),io.RUN_IGNORE);if(existsSync(path))unlinkSync(path);
  }
  if(group.phase==='committed')for(const leg of group.scopes)if(leg.removeRuntimeIgnore) {
    const path=io.contained(byId.get(leg.id),io.RUN_IGNORE);if(existsSync(path))unlinkSync(path);
  }
  clearMarkers(group,scopes,primary);
}
export function recoverInstallationGroup(primary,roots) {
  primary=resolve(primary);const scopes=scopesFor(roots);
  for(const scope of scopes)io.assertNoStagingConflict(scope.root);
  if(!scopes.some(scope=>scope.id===rootId(primary)))throw new Error('Primary root is not an authorized capability');
  const data=fileSnapshot(primary,GROUP_JOURNAL).bytes;
  if(data===null) {
    if(scopes.some(scope=>fileSnapshot(scope.root,GROUP_JOURNAL).bytes!==null))throw new Error('The primary coordinated recovery journal is missing');
    return {recovered:false};
  }
  let group;try{group=JSON.parse(data.toString('utf8'));}catch{throw new Error('Invalid coordinated recovery journal');}
  validateGroup(group,scopes,primary);inspectMarkers(scopes,group,{allowMissing:true});assertKnown(group,scopes);
  if(scopes.some(scope=>fileSnapshot(scope.root,io.JOURNAL).bytes!==null))throw new Error('A one-root recovery journal intersects the coordinated transaction');
  const unlock=lockAll(scopes);
  try {inspectMarkers(scopes,group,{allowMissing:true});restore(group,scopes,primary);}finally{unlock();}
  if(group.phase==='applying')for(const leg of group.scopes)io.removeEmpty(scopes.find(scope=>scope.id===leg.id).root,leg.missingDirectories);
  return {recovered:true,committed:group.phase==='committed',files:group.scopes.reduce((sum,leg)=>sum+leg.changes.length,0)};
}
export function applyInstallationGroup(plans,{primary=plans[0]?.root,removeRuntimeIgnores=[]}={}) {
  if(!Array.isArray(plans)||!plans.length||plans.some(plan=>!(plan instanceof InstallationPlan)))throw new Error('Coordinated installation needs ordinary plans');
  primary=resolve(primary);const scopes=scopesFor(plans.map(plan=>({root:plan.root,allowedPaths:plan.allowedPaths})));
  if(!scopes.some(scope=>scope.id===rootId(primary)))throw new Error('Primary root is not an authorized capability');
  const byId=new Map(plans.map(plan=>[rootId(plan.root),plan]));
  if(removeRuntimeIgnores.some(root=>!byId.has(rootId(root))))throw new Error('Runtime cleanup root is not authorized');
  for(const scope of scopes) {
    byId.get(scope.id).assertReady();
    if(fileSnapshot(scope.root,GROUP_JOURNAL).bytes!==null||fileSnapshot(scope.root,io.JOURNAL).bytes!==null)
      throw new Error('Recover unfinished installation before coordinating roots');
  }
  const count=plans.reduce((sum,plan)=>sum+plan.changes.length,0);if(!count)return {changed:0};
  const group={schema_version:2,id:randomUUID(),primary:rootId(primary),phase:'applying',commitStaging:io.stagingPath(GROUP_JOURNAL),scopes:scopes.map(scope=>{
    const ignore=fileSnapshot(scope.root,io.RUN_IGNORE).bytes;
    if(ignore!==null&&!ignore.equals(Buffer.from('*\n')))throw new Error('Coordinated runtime ignore intersects existing data');
    const plan=byId.get(scope.id);
    return {id:scope.id,missingDirectories:io.missingDirectories(scope.root,plan.changes),runtimeIgnoreCreated:ignore===null,
      ...(ignore===null?{runtimeIgnoreStaging:io.stagingPath(io.RUN_IGNORE)}:{}),
      ...(removeRuntimeIgnores.some(root=>rootId(root)===scope.id)?{removeRuntimeIgnore:true}:{}),
      changes:plan.changes.map(entry=>({path:entry.path,staging:io.stagingPath(entry.path),before:entry.before===null?null:entry.before.toString('base64'),
        beforeHash:entry.beforeHash,beforeMode:entry.beforeMode,afterHash:entry.afterHash}))};
  })};
  let unlock;
  try {unlock=lockAll(scopes);}catch(error){for(const leg of group.scopes)io.removeEmpty(scopes.find(scope=>scope.id===leg.id).root,leg.missingDirectories);throw error;}
  let journalWritten=false,complete=false,retainLocks=false;
  try {
    for(const scope of scopes)byId.get(scope.id).assertReady();
    validateGroup(group,scopes,primary);
    for(const leg of group.scopes)io.assertJournalStaging(scopes.find(scope=>scope.id===leg.id).root,leg,{unused:true});
    if(fileSnapshot(primary,group.commitStaging).hash!==null)throw new Error('Installation commit staging already exists');
    // Persist all before-images before the first application file changes. Primary disappears last.
    writeFileSync(io.contained(primary,GROUP_JOURNAL),bytes(group),{flag:'wx',mode:0o600});journalWritten=true;
    for(const scope of scopes) {
      if(scope.id!==group.primary)writeFileSync(io.contained(scope.root,GROUP_JOURNAL),bytes({schema_version:2,id:group.id,primary:group.primary}),{flag:'wx',mode:0o600});
      const leg=group.scopes.find(leg=>leg.id===scope.id);
      if(leg.runtimeIgnoreCreated)io.publish(scope.root,io.RUN_IGNORE,Buffer.from('*\n'),0o644,null,leg.runtimeIgnoreStaging,GROUP_JOURNAL);
    }
    for(const scope of scopes)for(const [index,entry] of byId.get(scope.id).changes.entries())
      io.publish(scope.root,entry.path,entry.after,entry.mode,entry.beforeHash,group.scopes.find(leg=>leg.id===scope.id).changes[index].staging,GROUP_JOURNAL);
    const before=fileSnapshot(primary,GROUP_JOURNAL).hash;group.phase='committed';
    io.publish(primary,GROUP_JOURNAL,bytes(group),0o600,before,group.commitStaging,GROUP_JOURNAL);complete=true;
    restore(group,scopes,primary);journalWritten=false;
  } catch(error) {
    if(journalWritten&&error.installationStagingConflict) {
      retainLocks=true;
      throw new Error('Coordinated staging ownership conflict; recovery journal retained for owner review',{cause:error});
    }
    if(journalWritten&&!complete)try{group.phase='applying';inspectMarkers(scopes,group,{allowMissing:true});restore(group,scopes,primary);journalWritten=false;}
      catch(recoveryError){throw new Error('Coordinated installation failed; recovery journal retained',{cause:recoveryError});}
    throw error;
  } finally {
    if(!retainLocks)unlock();
    if(!complete&&!journalWritten)for(const leg of group.scopes)io.removeEmpty(scopes.find(scope=>scope.id===leg.id).root,leg.missingDirectories);
  }
  return {changed:count,roots:scopes.length};
}
