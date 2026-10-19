// Installation ownership is proved by receipt hashes; original project bytes stay in ignored run/.
import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { InstallationPlan, applyInstallationPlan, fileSnapshot, hashBytes, recoverInstallation } from './installation-transaction.mjs';
import { CONFIG_PATH, DOCUMENT_ZONE, internalLogDirectories, isDocumentZone, isClaudeInstructionPath, loadProjectConfig, normalizeProjectConfig, resolveProjectPath } from './project-config.mjs';
import { assembleInstallationBundle, FRAMEWORK_SOURCE } from './installation-bundle.mjs';
import { scanProject } from './project-inventory.mjs';
import { serializeYaml, parseYaml } from '../lib/yaml-mini.mjs';
import { STOP_HOOK_BLOCK_CAP } from './loop-limits.mjs';
import { planProjectDelivery } from './project-delivery.mjs';
import { PROJECT_PLUGIN_PATH, PROJECT_PLUGIN_ENTRY } from './backends/project-opencode-plugin.mjs';
import { addNativeJsonChanges, stripNativeJsonChanges, stripNativeJsonEntries } from '../lib/native-json.mjs';
import { retryWindowsFileOperation } from '../lib/replace-file.mjs';
import { planDocumentRelocation, addDocumentRelocation } from './document-relocation.mjs';
import { prepareProjectAdoption, validateRetainedFiles, addAdoptionBackups } from './project-adoption.mjs';
import { isDeepStrictEqual } from 'node:util';

export const RECEIPT_PATH='.0-code/installation.json';
export const INSTRUCTION_BEGIN='<!-- BEGIN 0-CODE -->';
export const INSTRUCTION_END='<!-- END 0-CODE -->';
const body=bytes=>bytes===null?'':bytes.toString('utf8');
const jsonBytes=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const resolveFile=(root,path)=>resolveProjectPath(root,path,{allowFramework:true});
export const claudeSettingsPath = config => config.instructions.claude_settings || '.claude/settings.json';
function requireNoClaudeOwnership(config,receipt,originalFiles=new Map()) {
  if(config.instructions.claude==='session-hook'&&(receipt?.files.some(entry=>isClaudeInstructionPath(entry.path))||[...originalFiles.keys()].some(isClaudeInstructionPath))) {
    throw new Error('session-hook never writes CLAUDE.md. First uninstall the previous owned instruction block using project-file mode, then install with the saved config and session-hook mode; cycle documents are preserved.');
  }
}
function readObject(root,path) {
  const bytes=fileSnapshot(root,path).bytes;
  if(bytes===null) return null;
  try {const value=JSON.parse(bytes.toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error();return value;}
  catch {throw new Error(`Invalid installation JSON: ${path}`);}
}
function treeFiles(root,directory) {
  const dir=resolveFile(root,directory);
  if(!existsSync(dir)) return [];
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    const path=`${directory}/${entry.name}`,stat=lstatSync(resolveFile(root,path));
    if(stat.isSymbolicLink()) throw new Error(`Installation tree contains a symlink: ${path}`);
    if(path.toLowerCase()===DOCUMENT_ZONE&&!stat.isDirectory()) throw new Error('Document zone must be a directory');
    return stat.isDirectory()?treeFiles(root,path):[path];
  }).sort((a,b)=>a.localeCompare(b,'en'));
}
export function readInstallationReceipt(root) {
  const receipt=readObject(root,RECEIPT_PATH);
  if(!receipt) return null;
  if(receipt.schema_version!==1||!Array.isArray(receipt.files)||!Array.isArray(receipt.directories)) throw new Error('Invalid installation receipt');
  const seen=new Set();
  for(const entry of receipt.files) {
    if(typeof entry.path!=='string'||seen.has(entry.path)||entry.path===RECEIPT_PATH||isDocumentZone(entry.path)) throw new Error('Invalid installation ownership entry: documents cannot be owned');
    resolveFile(root,entry.path);seen.add(entry.path);
    if(!/^[a-f0-9]{64}$/.test(entry.hash)) throw new Error('Invalid installation ownership hash');
    if(entry.textHashes!==undefined&&(!Array.isArray(entry.textHashes)||entry.textHashes.length>2||entry.textHashes.some(hash=>!/^[a-f0-9]{64}$/.test(hash))
      ||entry.path.startsWith('.0-code/')||entry.originalHash!==null))throw new Error('Invalid native text ownership hashes');
    if(entry.backup) {
      if(!entry.backup.startsWith('.0-code/run/backups/')) throw new Error('Invalid original-byte backup path');
      resolveFile(root,entry.backup);
    }
  }
  for(const directory of receipt.directories) {
    if(isDocumentZone(directory)) throw new Error('Invalid installation ownership directory: documents cannot be owned');
    resolveFile(root,directory);
  }
  validateRetainedFiles(receipt.retainedFiles || [], receipt.files);
  return receipt;
}

function appendInstructions(snapshot) {
  const text=body(snapshot.bytes);
  if(text.includes(INSTRUCTION_BEGIN)||text.includes(INSTRUCTION_END)||text.includes('<!-- BEGIN AUTONOMOUS FRAMEWORK -->')) throw new Error('Existing framework instructions require upgrade or migration');
  const suffix=(text?'\n\n':'')+`${INSTRUCTION_BEGIN}\nRead .0-code/AGENT.md and .0-code/config.json before cycle work. Project instructions take precedence.\n${INSTRUCTION_END}\n`;
  return {bytes:Buffer.concat([snapshot.bytes||Buffer.alloc(0),Buffer.from(suffix)]),patch:{type:'suffix',text:suffix}};
}
const command=name=>`\"\${CLAUDE_PROJECT_DIR}/.0-code/hooks/run-hook.cmd\" ${name}`;
export function claudeContextHooks() {
  return Object.fromEntries(['SessionStart','SubagentStart'].map(event=>[event,
    [{matcher:'',hooks:[{type:'command',command:command('project-context'),timeout:15}]}]]));
}
export function claudeRequiredHooks(config) {
  return {
    PreToolUse:[{matcher:'*',hooks:[{type:'command',command:command('safety-guard')}]}],
    Stop:[{matcher:'',hooks:[...(config.modules.session_logs?[{type:'command',command:command('save-session-log')}]:[]),{type:'command',command:command('ralph-loop-stop')}]}],
    ...(config.modules.session_logs?{SessionEnd:[{matcher:'',hooks:[{type:'command',command:command('save-session-log')}]}]}:{}),
  };
}
function claudeSettings(original,config,mcpNames=[]) {
  const current=original||{};
  if(typeof current!=='object'||Array.isArray(current)) throw new Error('Project Claude settings must be an object');
  if(current.hooks!==undefined&&(!current.hooks||typeof current.hooks!=='object'||Array.isArray(current.hooks))) throw new Error('Project hooks must be an object');
  const hooks=structuredClone(current.hooks||{});
  for(const groups of Object.values(hooks)) {
    if(!Array.isArray(groups)||groups.some(group=>!group||!Array.isArray(group.hooks))) throw new Error('Project hook definitions must contain arrays');
  }
  const sessionFile = claudeSettingsPath(config) === '.0-code/claude/settings.json';
  const expected = claudeRequiredHooks(config);
  const existing = new Set(sessionFile ? Object.keys(expected).filter(event => isDeepStrictEqual(hooks[event],expected[event])) : []);
  if((hooks.Stop||[]).length&&!existing.has('Stop')) throw new Error('Existing Stop hooks require an integration decision');
  for(const group of hooks.PreToolUse||[]) for(const hook of group.hooks||[]) {
    if(/safety[-_ ]?guard|arbiter|permissionDecision/i.test(hook.command||'')&&!existing.has('PreToolUse')) throw new Error('Existing PreToolUse guard requires an integration decision');
  }
  const guard={matcher:'*',hooks:[{type:'command',command:command('safety-guard')}]};
  if(!existing.has('PreToolUse')) hooks.PreToolUse=[...(hooks.PreToolUse||[]),guard];
  const stop=[...(config.modules.session_logs?[{type:'command',command:command('save-session-log')}]:[]),
    {type:'command',command:command('ralph-loop-stop')}];
  hooks.Stop=[{matcher:'',hooks:stop}];
  if(config.modules.session_logs&&!existing.has('SessionEnd')) hooks.SessionEnd=[...(hooks.SessionEnd||[]),{matcher:'',hooks:[{type:'command',command:command('save-session-log')}]}];
  if(config.instructions.claude==='session-hook') {
    if(current.disableAllHooks===true) throw new Error('session-hook instructions require Claude hooks to be enabled');
    for(const [event,groups] of Object.entries(claudeContextHooks())) hooks[event]=[...(hooks[event]||[]),...groups];
  }
  if((current.permissions?.ask||[]).length) throw new Error('Explicit ask permissions require an integration decision');
  const result={...current,hooks,env:{...current.env,CLAUDE_CODE_STOP_HOOK_BLOCK_CAP:current.env?.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP??String(STOP_HOOK_BLOCK_CAP)},
    permissions:{...current.permissions,defaultMode:current.permissions?.defaultMode||'bypassPermissions'}};
  if(mcpNames.length) {
    for(const key of ['enabledMcpjsonServers','disabledMcpjsonServers'])if(current[key]!==undefined
      &&(!Array.isArray(current[key])||current[key].some(name=>typeof name!=='string')))throw new Error('Native MCP approvals must be name arrays');
    const disabled=new Set(current.disabledMcpjsonServers||[]);
    result.enabledMcpjsonServers=[...new Set([...(current.enabledMcpjsonServers||[]),...mcpNames.filter(name=>!disabled.has(name))])];
  }
  if(config.modules.token_usage) {
    if(current.statusLine&&!(sessionFile&&isDeepStrictEqual(current.statusLine,{type:'command',command:command('usage-statusline')}))) throw new Error('Existing status line requires a chaining decision');
    result.statusLine={type:'command',command:command('usage-statusline')};
  }
  return result;
}
function stateBytes(name,version) {
  const state={schema_version:1,project_name:name,current_stage:0,current_version:'0.0.1',previous_version:null,
    current_prompt_index:0,current_prompt_file:null,last_action:'Installed 0-CODE; start an authorized cycle prompt.',
    blockers:[],open_findings:[],iteration:0,session_count:0,released_version:null,
    budget_metrics:{version_cost_usd:0,cap_usd:null},framework_version:version,running_jobs:[],next_step_prompt:null};
  return Buffer.from('---\n'+serializeYaml(state)+'\n---\n\n# Cycle state\n');
}
export function validateExistingState(bytes) {
  const header=body(bytes).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if(!header) throw new Error('Existing state-role file is not a machine state');
  const state=parseYaml(header[1]);
  if(state.schema_version!==1||!state.project_name||state.current_version===undefined||state.current_stage===undefined) throw new Error('Existing state-role file is not a machine state');
}
export function directoriesFor(root,paths,previous=[]) {
  const result=new Set(previous.filter(path=>!isDocumentZone(path)));
  for(const path of paths) {
    if(isDocumentZone(path)) continue;
    let dir=dirname(resolveFile(root,path));
    while(dir!==root) {
      if(!existsSync(dir)) result.add(relative(root,dir).replaceAll('\\','/'));
      dir=dirname(dir);
    }
  }
  return [...result].sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b,'en'));
}
export function stripOwnedPatch(snapshot,entry) {
  if(snapshot.bytes===null)throw new Error('Owned native configuration is missing');
  let bytes;
  if(entry.patch?.type==='native-json-delta') {
    bytes=stripNativeJsonChanges(snapshot.bytes,entry.patch);
  } else if(entry.patch?.type==='native-json') {
    bytes=stripNativeJsonEntries(snapshot.bytes,entry.patch);
  } else if(entry.patch?.type==='suffix') {
    const text=entry.patch.text.replace(/\r\n/g,'\n');
    const candidates=[text,text.replace(/\n/g,'\r\n')].map(text=>Buffer.from(text));
    const matches=candidates.flatMap(bytes=>{const found=[];let at=snapshot.bytes.indexOf(bytes);while(at>=0){found.push({bytes,at});at=snapshot.bytes.indexOf(bytes,at+bytes.length);}return found;});
    if(matches.length!==1)throw new Error('Owned native block changed; original preserved');
    const {bytes:suffix,at}=matches[0];
    bytes=Buffer.concat([snapshot.bytes.subarray(0,at),snapshot.bytes.subarray(at+suffix.length)]);
    if(entry.originalHash===null&&bytes.length===0)bytes=null;
  } else throw new Error('Installed file changed outside upgrade: '+entry.path);
  if(entry.originalHash===null&&entry.patch.type.startsWith('native-json')&&/^\s*\{\s*\}\s*$/.test(bytes.toString('utf8')))bytes=null;
  return {bytes,hash:hashBytes(bytes),mode:bytes===null?null:snapshot.mode};
}
export function originalSnapshot(root,path,previous) {
    const entry=previous?.files.find(entry=>entry.path===path);
    if(!entry) return fileSnapshot(root,path);
    const current=fileSnapshot(root,path);
    if(current.hash!==entry.hash&&entry.patch)return stripOwnedPatch(current,entry);
    if(entry.originalHash===null) return {bytes:null,hash:null,mode:null};
    const bytes=fileSnapshot(root,entry.backup).bytes;
    if(bytes===null&&entry.patch) {
      const recovered=stripOwnedPatch(current,entry);
      return {...recovered,mode:entry.originalMode};
    }
    if(hashBytes(bytes)!==entry.originalHash) throw new Error(`Original installation bytes are unavailable: ${path}`);
    return {bytes,hash:entry.originalHash,mode:entry.originalMode};
}
function externalTargets(root,config,previous,mcpNames=[],original=path=>originalSnapshot(root,path,previous)) {
  const targets=new Map();
  if(config.engines.includes('claude')&&config.instructions.claude==='project-file') targets.set('CLAUDE.md',appendInstructions(original('CLAUDE.md')));
  if(config.engines.some(engine=>['codex','opencode'].includes(engine))) targets.set('AGENTS.md',appendInstructions(original('AGENTS.md')));
  if(config.engines.includes('claude')) {
    const settingsPath=claudeSettingsPath(config),snapshot=original(settingsPath);
    let value=null;try {value=snapshot.bytes===null?null:JSON.parse(body(snapshot.bytes));if(snapshot.bytes!==null&&(!value||typeof value!=='object'||Array.isArray(value))) throw new Error();} catch {throw new Error('Invalid project Claude settings');}
    const before=value||{},after=claudeSettings(value,config,mcpNames),values=[],arrays=[];
    for(const [parent,name] of [['env','CLAUDE_CODE_STOP_HOOK_BLOCK_CAP'],['permissions','defaultMode']])
      if(!Object.hasOwn(before[parent]||{},name))values.push({path:[parent,name],value:after[parent][name]});
    if(config.modules.token_usage) {
      if(!Object.hasOwn(before,'statusLine'))values.push({path:['statusLine'],value:after.statusLine});
    }
    for(const event of ['PreToolUse','Stop','SessionEnd','SessionStart','SubagentStart']) {
      const added=(after.hooks[event]||[]).slice((before.hooks?.[event]||[]).length);
      if(added.length)arrays.push({path:['hooks',event],values:added});
    }
    const addedMcp=(after.enabledMcpjsonServers||[]).filter(name=>!(before.enabledMcpjsonServers||[]).includes(name));
    if(addedMcp.length)arrays.push({path:['enabledMcpjsonServers'],values:addedMcp});
    targets.set(settingsPath,addNativeJsonChanges(snapshot.bytes,{values,arrays}));
  }
  if(config.engines.includes('opencode')) targets.set(PROJECT_PLUGIN_PATH,{bytes:Buffer.from(PROJECT_PLUGIN_ENTRY)});
  return targets;
}
export function requireOwnership(root,receipt) {
  if([...receipt.files.map(entry=>entry.path),...receipt.directories].some(isDocumentZone)) throw new Error('Invalid installation ownership: documents cannot be owned');
  for(const entry of receipt.files) {
    if(entry.path===CONFIG_PATH) continue; // The project owns this mutable preference file.
    const current=fileSnapshot(root,entry.path);
    if(current.hash!==entry.hash) {
      if(entry.patch&&(!entry.path.startsWith('.0-code/')||entry.path==='.0-code/claude/settings.json'))stripOwnedPatch(current,entry);
      else if(entry.path.startsWith('.0-code/')||!entry.textHashes?.includes(current.hash))throw new Error(`Installed file changed outside upgrade: ${entry.path}`);
    }
  }
  validateRetainedFiles(receipt.retainedFiles || [],receipt.files);
  const owned=new Set([...receipt.files.map(entry=>entry.path),...(receipt.retainedFiles||[]),RECEIPT_PATH]);
  for(const path of treeFiles(root,'.0-code')) if(!/^\.0-code\/run\//i.test(path)&&!isDocumentZone(path)&&!owned.has(path)) throw new Error(`Unowned file inside installation: ${path}`);
}

export function planProjectInstallation(root,{config,source=FRAMEWORK_SOURCE,upgrade=false,originalFiles=new Map(),inventory,documentManifest,documentConfig,adoptionManifest}={}) {
  root=resolve(root);
  if(root===resolve(source)) throw new Error('Install into a target project, not the framework source directory');
  const installedReceipt=readInstallationReceipt(root);
  if(adoptionManifest&&installedReceipt)throw new Error('Adoption requires an installation without a receipt');
  if(adoptionManifest&&documentManifest)throw new Error('Adoption and document relocation require separate plans');
  const adoption=adoptionManifest?prepareProjectAdoption(root,adoptionManifest,normalizeProjectConfig(config)):null;
  const receipt=installedReceipt??adoption?.receipt;
  if(receipt&&originalFiles.size)throw new Error('Legacy original bytes apply only to a fresh migration');
  if(upgrade&&!receipt) throw new Error('No owned installation to upgrade');
  if(receipt&&!upgrade) return planProjectInstallation(root,{config,source,upgrade:true,documentManifest});
  if(documentManifest!==undefined && !receipt && !documentConfig) throw new Error('Document relocation requires an existing installation; use migrate');
  if(receipt) requireOwnership(root,receipt);
  else if(existsSync(join(root,'.0-code'))) {
    const foreign=treeFiles(root,'.0-code').filter(path=>path!==CONFIG_PATH&&!path.startsWith('.0-code/run/')&&!isDocumentZone(path));
    if(foreign.length) throw new Error('Existing .0-code files have no installation ownership receipt');
  }
  const existing=receipt?loadProjectConfig({projectDir:root}).config:null;
  const scan=receipt?null:scanProject(root,{allowMissing:true});
  const proposed=config!==undefined?config:existing??scan.suggestedConfig;
  const normalized=normalizeProjectConfig(proposed,{documentDefaults:existing?.documents});
  const relocation=documentManifest!==undefined ? planDocumentRelocation(root,existing??documentConfig,normalized,documentManifest) : null;
  const settings=relocation?.config??normalized;
  requireNoClaudeOwnership(settings,receipt,originalFiles);
  settings.inventory=inventory??(receipt?(config?.inventory??existing.inventory):scan.inventory);
  const original=path=>originalFiles.has(path)?{bytes:originalFiles.get(path),hash:hashBytes(originalFiles.get(path)),mode:originalFiles.get(path)===null?null:fileSnapshot(root,path).mode}:originalSnapshot(root,path,receipt);
  if(receipt) {
    const created=new Set(receipt.files.filter(entry=>entry.originalHash===null).map(entry=>entry.path));
    const registered=new Set((receipt.delivery?.tools||[]).filter(tool=>tool.engine==='codex'&&tool.kind==='agents'&&tool.status==='delivered')
      .flatMap(tool=>tool.name?[tool.name]:(tool.files||[]).filter(path=>path.startsWith('.codex/agents/')).map(path=>basename(path,'.toml'))));
    const mcpAliases=new Set((receipt.delivery?.tools||[]).filter(tool=>tool.kind==='mcp'&&tool.status==='delivered').map(tool=>tool.engine+':'+tool.name));
    const originals=(settings.inventory.tools||[]).filter(tool=>tool.format==='codex-agent-registration'&&registered.has(tool.name)
      &&tool.role_path&&!created.has(tool.role_path)).flatMap(tool=>{
        const prior=(existing.inventory.tools||[]).find(entry=>entry.format==='codex-agent'&&entry.path===tool.role_path);
        return prior?[{...prior,native:[],sha256:fileSnapshot(root,prior.path).hash}]:[];
      });
    settings.inventory={...settings.inventory,tools:(settings.inventory.tools||[]).filter(tool=>!created.has(tool.path)
      && !(tool.format==='codex-agent-registration'&&registered.has(tool.name))
      && !(tool.kind==='mcp'&&mcpAliases.has(tool.engine+':'+tool.name)))};
    for(const tool of originals) if(!settings.inventory.tools.some(entry=>entry.id===tool.id)) settings.inventory.tools.push(tool);
    settings.inventory.tools.sort((a,b)=>a.id.localeCompare(b.id,'en'));
  }
  if(relocation && settings.inventory.documents) {
    const movedPaths=new Map(relocation.moves.map(entry=>[entry.from,entry.to]));
    settings.inventory={...settings.inventory,documents:settings.inventory.documents.map(entry=>
      ({...entry,path:movedPaths.get(entry.path)??entry.path}))};
  }
  const bundle=assembleInstallationBundle(settings,{source});
  settings.framework_version=bundle.version;
  const project=loadProjectConfig({projectDir:root,config:settings});
  const native=planProjectDelivery(root,settings,bundle,{original:path=>original(path).bytes});
  if(settings.instructions.project_rules?.length) {
    for(const path of settings.instructions.project_rules) if(fileSnapshot(root,path).bytes===null)throw new Error('Configured project rules are missing: '+path);
    bundle.files.set('AGENT.md',Buffer.concat([bundle.files.get('AGENT.md'),Buffer.from('\n## Retained project rules\n\nRead these project-owned files; this generated guide defines current framework behavior:\n'+settings.instructions.project_rules.map(path=>'- '+JSON.stringify(path)).join('\n')+'\n')]));
  }
  if(native.references.length) bundle.files.set('AGENT.md',Buffer.concat([bundle.files.get('AGENT.md'),
    Buffer.from('\n## Project rules\n\nRead the applicable project rules first:\n'+native.references.map(path=>'- '+JSON.stringify(path)).join('\n')+'\n')]));
  const targets=new Map([...bundle.files].map(([path,bytes])=>['.0-code/'+path,{bytes,
    mode:/^hooks\/(?:run-hook\.cmd|ralph-loop-stop|safety-guard|save-session-log|usage-statusline|project-context)$/.test(path)?0o755:0o644}]));
  targets.set(CONFIG_PATH,{bytes:jsonBytes(settings)});
  const approvedMcp=native.delivery.tools.filter(tool=>tool.kind==='mcp'&&tool.engine==='claude'
    &&(tool.status==='delivered'||tool.status==='native'&&tool.compatible)).map(tool=>tool.name);
  for(const [path,target] of externalTargets(root,settings,receipt,approvedMcp,original)) targets.set(path,target);
  for(const [path,target] of native.targets) targets.set(path,target);
  if(settings.engines.includes('codex')) {
    const budget=project.engineSettings('codex').instructionsMaxBytes;
    if(budget!==undefined&&targets.get('AGENTS.md').bytes.length>budget) throw new Error('Codex project instructions exceed the configured limit');
  }
  const plan=new InstallationPlan(root),entries=[];
  for(const [path,target] of targets) {
    if(isDocumentZone(path)) throw new Error('Framework delivery cannot own project documents');
    const previous=receipt?.files.find(entry=>entry.path===path),snapshot=fileSnapshot(root,path);
    const inside=path.startsWith('.0-code/');
    const overwrite=Boolean(previous)||path===CONFIG_PATH||path===claudeSettingsPath(settings)||target.patch?.type==='native-json'||(!inside&&(path==='CLAUDE.md'||path==='AGENTS.md'||path==='.claude/settings.json'||path==='.codex/config.toml'));
    plan.change(path,target.bytes,{overwrite,expectedHash:previous&&path!==CONFIG_PATH?snapshot.hash:undefined,
      ...(target.mode!==undefined?{mode:target.mode,preserveMode:false}:{})});
    const before=target.patch||!inside&&(previous?.patch||originalFiles.has(path))?original(path):null;
    let entry={path,hash:hashBytes(target.bytes),originalHash:before?before.hash:previous?previous.originalHash:(inside?null:snapshot.hash),
      originalMode:before?before.mode:previous?previous.originalMode:snapshot.mode};
    if(target.patch) entry.patch=target.patch;
    if(!inside&&!target.patch&&entry.originalHash===null) {
      const text=target.bytes.toString('utf8');
      if(Buffer.from(text).equals(target.bytes))entry.textHashes=[...new Set([hashBytes(Buffer.from(text.replace(/\r\n/g,'\n'))),hashBytes(Buffer.from(text.replace(/\r?\n/g,'\r\n')))])];
    }
    if(entry.originalHash!==null) {
      entry.backup=previous?.backup||`.0-code/run/backups/${hashBytes(Buffer.from(path))}.bin`;
      const bytes=before?before.bytes:snapshot.bytes;
      const backup=fileSnapshot(root,entry.backup);
      if(!previous||entry.originalHash!==previous.originalHash||backup.bytes===null)plan.change(entry.backup,bytes,{overwrite:Boolean(previous?.backup),expectedHash:previous?.backup?backup.hash:undefined,mode:0o600,preserveMode:false});
    }
    entries.push(entry);
  }
  // Disabled modules lose only their owned files. Previously existing project files are restored.
  for(const old of receipt?.files||[]) if(!targets.has(old.path)) {
    const original=originalSnapshot(root,old.path,receipt);
    plan.change(old.path,original.bytes,{overwrite:true,expectedHash:fileSnapshot(root,old.path).hash});
  }
  // A legacy block still needs proven removal when its engine is no longer selected.
  for(const [path,bytes] of originalFiles) if(!targets.has(path)) {
    plan.change(path,bytes,{overwrite:true,expectedHash:fileSnapshot(root,path).hash});
  }
  for(const role of ['state','roadmap']) {
    const path=project.documentRelative(role),snapshot=fileSnapshot(root,path);
    if(relocation?.moves.some(move=>move.to===path)) continue;
    if(snapshot.bytes!==null) { if(role==='state') validateExistingState(snapshot.bytes);continue; }
    plan.change(path,role==='state'?stateBytes(basename(root),bundle.version):Buffer.from('# Project roadmap\n\nRecord the authorized cycle plan and acceptance evidence here.\n'));
  }
  // These are project files, deliberately absent from the receipt and preserved on uninstall.
  // Keep existing owner ignore policies byte-for-byte; only seed missing log protections.
  if(existsSync(resolveFile(root,DOCUMENT_ZONE))||Object.values(settings.documents).some(document=>isDocumentZone(document.path))) {
    for(const directory of internalLogDirectories(settings)) {
      const path=directory+'/.gitignore';
      if(fileSnapshot(root,path).bytes===null&&!relocation?.moves.some(move=>move.to===path)) plan.change(path,Buffer.from('*\n'));
    }
  }
  const retainedFiles=(receipt?.retainedFiles||[]).filter(path=>!targets.has(path));
  validateRetainedFiles(retainedFiles,entries);
  const nextReceipt={schema_version:1,framework_version:bundle.version,delivery:native.delivery,files:entries,
    ...(retainedFiles.length?{retainedFiles}:{}),
    directories:directoriesFor(root,[...targets.keys()],receipt?.directories),...(receipt?.migration?{migration:receipt.migration}:{})};
  plan.change(RECEIPT_PATH,jsonBytes(nextReceipt),{overwrite:Boolean(receipt)});
  let adoptionBackups;
  if(adoption) {
    adoptionBackups=addAdoptionBackups(plan,adoption);
    plan.preflight=adoption.preflight;plan.enterGuard=adoption.enterGuard;plan.cycleLockPaths=adoption.cycleLockPaths;
  }
  const documentMigration=relocation?addDocumentRelocation(plan,relocation):null;
  if(settings.instructions.claude==='session-hook'&&plan.changes.some(entry=>isClaudeInstructionPath(entry.path))) throw new Error('session-hook cannot change CLAUDE.md');
  plan.assertReady();
  return {root,config:settings,plan,receipt:nextReceipt,bundle,...(adoption?{adoption:{backups:adoptionBackups,retainedFiles}}:{}),...(documentMigration?{documentMigration}:{})};
}

export function installProject(root,options={}) {
  recoverInstallation(root);
  const prepared=planProjectInstallation(root,options);
  return {...prepared,result:applyInstallationPlan(prepared.plan)};
}
export function upgradeProject(root,options={}) {
  if(!readInstallationReceipt(root)) throw new Error('No owned installation to upgrade');
  return installProject(root,{...options,upgrade:true});
}
export function planProjectUninstall(root) {
  root=resolve(root);const receipt=readInstallationReceipt(root);
  if(!receipt) throw new Error('No owned installation to remove');
  requireNoClaudeOwnership(loadProjectConfig({projectDir:root}).config,receipt);
  requireOwnership(root,receipt);
  const plan=new InstallationPlan(root);
  for(const entry of [...receipt.files].reverse()) {
    const original=originalSnapshot(root,entry.path,receipt);
    plan.change(entry.path,original.bytes,{overwrite:true,expectedHash:entry.path===CONFIG_PATH?undefined:fileSnapshot(root,entry.path).hash});
  }
  for(const path of treeFiles(root,'.0-code/run')) {
    if(path==='.0-code/run/.gitignore') continue;
    if(path.endsWith('/.loop.lock')) throw new Error('Verify the active cycle lock before uninstalling');
    plan.change(path,null,{overwrite:true});
  }
  plan.change(RECEIPT_PATH,null,{overwrite:true});
  plan.assertReady();return {root,plan,receipt};
}
export function uninstallProject(root) {
  recoverInstallation(root);
  const prepared=planProjectUninstall(root),result=applyInstallationPlan(prepared.plan,{removeRuntimeIgnore:true});
  function removeEmptyDirectory(path) {
    try {retryWindowsFileOperation(()=>rmdirSync(resolveFile(prepared.root,path)),{validate:()=>resolveFile(prepared.root,path)});}
    catch(error) {if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code)) throw error;}
  }
  function prune(path) {
    if(isDocumentZone(path)) return;
    const directory=resolveFile(prepared.root,path);if(!existsSync(directory)) return;
    for(const entry of readdirSync(directory,{withFileTypes:true})) if(entry.isDirectory()) prune(`${path}/${entry.name}`);
    removeEmptyDirectory(path);
  }
  prune('.0-code');
  for(const path of [...prepared.receipt.directories].reverse()) removeEmptyDirectory(path);
  return {...prepared,result};
}
