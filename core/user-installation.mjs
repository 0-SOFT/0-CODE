// One machine installation, independent of projects. No consumer registry or reference counts.
import { homedir } from 'node:os';
import { existsSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveUserProfiles, compileUserTool } from './user-profiles.mjs';
import { isDocumentZone, normalizeProjectConfig, resolveProjectPath } from './project-config.mjs';
import { assembleInstallationBundle, FRAMEWORK_SOURCE } from './installation-bundle.mjs';
import { InstallationPlan, fileSnapshot, hashBytes, GROUP_JOURNAL } from './installation-transaction.mjs';
import { applyInstallationGroup, recoverInstallationGroup } from './installation-group.mjs';
import { RECEIPT_PATH, readInstallationReceipt, originalSnapshot, requireOwnership, directoriesFor } from './project-installation.mjs';
import { toolHeader } from './native-tools.mjs';
import { planMcpDelivery } from './mcp-delivery.mjs';
import { parseToml } from '../lib/toml-mini.mjs';
import { retryWindowsFileOperation } from '../lib/replace-file.mjs';
import { inspectMcpPrerequisites } from './mcp-prerequisites.mjs';
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const file=(root,path)=>resolveProjectPath(root,path,{allowFramework:true});
export function userInstallationLocation({env=process.env,home=homedir(),userDir}={}) {
  return resolve(userDir||env.ZERO_CODE_USER_DIR||join(home,'.local','share','0-code'));
}
function settingsFor(config) {
  const settings=normalizeProjectConfig(config||{});
  settings.inventory={};settings.toolset.scope='project';
  settings.modules={...Object.fromEntries(Object.keys(settings.modules).map(id=>[id,false])),toolset:true,mcp_catalog:settings.modules.mcp_catalog};
  return settings;
}
function scopesFor(config,profiles) {
  const scopes=new Map();
  const get=(root)=>{root=resolve(root);if(!scopes.has(root))scopes.set(root,{root,targets:new Map()});return scopes.get(root);};
  for(const engine of config.engines)get(profiles[engine].root);
  if(config.engines.includes('claude'))get(profiles.claude.mcp.root);
  return {scopes,get};
}
function validatePrevious(root,receipt,scopes) {
  if(!receipt)return;
  if(receipt.kind!=='user-toolset'||!Array.isArray(receipt.profiles))throw new Error('Directory is not an owned machine toolset');
  for(const scope of receipt.profiles) {
    if(!scopes.has(scope.root)||!Array.isArray(scope.files)||!Array.isArray(scope.directories))throw new Error('Native profile locations changed; remove the previous installation with its original environment');
    for(const entry of scope.files) {
      file(scope.root,entry.path);
      if(!/^[a-f0-9]{64}$/.test(entry.hash)||entry.backup&&!entry.backup.startsWith('.0-code/run/backups/'))throw new Error('Invalid machine ownership entry');
    }
  }
  requireOwnership(root,receipt);
  for(const scope of receipt.profiles)requireOwnership(scope.root,scope);
}
function append(original,text) {
  const suffix=(original?.length?'\n':'')+text;
  if(original?.includes(Buffer.from('# BEGIN 0-CODE')))throw new Error('Unowned machine instruction markers already exist');
  return {bytes:Buffer.concat([original||Buffer.alloc(0),Buffer.from(suffix)]),patch:{type:'suffix',text:suffix}};
}
export function planUserInstallation({config,source=FRAMEWORK_SOURCE,...options}={}) {
  const root=userInstallationLocation(options),profiles=resolveUserProfiles(options),receipt=readInstallationReceipt(root);
  const settings=settingsFor(config??receipt?.config);
  if(receipt&&JSON.stringify([...settings.engines].sort())!==JSON.stringify([...receipt.config.engines].sort()))throw new Error('Remove the machine installation before changing its engine set');
  // Keep previous engines while removing their files; roots are supplied by the current environment.
  const all={...settings,engines:[...new Set([...settings.engines,...(receipt?.config?.engines||[])])]};
  const {scopes,get}=scopesFor(all,profiles);
  validatePrevious(root,receipt,scopes);
  if(!receipt&&existsSync(file(root,'.0-code'))) {
    try { requireOwnership(root,{files:[],directories:[]}); }
    catch(error) { throw new Error('Machine directory has no ownership receipt: '+error.message,{cause:error}); }
  }
  const before=(scope,path)=>originalSnapshot(scope.root,path,receipt?.profiles.find(entry=>entry.root===scope.root)).bytes;
  // Installed user-scoped project kernels intentionally do not duplicate machine tool sources.
  const sourceReceipt=readInstallationReceipt(dirname(source));
  if(sourceReceipt&&sourceReceipt.kind!=='user-toolset'&&sourceReceipt.delivery?.scope==='user'&&receipt)source=join(root,'.0-code');
  const bundle=assembleInstallationBundle(settings,{source}),poolTargets=new Map();settings.framework_version=bundle.version;
  for(const [path,bytes] of bundle.files)poolTargets.set('.0-code/'+path,{bytes});
  const rows=[],registrations=[],rules=[];
  for(const entry of bundle.selection.selected) {
    if(entry.kind==='mcp')continue;
    const name='0-code-'+entry.name.replaceAll('/','-'),sourceFile=file(root,'.0-code/'+entry.source);
    if(entry.kind==='rules')rules.push(sourceFile);
    for(const engine of settings.engines) {
      const scope=get(profiles[engine].root),row={id:entry.id,kind:entry.kind,engine,name};
      if(entry.kind==='rules') {
        if(engine==='claude') {const path='rules/'+name+'.md';scope.targets.set(path,{bytes:Buffer.from('Read '+JSON.stringify(sourceFile)+'. Project rules and the active cycle prompt take precedence.\n')});rows.push({...row,status:'delivered',files:[path]});}
        else rows.push({...row,status:'reference'});
        continue;
      }
      try {
        const compiled=compileUserTool({engine,kind:entry.kind,name,source:sourceFile,fields:toolHeader(bundle.files.get(entry.source)).fields});
        scope.targets.set(compiled.path,{bytes:compiled.bytes});
        if(compiled.registration)registrations.push(compiled.registration);
        rows.push({...row,status:'delivered',files:[compiled.path],dropped_fields:compiled.dropped});
      } catch(error) {rows.push({...row,status:'unsupported',reason:error.message});}
    }
  }
  if(rules.length)for(const engine of settings.engines.filter(engine=>engine!=='claude')) {
    const scope=get(profiles[engine].root),path='AGENTS.md';
    scope.targets.set(path,append(before(scope,path),'# BEGIN 0-CODE RULES\nRead applicable rules below; project instructions and the active cycle prompt take precedence.\n'+rules.map(path=>'- '+JSON.stringify(path)).join('\n')+'\n# END 0-CODE RULES\n'));
  }
  if(registrations.length) {
    const scope=get(profiles.codex.root),path='config.toml',original=before(scope,path),text=original?.toString('utf8')||'';
    const parsed=parseToml(text);
    if(/^\s*agents\s*=/m.test(text)||registrations.some(entry=>Object.hasOwn(parsed.agents||{},entry.name)))throw new Error('Machine Codex roles intersect existing definitions');
    scope.targets.set(path,append(original,'# BEGIN 0-CODE TOOLS\n'+registrations.map(entry=>`[agents.${JSON.stringify(entry.name)}]\ndescription = ${JSON.stringify(entry.description)}\nconfig_file = ${JSON.stringify(entry.file)}\n`).join('\n')+'# END 0-CODE TOOLS\n'));
  }
  const nativeTargets=new Map(),nativeOriginal=path=> {
    if(path==='.mcp.json')return before(get(profiles.claude.mcp.root),profiles.claude.mcp.path);
    if(path==='.codex/config.toml')return before(get(profiles.codex.root),'config.toml');
    return before(get(profiles.opencode.root),path);
  };
  if(settings.engines.includes('codex')&&get(profiles.codex.root).targets.has('config.toml'))nativeTargets.set('.codex/config.toml',get(profiles.codex.root).targets.get('config.toml'));
  rows.push(...planMcpDelivery(root,settings,bundle,{original:nativeOriginal,targets:nativeTargets}));
  for(const [path,target] of nativeTargets) {
    if(path.startsWith('.0-code/')) {
      const spec=JSON.parse(target.bytes.toString('utf8'));spec.cwd='caller';poolTargets.set(path,{bytes:json(spec)});
    } else if(path==='.codex/config.toml')get(profiles.codex.root).targets.set('config.toml',target);
    else if(path==='.mcp.json')get(profiles.claude.mcp.root).targets.set(profiles.claude.mcp.path,target);
    else get(profiles.opencode.root).targets.set(path,target);
  }
  const delivery={schema_version:1,scope:'user',ready:rows.every(row=>row.status!=='unsupported'),tools:rows};
  poolTargets.set('.0-code/delivery.json',{bytes:json(delivery)});
  const plans=[],nextProfiles=[];
  function planScope(scope,previous,inside=false) {
    const paths=[...new Set([...scope.targets.keys(),...(previous?.files||[]).map(entry=>entry.path)])];
    const plan=new InstallationPlan(scope.root,{allowedPaths:inside?[{path:'.0-code',recursive:true}]:[...paths.map(path=>({path,recursive:false})),{path:'.0-code/run/backups',recursive:true}]});
    const entries=[];
    for(const [path,target] of scope.targets) {
      const old=previous?.files.find(entry=>entry.path===path),snapshot=fileSnapshot(scope.root,path);
      const original=old?originalSnapshot(scope.root,path,previous):snapshot;
      const writable=Boolean(old)||Boolean(target.patch);
      plan.change(path,target.bytes,{overwrite:writable,expectedHash:old?snapshot.hash:undefined});
      const entry={path,hash:hashBytes(target.bytes),originalHash:inside?null:original.hash,originalMode:inside?null:original.mode,...(target.patch?{patch:target.patch}:{})};
      if(entry.originalHash!==null) {
        entry.backup=old?.backup||'.0-code/run/backups/'+hashBytes(Buffer.from(path))+'.bin';
        if(!old||old.originalHash!==entry.originalHash)plan.change(entry.backup,original.bytes,{overwrite:Boolean(old?.backup),expectedHash:old?.originalHash,mode:0o600,preserveMode:false});
      }
      entries.push(entry);
    }
    for(const old of previous?.files||[])if(!scope.targets.has(old.path)) {
      plan.change(old.path,originalSnapshot(scope.root,old.path,previous).bytes,{overwrite:true,expectedHash:fileSnapshot(scope.root,old.path).hash});
      if(old.backup)plan.change(old.backup,null,{overwrite:true,expectedHash:old.originalHash});
    }
    const next={root:scope.root,files:entries,directories:directoriesFor(scope.root,[...scope.targets.keys()],previous?.directories),
      runtimeIgnoreOwned:previous?.runtimeIgnoreOwned??fileSnapshot(scope.root,'.0-code/run/.gitignore').bytes===null};
    plans.push(plan);return next;
  }
  for(const scope of scopes.values())nextProfiles.push(planScope(scope,receipt?.profiles.find(entry=>entry.root===scope.root)));
  const pool=planScope({root,targets:poolTargets},receipt,true),poolPlan=plans.at(-1);
  const nextReceipt={schema_version:1,kind:'user-toolset',framework_version:bundle.version,config:settings,delivery,files:pool.files,directories:pool.directories,runtimeIgnoreOwned:pool.runtimeIgnoreOwned,profiles:nextProfiles};
  poolPlan.change(RECEIPT_PATH,json(nextReceipt),{overwrite:Boolean(receipt)});
  for(const plan of plans)plan.assertReady();
  return {root,plans,receipt:nextReceipt,bundle,config:settings};
}
export function installUserTools(options={}) {
  recoverUserInstallation(options);
  const prepared=planUserInstallation(options);
  return {...prepared,result:applyInstallationGroup(prepared.plans,{primary:prepared.root})};
}
export function planUserUninstall(options={}) {
  const root=userInstallationLocation(options),receipt=readInstallationReceipt(root),profiles=resolveUserProfiles(options);
  if(!receipt)throw new Error('No owned machine toolset to remove');
  const {scopes}=scopesFor(receipt.config,profiles);validatePrevious(root,receipt,scopes);
  const plans=[];
  for(const previous of [...receipt.profiles,{root,files:receipt.files,directories:receipt.directories}]) {
    const plan=new InstallationPlan(previous.root,{allowedPaths:[...previous.files.map(entry=>({path:entry.path,recursive:false})),{path:'.0-code/run',recursive:true},...(previous.root===root?[{path:RECEIPT_PATH,recursive:false}]:[])]});
    for(const entry of previous.files)plan.change(entry.path,originalSnapshot(previous.root,entry.path,previous).bytes,{overwrite:true,expectedHash:fileSnapshot(previous.root,entry.path).hash});
    // Remove only the recorded backups. Runtime journals and locks are managed by the transaction.
    for(const entry of previous.files)if(entry.backup)plan.change(entry.backup,null,{overwrite:true,expectedHash:entry.originalHash});
    if(previous.root===root)plan.change(RECEIPT_PATH,null,{overwrite:true});
    plans.push(plan);
  }
  return {root,receipt,plans};
}
function prune(root,path) {
  if(isDocumentZone(path))return;
  if(!existsSync(file(root,path)))return;
  for(const entry of readdirSync(file(root,path),{withFileTypes:true}))if(entry.isDirectory())prune(root,path+'/'+entry.name);
  try{retryWindowsFileOperation(()=>rmdirSync(file(root,path)),{validate:()=>file(root,path)});}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code))throw error;}
}
export function uninstallUserTools(options={}) {
  recoverUserInstallation(options);
  const prepared=planUserUninstall(options),result=applyInstallationGroup(prepared.plans,{primary:prepared.root,
    removeRuntimeIgnores:[...prepared.receipt.profiles,{root:prepared.root,runtimeIgnoreOwned:prepared.receipt.runtimeIgnoreOwned}].filter(scope=>scope.runtimeIgnoreOwned).map(scope=>scope.root)});
  for(const scope of [...prepared.receipt.profiles,{root:prepared.root,directories:prepared.receipt.directories}]) {
    prune(scope.root,'.0-code');
    for(const directory of [...scope.directories].reverse())prune(scope.root,directory);
  }
  return {...prepared,result};
}
export function doctorUserTools(options={}) {
  try {
    const root=userInstallationLocation(options),receipt=readInstallationReceipt(root);
    if(!receipt)throw new Error('Machine toolset is absent; run install-tools');
    const {scopes}=scopesFor(receipt.config,resolveUserProfiles(options));validatePrevious(root,receipt,scopes);
    const checks=inspectMcpPrerequisites(root,receipt.delivery,{env:options.env??process.env});
    return {ok:receipt.delivery.ready&&checks.every(check=>check.ok),root,delivery:receipt.delivery,checks,
      ...(checks.some(check=>!check.ok)?{reason:checks.filter(check=>!check.ok).map(check=>check.reason).join('; ')}:{})};
  } catch(error){return {ok:false,reason:error.message};}
}
export function recoverUserInstallation({config,source=FRAMEWORK_SOURCE,...options}={}) {
  const root=userInstallationLocation(options),receipt=readInstallationReceipt(root),settings=settingsFor(config??receipt?.config);
  const profiles=resolveUserProfiles(options),{scopes,get}=scopesFor(settings,profiles);
  if(fileSnapshot(root,GROUP_JOURNAL).bytes===null&&[...scopes.values()].every(scope=>fileSnapshot(scope.root,GROUP_JOURNAL).bytes===null))return {recovered:false};
  const allow=(root,path)=>get(root).targets.set(path,{});
  const catalog=JSON.parse(readFileSync(join(source,'toolset/catalog.json'),'utf8'));
  for(const entry of catalog.elements.filter(entry=>entry.status!=='removed'&&entry.kind!=='mcp'))for(const engine of settings.engines) {
    const name='0-code-'+entry.name.replaceAll('/','-');
    if(entry.kind==='rules'){allow(profiles[engine].root,engine==='claude'?'rules/'+name+'.md':'AGENTS.md');continue;}
    try{allow(profiles[engine].root,compileUserTool({engine,kind:entry.kind,name,source:file(root,'.0-code/'+entry.source)}).path);}catch{}
  }
  if(settings.engines.includes('codex'))allow(profiles.codex.root,'config.toml');
  if(settings.engines.includes('opencode'))for(const path of ['opencode.json','opencode.jsonc'])allow(profiles.opencode.root,path);
  if(settings.engines.includes('claude'))allow(profiles.claude.mcp.root,profiles.claude.mcp.path);
  const capabilities=[{root,allowedPaths:[{path:'.0-code',recursive:true}]},...[...scopes.values()].map(scope=>({root:scope.root,
    allowedPaths:[...[...scope.targets.keys()].map(path=>({path,recursive:false})),{path:'.0-code/run/backups',recursive:true}]}))];
  return recoverInstallationGroup(root,capabilities);
}
