// Names identify candidates; only exact published bytes authorize deletion.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { InstallationPlan, fileSnapshot, hashBytes, applyInstallationPlan, recoverInstallation } from './installation-transaction.mjs';
import { FRAMEWORK_SOURCE } from './installation-bundle.mjs';
import { planProjectInstallation, readInstallationReceipt, RECEIPT_PATH } from './project-installation.mjs';
import { scanProject } from './project-inventory.mjs';
import { readNativeJson, nativeEntryHash, removeNativeArrayValues, removeNativeObjectValue } from '../lib/native-json.mjs';
import { LEGACY_DOCUMENT_DEFAULTS, normalizeProjectConfig } from './project-config.mjs';
import { isPidAlive, ownerState } from './loop-lock.mjs';
const BEGIN='<!-- BEGIN AUTONOMOUS FRAMEWORK -->',END='<!-- END AUTONOMOUS FRAMEWORK -->';
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
export function readMigrationEvidence(source=FRAMEWORK_SOURCE) {
  const proof=JSON.parse(readFileSync(join(source,'config/legacy-installations.json'),'utf8'));
  if(proof.schema_version!==1||!Array.isArray(proof.versions)||!Array.isArray(proof.files)||!Array.isArray(proof.instructions)||!Array.isArray(proof.settings))throw new Error('Invalid published migration evidence');
  const tags=new Set(proof.versions.map(version=>version.tag));
  for(const entry of proof.files)if(!entry.hashes||Object.entries(entry.hashes).some(([hash,versions])=>!/^[a-f0-9]{64}$/.test(hash)||!Array.isArray(versions)||versions.some(tag=>!tags.has(tag))))throw new Error('Invalid published file hash');
  return proof;
}
function stripInstructions(bytes,proof) {
  if(bytes===null)return bytes;
  const text=bytes.toString('utf8');if(!text.includes(BEGIN)&&!text.includes(END))return bytes;
  if(!Buffer.from(text).equals(bytes)||text.split(BEGIN).length!==2||text.split(END).length!==2||text.indexOf(END)<text.indexOf(BEGIN))throw new Error('Ambiguous legacy instruction markers; original preserved');
  const at=text.indexOf(BEGIN),end=text.indexOf(END)+END.length,block=text.slice(at,end);
  const header=block.match(/^<!-- BEGIN AUTONOMOUS FRAMEWORK -->\r?\n# Project: ([^\r\n]+)\r?\n\r?\nThis project is managed by the \*\*Claude Code Autonomous Framework\*\* v([0-9.]+)\./);
  const owned=header&&proof.instructions.some(entry=> {
    const rendered=entry.template.replaceAll('__PROJECT_NAME__',header[1]).replaceAll('__FRAMEWORK_VERSION__',header[2]).trimEnd();
    const expected=BEGIN+'\n'+rendered+'\n'+END;
    return block===expected||block===expected.replaceAll('\n','\r\n');
  });
  if(!owned)throw new Error('Legacy instruction body differs from published templates; original preserved');
  return Buffer.from(text.slice(0,at)+text.slice(end));
}
function legacySettings(bytes,proof,root) {
  if(bytes===null)return bytes;
  const data=readNativeJson(bytes);let result=bytes;
  const prefixes=['${CLAUDE_PROJECT_DIR}',root,root.replaceAll('\\','/')];
  function variants(value) {
    const replace=(value,prefix)=>typeof value==='string'?value.replaceAll('${CLAUDE_PROJECT_DIR}',prefix)
      :Array.isArray(value)?value.map(entry=>replace(entry,prefix)):value&&typeof value==='object'
        ?Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,replace(entry,prefix)])):value;
    return prefixes.map(prefix=>replace(value,prefix));
  }
  const templates=proof.settings.map(entry=>entry.template),events=Object.keys(data.hooks||{});
  for(const event of events) {
    if(!Array.isArray(data.hooks[event]))throw new Error('Malformed legacy hook groups; original preserved');
    const known=templates.flatMap(template=>template.hooks?.[event]||[]);
    const groupHashes=known.flatMap(variants).map(nativeEntryHash);
    result=removeNativeArrayValues(result,['hooks',event],groupHashes);
    const current=readNativeJson(result).hooks?.[event]||[],emptyHashes=[];
    for(let i=0;i<current.length;i++) {
      if(!Array.isArray(current[i]?.hooks))throw new Error('Malformed legacy hook commands; original preserved');
      const hookHashes=known.flatMap(group=>group.hooks||[]).flatMap(variants).map(nativeEntryHash);
      const changed=current[i].hooks.some(hook=>hookHashes.includes(nativeEntryHash(hook)));
      result=removeNativeArrayValues(result,['hooks',event,i,'hooks'],hookHashes);
      const group=readNativeJson(result).hooks?.[event]?.[i];
      if(changed&&group.hooks.length===0&&Object.keys(group).every(key=>['matcher','hooks'].includes(key)))emptyHashes.push(nativeEntryHash(group));
    }
    result=removeNativeArrayValues(result,['hooks',event],emptyHashes);
  }
  if(data.statusLine&&templates.some(template=>template.statusLine&&variants(template.statusLine).some(value=>nativeEntryHash(value)===nativeEntryHash(data.statusLine))))result=removeNativeObjectValue(result,['statusLine'],nativeEntryHash(data.statusLine));
  return result;
}
function copyPreparedPlan(prepared,receipt) {
  const plan=new InstallationPlan(prepared.root);
  for(const entry of prepared.plan.changes)if(entry.path!==RECEIPT_PATH)plan.change(entry.path,entry.after,{overwrite:true,expectedHash:entry.beforeHash,mode:entry.mode,preserveMode:false});
  plan.change(RECEIPT_PATH,json(receipt),{overwrite:true});return plan;
}
export function planProjectMigration(root,{source=FRAMEWORK_SOURCE,config,documentManifest,adoptionManifest}={}) {
  root=resolve(root);const previous=readInstallationReceipt(root);
  if(previous) {
    if(adoptionManifest&&previous.migration?.manifestHash!==hashBytes(Buffer.from(JSON.stringify(adoptionManifest))))throw new Error('Adoption manifest differs from the completed migration');
    if(!previous.migration&&!documentManifest)throw new Error('Project already uses the new installation; use upgrade');
    return planProjectInstallation(root,{source,config,upgrade:true,documentManifest});
  }
  if(adoptionManifest!==undefined) {
    const existing=JSON.parse(readFileSync(join(root,'.0-code/config.json'),'utf8'));
    const proposed=normalizeProjectConfig(config??existing);
    return planProjectInstallation(root,{source,config:proposed,upgrade:true,adoptionManifest,documentManifest});
  }
  const proof=readMigrationEvidence(source),removed=[],preserved=[],originalFiles=new Map();
  for(const entry of proof.files) {
    const snapshot=fileSnapshot(root,entry.path);if(snapshot.bytes===null)continue;
    if(Object.hasOwn(entry.hashes,snapshot.hash))removed.push({path:entry.path,hash:snapshot.hash,versions:entry.hashes[snapshot.hash]});
    else preserved.push({path:entry.path,reason:'Bytes are not proved by published releases'});
  }
  let instructionFound=false;
  for(const path of ['CLAUDE.md','AGENTS.md']) {
    const before=fileSnapshot(root,path).bytes,after=stripInstructions(before,proof);
    if(hashBytes(before)!==hashBytes(after)){originalFiles.set(path,after);instructionFound=true;}
  }
  if(!removed.length&&!instructionFound)throw new Error('No proved legacy installation to migrate');
  const settingsPath='.claude/settings.json',settingsBefore=fileSnapshot(root,settingsPath).bytes,settingsAfter=legacySettings(settingsBefore,proof,root);
  if(hashBytes(settingsBefore)!==hashBytes(settingsAfter))originalFiles.set(settingsPath,settingsAfter);
  const scan=scanProject(root),deleted=new Set(removed.map(entry=>entry.path));
  const inventory={...scan.inventory,tools:(scan.inventory.tools||[]).filter(tool=>!deleted.has(tool.path))};
  // Removing legacy code does not relocate documents. Preserve their roles until a move plan exists.
  const documents=scan.inventory.installation.detected?scan.suggestedConfig.documents:LEGACY_DOCUMENT_DEFAULTS;
  const proposed=normalizeProjectConfig(config??{...scan.suggestedConfig,documents},{documentDefaults:documents});
  const prepared=planProjectInstallation(root,{source,config:proposed,originalFiles,inventory,documentManifest,
    documentConfig:normalizeProjectConfig({...scan.suggestedConfig,documents})});
  const backups=[],runtime=[];
  const receipt={...prepared.receipt,migration:{versions:proof.versions.map(entry=>({tag:entry.tag,commit:entry.commit,url:entry.url})),removed,preserved,backups,runtime}};
  const plan=copyPreparedPlan(prepared,receipt);
  plan.preflight=prepared.plan.preflight;plan.enterGuard=prepared.plan.enterGuard;
  plan.cycleLockPaths=prepared.plan.cycleLockPaths;
  for(const path of new Set([...removed.map(entry=>entry.path),...originalFiles.keys()])) {
    const snapshot=fileSnapshot(root,path),backup='.0-code/run/migration/'+hashBytes(Buffer.from(path))+'.bin';
    plan.change(backup,snapshot.bytes,{mode:0o600,preserveMode:false});backups.push({path,backup,hash:snapshot.hash,mode:snapshot.mode});
    if(deleted.has(path))plan.change(path,null,{overwrite:true,expectedHash:snapshot.hash});
  }
  for(const name of ['.loop.lock','.loop-progress','.loop-children']) {
    const path=join(dirname(LEGACY_DOCUMENT_DEFAULTS.state.path),name).replaceAll('\\','/'),snapshot=fileSnapshot(root,path);
    if(snapshot.bytes===null)continue;
    let data;try{data=JSON.parse(snapshot.bytes.toString('utf8'));}catch{throw new Error('Legacy runtime format is ambiguous: '+path);}
    if(name==='.loop.lock') {
      if(!data||!Number.isInteger(data.pid)||!data.engine||!data.startedAt)throw new Error('Legacy cycle lock is ambiguous');
      if(isPidAlive(data.pid)||!['dead','stale'].includes(ownerState(data)))throw new Error('Stop the active legacy cycle before migration');
    } else if(name==='.loop-progress') {
      if(!data?.snapshot||typeof data.snapshot!=='object'||!Number.isFinite(data.stagnant)||!data.at)throw new Error('Legacy progress format is ambiguous');
    } else {
      if(!Array.isArray(data?.pids)||data.pids.some(pid=>!Number.isInteger(pid)||pid<=0))throw new Error('Legacy children format is ambiguous');
      if(data.pids.some(isPidAlive))throw new Error('Stop legacy child processes before migration');
    }
    const target='.0-code/run/'+name,backup='.0-code/run/migration/'+hashBytes(Buffer.from(path))+'.bin';
    // A dead/stale lock is archived rather than carried into the new driver's ownership.
    if(name!=='.loop.lock')plan.change(target,snapshot.bytes,{mode:0o600,preserveMode:false});
    plan.change(backup,snapshot.bytes,{mode:0o600,preserveMode:false});plan.change(path,null,{overwrite:true,expectedHash:snapshot.hash});
    backups.push({path,backup,hash:snapshot.hash,mode:snapshot.mode});runtime.push({path,target:name==='.loop.lock'?backup:target,hash:snapshot.hash});
  }
  // The backup index is private runtime data; adding it does not change installation ownership.
  const receiptChange=plan.changes.find(entry=>entry.path===RECEIPT_PATH);receiptChange.after=json(receipt);receiptChange.afterHash=hashBytes(receiptChange.after);
  plan.change('.0-code/run/migration/index.json',json(receipt.migration),{mode:0o600,preserveMode:false});
  plan.assertReady();return {...prepared,plan,receipt,migration:receipt.migration};
}
export function migrateProject(root,options={}) {
  recoverInstallation(root);const prepared=planProjectMigration(root,options);
  return {...prepared,result:applyInstallationPlan(prepared.plan)};
}
