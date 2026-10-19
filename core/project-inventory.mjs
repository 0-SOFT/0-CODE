// Deterministic, read-only inventory. Never execute project code or retain configuration secrets.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { DOCUMENT_DEFAULTS, loadProjectConfig, normalizeProjectConfig, resolveProjectPath } from './project-config.mjs';
import { parseYaml } from '../lib/yaml-mini.mjs';
import { parseJsonc } from '../lib/jsonc.mjs';
import { parseToml } from '../lib/toml-mini.mjs';

const ignored = new Set(['.git', '.0-code', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', 'dist', 'build', 'coverage']);
const engines = { '.claude': 'claude', '.codex': 'codex', '.opencode': 'opencode', '.agents': 'shared' };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const order = (a,b) => a.localeCompare(b,'en');

function readText(file, warnings, location) {
  try { return readFileSync(file, 'utf8'); }
  catch { warnings.push({ path: location, reason: 'File could not be read' }); return null; }
}
function readJson(file, warnings, location) {
  const text = readText(file,warnings,location);
  if (text === null) return null;
  try {
    const value=location.endsWith('.jsonc') ? parseJsonc(text) : JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { warnings.push({ path: location, reason: 'Configuration is not a JSON object' }); return null; }
}

// Read table identifiers without parsing or exposing TOML values.
function tomlParts(header) {
  const parts=[];
  const expression=/\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(?:\.|$)/g;
  let last=0;
  for(const match of header.matchAll(expression)) {
    if(match.index !== last) return [];
    const value=match[1];
    try { parts.push(value.startsWith('"') ? JSON.parse(value) : value.replace(/^'|'$/g,'')); }
    catch { return []; }
    last=match.index+match[0].length;
  }
  return last === header.length ? parts : [];
}

function detectLanguage(samples) {
  const text=samples.map(sample=>sample.text.replace(/```[\s\S]*?```/g,'')).join('\n');
  const counts={ru:(text.match(/\p{Script=Cyrillic}/gu)||[]).length,
    en:(text.match(/\p{Script=Latin}/gu)||[]).length,zh:(text.match(/\p{Script=Han}/gu)||[]).length,
    ja:(text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)||[]).length,
    ko:(text.match(/\p{Script=Hangul}/gu)||[]).length,ar:(text.match(/\p{Script=Arabic}/gu)||[]).length};
  let language=Object.keys(counts).sort((a,b)=>counts[b]-counts[a]||order(a,b))[0];
  if(!Object.values(counts).some(Boolean)) language='en';
  if(language === 'zh' && counts.ja) language='ja';
  if(language === 'ru' && /[\u0456\u0457\u0454\u0491]/i.test(text)) language='uk';
  // Latin-script languages are reported as English unless their distinctive words dominate.
  if(language === 'en') {
    const words=text.toLowerCase().match(/\p{Script=Latin}+/gu)||[];
    const markers={en:['the','and','with','project','this','from','for'],
      es:['el','los','para','proyecto','este','desde','con'],
      fr:['le','les','pour','projet','cette','avec','des'],
      de:['der','die','das','und','mit','projekt','für'],
      pt:['para','projeto','com','dos','uma','este','não']};
    const scores=Object.fromEntries(Object.entries(markers).map(([key,values])=>[key,words.filter(word=>values.includes(word)).length]));
    const highest=Math.max(...Object.values(scores));
    const best=Object.keys(scores).filter(key=>scores[key]===highest);
    if(highest && best.length===1) language=best[0];
  }
  return { language, counts, sources:samples.map(sample=>sample.path),
    basis: 'Dominant writing system in project prose; distinctive stop words for Latin languages. Ambiguous or missing prose defaults to English.' };
}

export function scanProject(projectDir = process.cwd(), { allowMissing = false } = {}) {
  projectDir=resolve(projectDir);
  const present=existsSync(projectDir);
  if((!present&&!allowMissing) || (present&&!lstatSync(projectDir).isDirectory())) throw new Error('Project directory does not exist');
  const warnings=[],files=[];
  const listed=spawnSync('git',['-C',projectDir,'-c','core.fsmonitor=false','-c','core.untrackedCache=false',
    'ls-files','--cached','--others','--exclude-standard','-z'],
    {encoding:'utf8',maxBuffer:32*1024*1024,windowsHide:true});
  const selected=listed.status===0?new Set(listed.stdout.split('\0').filter(Boolean)):null;
  const selectedDirectories=new Set();
  for(const path of selected||[]) {
    const parts=path.split('/');
    for(let i=1;i<parts.length;i++) selectedDirectories.add(parts.slice(0,i).join('/'));
  }
  const metadataDirectories=new Set(['skills','agents','commands','rules','hooks','prompts','plugins']);
  const metadataFiles=new Set(['.claude/settings.json','.claude/settings.local.json','.codex/config.toml',
    '.mcp.json','opencode.json','opencode.jsonc','CLAUDE.md','AGENTS.md']);
  function isMetadata(path) {
    const parts=path.split('/');
    return metadataFiles.has(path) || (Object.hasOwn(engines,parts[0]) && (parts.length===1 || metadataDirectories.has(parts[1])));
  }
  function visit(directory) {
    for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>order(a.name,b.name))) {
      const file=join(directory,entry.name),path=relative(projectDir,file).replaceAll('\\','/');
      if(selected && !selected.has(path) && !selectedDirectories.has(path) && !isMetadata(path)) continue;
      const stat=lstatSync(file);
      if(stat.isSymbolicLink()) { warnings.push({path,reason:'Symbolic link was not followed'}); continue; }
      if(stat.isDirectory()) { if(!ignored.has(entry.name)) visit(file); }
      else if(stat.isFile()) files.push({file,path});
    }
  }
  if(present) visit(projectDir);
  const tools=[],checks=[],documents=[],mcpNames=new Set(),detected=new Set(),prose=[];
  const addTool=tool=>tools.push({id:`${tool.kind}:${tool.path}:${tool.name}`, ...tool});
  const addCheck=(path,name,argv)=>checks.push({id:`${path}:${name}`,path,name,argv,cwd:dirname(path).replaceAll('\\','/')});
  for(const {file,path} of files) {
    const parts=path.split('/'),surface=parts[0],engine=Object.hasOwn(engines,surface)?engines[surface]:undefined,name=basename(path);
    if(engine) {
      if(engine!=='shared') detected.add(engine);
      const kind=parts[1];
      if(['skills','agents','commands','rules','prompts'].includes(kind)) {
        if(kind==='skills' ? name==='SKILL.md' : /\.(md|toml|rules)$/i.test(name)) {
          const toolName=kind==='skills' ? parts.slice(2,-1).join('/') : parts.slice(2).join('/').replace(/\.(md|toml|rules)$/i,'');
          let compatible=['claude','codex','opencode'],native=[];
          if(kind==='skills') native=surface==='.claude' ? ['claude','opencode'] : surface==='.agents' ? ['codex','opencode'] : [engine];
          else if(kind==='agents') native=surface==='.claude' ? ['claude'] : surface==='.codex' ? ['codex'] : surface==='.opencode' ? ['opencode'] : [];
          else if(kind==='commands') native=surface==='.claude' ? ['claude'] : surface==='.opencode' ? ['opencode'] : [];
          else if(kind==='rules') {
            native=surface==='.claude' ? ['claude'] : name.endsWith('.rules') && surface==='.codex' ? ['codex'] : [];
            if(name.endsWith('.rules')) compatible=['codex'];
          }
          else { compatible=['codex']; native=[]; }
          addTool({kind:kind==='prompts'?'commands':kind,name:toolName,engine,path,native,compatible,
            format:kind==='skills'?'agent-skill':name.endsWith('.toml')?'codex-agent':name.endsWith('.rules')?'codex-policy':'markdown',
            sha256:sha256(readFileSync(file))});
        }
      } else if(['hooks','plugins'].includes(kind) && parts.length>2) addTool({kind:'hooks',name:parts.slice(2).join('/'),engine,path,native:[engine],compatible:[engine],
        format:kind==='plugins'?'plugin-file':'hook-file',sha256:sha256(readFileSync(file)),guardLike:/safety[-_ ]?guard|arbiter/i.test(name)});
    }
    if(path==='CLAUDE.md' || path==='AGENTS.md') {
      addTool({kind:'instructions',name,engine:path==='CLAUDE.md'?'claude':'shared',path,
        native:path==='CLAUDE.md'?['claude','opencode']:['codex','opencode'],compatible:['claude','codex','opencode'],format:'markdown',sha256:sha256(readFileSync(file))});
    }
    if(path==='.claude/settings.json' || path==='.claude/settings.local.json') {
      const json=readJson(file,warnings,path);
      for(const [event,groups] of Object.entries(json?.hooks||{}).sort(([a],[b])=>order(a,b))) {
        if(!Array.isArray(groups)) { warnings.push({path,reason:'Hook groups are not an array'}); continue; }
        for(const [index,group] of groups.entries()) for(const [hookIndex,hook] of (Array.isArray(group?.hooks)?group.hooks:[]).entries()) {
          addTool({kind:'hooks',name:`${event}[${index}][${hookIndex}]`,engine:'claude',path,
            event,native:['claude'],compatible:['claude'],format:hook.type==='command'?'command-hook':'model-hook',
            sha256:sha256(JSON.stringify(hook)),guardLike:event==='PreToolUse' && /safety[-_ ]?guard|arbiter|guard-only|permissionDecision/i.test(hook.command||'')});
        }
      }
    }
    if(path==='.mcp.json' || path==='opencode.json' || path==='opencode.jsonc') {
      const isOpen=path.startsWith('opencode');
      if(isOpen) detected.add('opencode');
      const json=readJson(file,warnings,path);
      const servers=isOpen?json?.mcp:json?.mcpServers;
      for(const [serverName,server] of Object.entries(servers||{}).sort(([a],[b])=>order(a,b))) {
        const serverEngine=isOpen?'opencode':'claude';
        const key=`${path}:${serverName}`;
        if(mcpNames.has(key)) continue;
        mcpNames.add(key);
        addTool({kind:'mcp',name:serverName,engine:serverEngine,path,native:[serverEngine],compatible:['claude','codex','opencode'],
          format:'mcp-json',transport:server?.url?'http':server?.type==='remote'?'http':'stdio',
          environmentNames:Object.keys(server?.env||server?.environment||{}).sort(order),
          portable:server?.type!=='oauth' });
      }
      if(isOpen) {
        for(const [kind,key] of [['agents','agent'],['commands','command']]) for(const toolName of Object.keys(json?.[key]||{}).sort(order))
          addTool({kind,name:toolName,engine:'opencode',path,native:['opencode'],compatible:['claude','codex','opencode'],format:'opencode-json'});
        for(const [index] of (Array.isArray(json?.plugin)?json.plugin:[]).entries()) addTool({kind:'hooks',name:`plugin[${index}]`,engine:'opencode',path,native:['opencode'],compatible:['opencode'],format:'plugin-reference'});
      }
    }
    if(path==='.codex/config.toml') {
      const text=readText(file,warnings,path)||'';
      try {
        const native=parseToml(text);
        for(const serverName of Object.keys(native.mcp_servers||{}).sort(order)) {
          const key=path+':'+serverName;if(mcpNames.has(key))continue;mcpNames.add(key);
          addTool({kind:'mcp',name:serverName,engine:'codex',path,native:['codex'],compatible:['claude','codex','opencode'],format:'mcp-toml'});
        }
      } catch { /* Table headers still provide a value-free inventory of unsupported TOML. */ }
      for(const line of text.split(/\r?\n/)) {
        const header=line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)?.[1];
        if(!header) continue;
        const keys=tomlParts(header.trim());
        if(keys[0]==='mcp_servers' && keys.length>=2) {
          const key=`${path}:${keys[1]}`; if(mcpNames.has(key)) continue; mcpNames.add(key);
          addTool({kind:'mcp',name:keys[1],engine:'codex',path,native:['codex'],compatible:['claude','codex','opencode'],format:'mcp-toml'});
        }
        if(keys[0]==='agents' && keys.length===2) addTool({kind:'agents',name:keys[1],engine:'codex',path,native:['codex'],compatible:['claude','codex','opencode'],format:'codex-agent-registration'});
      }
    }
    if(name==='package.json') {
      const json=readJson(file,warnings,path);
      const command=existsSync(join(dirname(file),'pnpm-lock.yaml'))?'pnpm':existsSync(join(dirname(file),'yarn.lock'))?'yarn':existsSync(join(dirname(file),'bun.lock'))?'bun':'npm';
      for(const script of Object.keys(json?.scripts||{}).sort(order)) addCheck(path,script,[command,'run',script]);
    }
    if(name==='Makefile' || name==='makefile' || name==='GNUmakefile') {
      const text=readText(file,warnings,path)||'';
      for(const match of text.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?![=:])/gm)) addCheck(path,match[1],['make',match[1]]);
    }
    if(name==='go.mod') addCheck(path,'test',['go','test','./...']);
    if(name==='Cargo.toml') { addCheck(path,'test',['cargo','test']); addCheck(path,'check',['cargo','check']); }
    if(name==='pyproject.toml') {
      const text=readText(file,warnings,path)||'';
      const runner=existsSync(join(dirname(file),'uv.lock'))?['uv','run']:['python','-m'];
      if(/\bpytest\b/.test(text)) addCheck(path,'test',[...runner,'pytest']);
      if(/\bruff\b/.test(text)) addCheck(path,'lint',[...runner,'ruff','check','.']);
      let section='';
      for(const line of text.split(/\r?\n/)) {
        const header=line.match(/^\s*\[([^\]]+)\]/)?.[1];
        if(header) { section=header; continue; }
        if(section==='tool.poe.tasks') {
          const task=line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1];
          if(task) addCheck(path,task,['poetry','run','poe',task]);
        }
      }
    }
    const isDoc=/\.md$/i.test(name) && (parts.length===1 || /^(?:docs?|documentation|adr)\//i.test(path));
    if(isDoc) {
      let role=/^CHANGELOG/i.test(name)?'roadmap':/\bSTATE\b/i.test(name)?'state':/(?:^|\/)adr(?:\/|\.)|decisions?\//i.test(path)?'decisions':/ROADMAP/i.test(name)?'roadmap':'documentation';
      documents.push({path,role});
      if((/^README/i.test(name) || /^(?:docs?|documentation)\//i.test(path)) && prose.length<32) {
        const text=readText(file,warnings,path); if(text!==null) prose.push({path,text:text.slice(0,16384)});
      }
    }
  }
  if(!prose.length) for(const name of ['CLAUDE.md','AGENTS.md']) {
    const file=join(projectDir,name);if(existsSync(file)) { const text=readText(file,warnings,name); if(text!==null) prose.push({path:name,text:text.slice(0,16384)}); }
  }
  // Codex role files need a registration. Its configured alias can differ from the filename.
  const registrations=tools.filter(tool=>tool.format==='codex-agent-registration');
  let codexAgents;
  if(registrations.length) {
    try {codexAgents=parseToml(readFileSync(resolveProjectPath(projectDir,'.codex/config.toml'),'utf8')).agents;}
    catch {warnings.push({path:'.codex/config.toml',reason:'Native role references use unsupported TOML syntax'});}
  }
  const rolePaths=new Set();
  for(const tool of registrations) {
    const configFile=codexAgents?.[tool.name]?.config_file;
    if(typeof configFile!=='string') continue;
    try {
      const path=relative(projectDir,resolve(projectDir,'.codex',configFile)).replaceAll('\\','/');
      resolveProjectPath(projectDir,path);
      tool.role_path=path;rolePaths.add(path);
    } catch {warnings.push({path:tool.path,reason:'Role file is outside the project or is linked'});}
  }
  for(let i=tools.length-1;i>=0;i--) if(tools[i].format==='codex-agent') {
    if(rolePaths.has(tools[i].path)) tools.splice(i,1); // The registration is the single effective definition.
    else tools[i].native=[]; // Still adaptable, but not advertised as natively discovered by Codex.
  }
  const legacyEvidence=['core/supervisor.mjs','lib/update-state.mjs','hooks/ralph-loop-stop'].filter(path=>files.some(file=>file.path===path));
  const legacy={detected:legacyEvidence.length===3,evidence:legacyEvidence};
  const project=loadProjectConfig({projectDir});
  if(legacy.detected && existsSync(project.documentPath('state'))) {
    const text=readText(project.documentPath('state'),warnings,project.documentRelative('state'))||'';
    try { const header=text.match(/^---\r?\n([\s\S]*?)\r?\n---/); const state=header?parseYaml(header[1]):{};
      if(typeof state.framework_version==='string') legacy.frameworkVersion=state.framework_version;
    } catch { warnings.push({path:project.documentRelative('state'),reason:'Legacy state frontmatter could not be read'}); }
  }
  const language=detectLanguage(prose);
  tools.sort((a,b)=>order(a.id,b.id));checks.sort((a,b)=>order(a.id,b.id));documents.sort((a,b)=>order(a.path,b.path));warnings.sort((a,b)=>order(a.path,b.path)||order(a.reason,b.reason));
  const inventory={schema_version:1,tools,checks,documents,language,legacy,warnings,
    scope:selected?'git-files-and-engine-metadata':'filesystem-with-build-artifacts-excluded',
    installation:{detected:project.installed,...(project.installed?{framework_version:project.config.framework_version}:{})}};
  const suggestedDocuments=project.installed||legacy.detected?project.config.documents:DOCUMENT_DEFAULTS;
  const suggestedConfig=normalizeProjectConfig({...project.config,documents:suggestedDocuments,engines:project.providedKeys.includes('engines')?project.config.engines:detected.size?[...detected].sort(order):['claude'],
    language:project.providedKeys.includes('language')?project.config.language:language.language,inventory});
  const conflicts=tools.filter(tool=>tool.kind==='hooks' && (tool.event==='Stop' || tool.guardLike)).map(tool=>({path:tool.path,name:tool.name,reason:'Existing loop driver or guard requires an explicit integration decision'}));
  return {projectDir,inventory,suggestedConfig,conflicts};
}

export function inventorySummary(result) {
  const inventory=result.inventory;
  const kinds=['skills','agents','commands','rules','hooks','mcp','instructions'];
  const counts=kinds.map(kind=>kind+': '+inventory.tools.filter(tool=>tool.kind===kind).length).join(', ');
  return 'Inventory: '+counts+'.\nCheck commands: '+inventory.checks.length+'; language: '+inventory.language.language+'; legacy installation: '+(inventory.legacy.detected?'yes':'no')+'.\n'+
    'Conflicts: '+result.conflicts.length+'; warnings: '+inventory.warnings.length+'.\n';
}
