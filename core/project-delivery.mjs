import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { compileNativeTool, toolHeader } from './native-tools.mjs';
import { resolveProjectPath } from './project-config.mjs';
import { fileSnapshot, hashBytes } from './installation-transaction.mjs';
import { parseJsonc } from '../lib/jsonc.mjs';
import { parseToml } from '../lib/toml-mini.mjs';
import { planMcpDelivery } from './mcp-delivery.mjs';
import { isIsolatedClaude } from './project-write-policy.mjs';
const START='# BEGIN 0-CODE TOOLS';
const END='# END 0-CODE TOOLS';
const TEXT_FIELDS=new Set(['name','description','argument-hint','paths','origin','license','compatibility','metadata']);
export function renderSessionContext(delivery) {
  const references=delivery.tools.filter(row=>row.engine==='claude'&&row.status==='reference'&&row.load_via==='session-context');
  if(!references.length)return '';
  return '\n## Procedures available in this Claude session\n\nRead the exact source before following a procedure requested by the user or active cycle prompt:\n'
    +references.map(row=>`- ${row.name} (${row.kind}): ${JSON.stringify(row.source)}${row.original_source?`; resolve relative resources from the directory of the original source ${JSON.stringify(row.original_source)}`:''}`).join('\n')
    +'\n\nThese are instruction references loaded through SessionStart and SubagentStart. They do not register native slash commands, isolated agents, execution controls or MCP servers. Use command source $ARGUMENTS as the current request arguments. Project instructions and the active cycle prompt take precedence.\n';
}
export function verifySessionContext(root,config,delivery,guide) {
  const rows=(delivery?.tools||[]).filter(row=>row.engine==='claude');
  const core=rows.find(row=>row.id==='core/orchestrator');
  if(core?.status!=='reference'||core.load_via!=='session-context')throw new Error('Claude session context is missing the orchestrator reference');
  const audits=rows.filter(row=>row.origin==='module'&&row.id.startsWith('audits/'));
  if(config.modules.audits?(audits.length!==2||audits.some(row=>row.status!=='reference'||row.load_via!=='session-context')):audits.length)
    throw new Error('Claude session audit references do not match the enabled module');
  for(const row of rows.filter(row=>row.load_via==='session-context')) {
    if(row.status!=='reference'||row.kind==='mcp'||!row.source?.startsWith('.0-code/'))throw new Error('Invalid Claude session instruction reference');
    const bytes=readFileSync(resolveProjectPath(root,row.source,{allowFramework:true})),text=bytes.toString('utf8');
    if(!text.trim()||!Buffer.from(text).equals(bytes)||text.includes('\0'))throw new Error('Claude session procedure source must be nonempty UTF-8 text');
  }
  if(!guide.includes(renderSessionContext(delivery)))throw new Error('Claude session procedure catalog is missing from AGENT.md');
}
function appendRegistrations(original,registrations) {
  const text=original?.toString('utf8')||'';
  if(text.includes(START)||text.includes(END)) throw new Error('Existing native tool markers require an owned upgrade');
  // Inline agents tables cannot safely be extended by appending a second table.
  if(/^\s*agents\s*=/m.test(text)) throw new Error('Inline project agents require a native integration decision');
  const lines=registrations.map(entry=>`[agents.${JSON.stringify(entry.name)}]\ndescription = ${JSON.stringify(entry.description)}\nconfig_file = ${JSON.stringify(entry.file)}\n`).join('\n');
  return {bytes:Buffer.concat([original||Buffer.alloc(0),Buffer.from((text?'\n':'')+START+'\n'+lines+END+'\n')]),
    patch:{type:'suffix',text:(text?'\n':'')+START+'\n'+lines+END+'\n'}};
}
function projectFields(root,tool) {
  const file=resolveProjectPath(root,tool.path),bytes=readFileSync(file);
  if(tool.format==='opencode-json') {
    const json=parseJsonc(bytes.toString('utf8'));
    const definition=json[tool.kind==='agents'?'agent':'command']?.[tool.name];
    if(!definition||typeof definition!=='object') throw new Error('Project native definition is absent');
    const key=tool.kind==='agents'?'prompt':'template';
    if(typeof definition[key]!=='string') throw new Error('Project instruction field is not text');
    const { [key]:instructions, ...metadata }=definition;
    return {fields:{...metadata,description:definition.description||`Project ${tool.kind}: ${tool.name}`},
      source:tool.path,instructions};
  }
  if(tool.format==='codex-agent') {
    const fields=parseToml(bytes.toString('utf8')),keys=Object.keys(fields);
    if(keys.some(key=>!['developer_instructions','description','model','model_reasoning_effort'].includes(key))) throw new Error('Codex role has unrepresentable settings');
    const instructions=fields.developer_instructions;
    if(typeof instructions!=='string'||!instructions.trim()) throw new Error('Codex role has no instruction text');
    return {fields:{...Object.fromEntries(keys.filter(key=>key!=='developer_instructions').map(key=>[key,null])),
      description:typeof fields.description==='string'?fields.description:'Project agent '+tool.name},source:tool.path,instructions};
  }
  if(tool.format==='codex-agent-registration') {
    const registration=parseToml(bytes.toString('utf8')).agents?.[tool.name];
    if(!registration||typeof registration.config_file!=='string'
      ||Object.keys(registration).some(key=>!['description','config_file','nickname_candidates'].includes(key))) throw new Error('Codex role registration is not compatible');
    const rolePath=relative(root,resolve(dirname(file),registration.config_file)).replaceAll('\\','/');
    resolveProjectPath(root,rolePath);
    const role=projectFields(root,{...tool,path:rolePath,format:'codex-agent'});
    role.fields={...role.fields,...(typeof registration.description==='string'?{description:registration.description}:{}),
      ...(registration.nickname_candidates!==undefined?{nickname_candidates:null}:{})};
    return role;
  }
  const parsed=toolHeader(bytes);return {fields:parsed.fields,source:tool.path,referenceBytes:bytes};
}
export function planProjectDelivery(root,config,bundle,{original=path=>fileSnapshot(root,path).bytes}={}) {
  const targets=new Map(),rows=[],registrations=[];
  const put=(path,value)=>{
    const before=targets.get(path);
    if(before&&hashBytes(before.bytes)!==hashBytes(value.bytes)) throw new Error(`Native tool definitions collide: ${path}`);
    targets.set(path,value);
  };
  function emit({id,kind,name,source,selector,fields,origin,native=[],codexFile,referenceBytes}) {
    for(const engine of config.engines) {
      const row={id,engine,origin,source,kind,name};
      if(native.includes(engine)) {rows.push({...row,status:'native'});continue;}
      if(engine==='codex'&&kind==='agents'&&codexFile) {
        registrations.push({name,description:fields.description,file:relative(resolve(root,'.codex'),resolve(root,codexFile)).replaceAll('\\','/')});
        rows.push({...row,status:'delivered',files:['.codex/config.toml'],dropped_fields:[]});continue;
      }
      const definitions=(config.inventory.tools||[]).filter(tool=>tool.kind===kind&&tool.name===name);
      if(origin!=='core'&&definitions.some(tool=>tool.native.includes(engine))) {rows.push({...row,status:'overridden'});continue;}
      if(origin==='project'&&definitions.length>1) {rows.push({...row,status:'unsupported',reason:'Competing project definitions require an integration decision'});continue;}
      if(engine==='claude'&&isIsolatedClaude(config)) {
        const controls=Object.keys(fields).filter(key=>!TEXT_FIELDS.has(key)).sort();
        if(controls.length) {rows.push({...row,status:'unsupported',reason:'Session context cannot preserve native execution controls: '+controls.join(', ')});continue;}
        const path=source.startsWith('.0-code/')?source:`.0-code/project-tools/${hashBytes(Buffer.from(id)).slice(0,16)}.md`;
        if(path!==source)put(path,{bytes:referenceBytes??readFileSync(resolveProjectPath(root,source))});
        rows.push({...row,source:path,...(path!==source?{original_source:source}:{}),status:'reference',load_via:'session-context'});continue;
      }
      if(kind==='rules') {
        if(engine==='claude') {const path=`.claude/rules/${name}.md`;put(path,{bytes:Buffer.from(`Read ${JSON.stringify(source)}. The owner's project rules and active cycle prompt take precedence.\n`)});rows.push({...row,status:'delivered',files:[path]});}
        else rows.push({...row,status:'reference'});continue;
      }
      let compiled;
      try {
        compiled=compileNativeTool({engine,kind,name,source,selector,fields});
      } catch(error) {rows.push({...row,status:'unsupported',reason:origin==='project'?'Project tool format/name or execution controls cannot be adapted safely':error.message});continue;}
      put(compiled.path,{bytes:compiled.bytes});
      if(compiled.registration&&!registrations.some(entry=>entry.name===compiled.registration.name)) registrations.push(compiled.registration);
      rows.push({...row,status:'delivered',files:[compiled.path],dropped_fields:compiled.dropped});
    }
  }
  emit({id:'core/orchestrator',kind:'skills',name:'0-code-orchestrator',source:'.0-code/skills/orchestrator-wrapper/SKILL.md',
    fields:{description:'Read the configured 0-CODE state and roadmap, execute this cycle stage, and update state atomically.'},origin:'core'});
  if(config.modules.audits) for(const name of ['productionaudit','productionauditloop']) emit({id:`audits/${name}`,kind:'commands',name:`0-code-${name}`,
    source:`.0-code/commands/${name}.md`,fields:{description:`Run the ${name} workflow under the active cycle prompt.`},origin:'module'});
  for(const entry of bundle.selection.selected) {
    if(config.toolset.scope==='user') { for(const engine of config.engines) rows.push({id:entry.id,kind:entry.kind,engine,origin:'framework',status:'pending-user'});continue; }
    if(entry.kind==='mcp') continue;
    const fields=entry.kind==='rules'&&!isIsolatedClaude(config)?{}:toolHeader(bundle.files.get(entry.source)).fields;
    emit({id:entry.id,kind:entry.kind,name:`0-code-${entry.name.replaceAll('/','-')}`,source:'.0-code/'+entry.source,fields,origin:'framework'});
  }
  for(const tool of config.inventory.tools||[]) {
    if(!['skills','agents','commands','rules','mcp'].includes(tool.kind)) continue;
    if(tool.kind==='mcp') continue;
    if(tool.kind==='rules') {
      for(const engine of config.engines) {
        const row={id:tool.id,kind:tool.kind,name:tool.name,engine,origin:'project',source:tool.path};
        if(tool.native.includes(engine)) {rows.push({...row,status:'native'});continue;}
        if(!tool.compatible.includes(engine)) {rows.push({...row,status:'unsupported',reason:'Native execution policy cannot be translated into instruction prose'});continue;}
        if(engine!=='claude'||!isIsolatedClaude(config)) {rows.push({...row,status:'reference'});continue;}
        try {
          const bytes=readFileSync(resolveProjectPath(root,tool.path)),fields=toolHeader(bytes).fields;
          const controls=Object.keys(fields).filter(key=>!TEXT_FIELDS.has(key)).sort();
          if(controls.length)throw new Error('Session context cannot preserve native execution controls');
          const path=`.0-code/project-tools/${hashBytes(Buffer.from(tool.id)).slice(0,16)}.md`;
          put(path,{bytes});rows.push({...row,source:path,original_source:tool.path,status:'reference',load_via:'session-context'});
        } catch {rows.push({...row,status:'unsupported',reason:'Project rule text or execution controls cannot be delivered through session context'});}
      }
      continue;
    }
    let definition;
    try {definition=projectFields(root,tool);}
    catch {for(const engine of config.engines) rows.push({id:tool.id,kind:tool.kind,engine,origin:'project',source:tool.path,
      status:tool.native.includes(engine)?'native':'unsupported',reason:'Project tool metadata cannot be read safely'});continue;}
    if(definition.instructions!==undefined) {
      const path=`.0-code/project-tools/${hashBytes(Buffer.from(tool.id)).slice(0,16)}.md`;
      put(path,{bytes:Buffer.from(definition.instructions)});definition.source=path;
    }
    emit({id:tool.id,kind:tool.kind,name:tool.name.replaceAll('/','-'),...definition,origin:'project',native:tool.native,
      ...(tool.format==='codex-agent'?{codexFile:tool.path}:{})});
  }
  if(registrations.length) put('.codex/config.toml',appendRegistrations(original('.codex/config.toml'),registrations));
  rows.push(...planMcpDelivery(root,config,bundle,{original,targets}));
  const overridden=bundle.selection.overridden.map(entry=>({...entry,status:'overridden'}));
  const delivery={schema_version:1,scope:config.toolset.scope,ready:rows.every(row=>!['unsupported','pending-user'].includes(row.status)),tools:rows,overridden};
  put('.0-code/delivery.json',{bytes:Buffer.from(JSON.stringify(delivery,null,2)+'\n')});
  const references=[...new Set(rows.filter(row=>row.status==='reference'&&row.origin==='project'&&row.load_via!=='session-context').map(row=>row.source))];
  return {targets,delivery,references,sessionContext:renderSessionContext(delivery)};
}
