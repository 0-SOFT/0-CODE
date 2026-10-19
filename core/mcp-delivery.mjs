import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { readMcpReference } from './mcp-reference.mjs';
import { hashBytes } from './installation-transaction.mjs';
import { addNativeJsonEntries } from '../lib/native-json.mjs';
import { codexMcpToml } from './backends/codex-mcp.mjs';
import { isIsolatedClaude } from './project-write-policy.mjs';
export function publicHttpEntry(engine,server) {
  // The selected manifest is secret-free. Native HTTP retains OAuth and GET/SSE support.
  if(engine==='claude')return {type:'http',url:server.url,...(Object.keys(server.headers||{}).length?{headers:server.headers}:{})};
  if(engine==='opencode')return {type:'remote',url:server.url.replace(/\$\{([A-Za-z_]\w*)\}/g,'{env:$1}'),
    ...(Object.keys(server.headers||{}).length?{headers:Object.fromEntries(Object.entries(server.headers).map(([key,value])=>[key,value.replace(/\$\{([A-Za-z_]\w*)\}/g,'{env:$1}')]))}:{}),enabled:true};
  const entry={url:server.url};
  if(entry.url.includes('${'))throw new Error('Codex HTTP endpoint interpolation requires native setup');
  for(const [key,value] of Object.entries(server.headers||{})) {
    const bearer=key.toLowerCase()==='authorization'&&/^Bearer \$\{([A-Za-z_]\w*)\}$/.exec(value),variable=/^\$\{([A-Za-z_]\w*)\}$/.exec(value);
    if(bearer)entry.bearer_token_env_var=bearer[1];
    else if(variable)(entry.env_http_headers??={})[key]=variable[1];
    else if(value.includes('${'))throw new Error('Codex HTTP header interpolation requires native setup');
    else(entry.http_headers??={})[key]=value;
  }
  return entry;
}
export function planMcpDelivery(root,config,bundle,{original,targets}) {
  // fnm's multishell launcher disappears with its shell; registrations need the stable binary.
  const node=realpathSync(process.execPath);
  const rows=[],additions={claude:{},codex:{},opencode:{}};
  const read=path=>path.startsWith('.0-code/')?bundle.files.get(path.slice(8)):original(path);
  const project=(config.inventory.tools||[]).filter(tool=>tool.kind==='mcp');
  const stock=config.toolset.scope==='project'?bundle.selection.selected.filter(tool=>tool.kind==='mcp'):[];
  for(const tool of [...project,...stock]) {
    const origin=tool.kind==='mcp'&&tool.path?'project':'framework',name=origin==='project'?tool.name:'0-code-'+tool.name;
    const reference=origin==='project'?{format:tool.format,engine:tool.engine,path:tool.path,name:tool.name}
      :{format:'manifest',path:'.0-code/'+tool.source,name:tool.name};
    let parsed;
    try{parsed=readMcpReference(root,reference,{read});}catch{} // Never put a parent configuration value into a report.
    for(const engine of config.engines) {
      const row={id:tool.id,kind:'mcp',name,engine,origin,source:reference.path};
      if(origin==='project'&&tool.native.includes(engine)){rows.push({...row,status:'native',compatible:Boolean(parsed)});continue;}
      if(engine==='claude'&&isIsolatedClaude(config)) {
        rows.push({...row,status:'unsupported',reason:'Session context cannot register MCP servers; explicit launcher integration is required'});continue;
      }
      if(project.some(entry=>entry.name===name&&entry.native.includes(engine))){rows.push({...row,status:'overridden'});continue;}
      if(!parsed||!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)||['__proto__','constructor','prototype'].includes(name)){
        rows.push({...row,status:'unsupported',reason:'MCP source needs native transport, execution controls or account setup'});continue;
      }
      if(origin==='project'&&project.filter(entry=>entry.name===name).length>1){
        rows.push({...row,status:'unsupported',reason:'Competing project MCP definitions require a decision'});continue;
      }
      if(Object.hasOwn(additions[engine],name))throw new Error('MCP native definitions collide');
      if(origin==='framework'&&parsed.server.type==='http') {
        try {additions[engine][name]=publicHttpEntry(engine,parsed.server);}
        catch {rows.push({...row,status:'unsupported',reason:'HTTP interpolation needs native account setup'});continue;}
        rows.push({...row,status:'delivered',files:[],dropped_fields:parsed.dropped,transport:'http',native_transport:true});continue;
      }
      const specPath='.0-code/mcp/'+hashBytes(Buffer.from(tool.id)).slice(0,24)+'.json';
      targets.set(specPath,{bytes:Buffer.from(JSON.stringify({schema_version:1,reference},null,2)+'\n')});
      const args=[resolve(root,'.0-code/tools/mcp-reference-run.mjs'),resolve(root,specPath)];
      const inherited=new Set(parsed.inherited);
      function variables(value) {
        if(typeof value==='string')for(const match of value.matchAll(/\$\{([A-Za-z_]\w*)(?::-([^}]*))?\}/g))inherited.add(match[1]);
        else if(value&&typeof value==='object')for(const entry of Object.values(value))variables(entry);
      }
      variables(parsed.server);for(const variable of parsed.server.secrets??[])inherited.add(variable);
      additions[engine][name]=engine==='opencode'?{type:'local',command:[node,...args],enabled:true}
        :engine==='codex'?{command:node,args,env_vars:[...inherited].sort()}
        :{type:'stdio',command:node,args};
      rows.push({...row,status:'delivered',files:[specPath],dropped_fields:parsed.dropped,transport:parsed.server.type});
    }
  }
  for(const [engine,entries] of Object.entries(additions)) {
    if(!Object.keys(entries).length)continue;
    if(engine==='codex') {
      const path='.codex/config.toml',before=targets.get(path)?.bytes??original(path),text=before?.toString('utf8')??'';
      if(/^\s*mcp_servers\s*=/m.test(text))throw new Error('Inline Codex MCP tables require an integration decision');
      const suffix=(text?'\n':'')+'# BEGIN 0-CODE MCP\n'+Object.entries(entries).map(([name,value])=>'[mcp_servers.'+JSON.stringify(name)+']\n'+Object.entries(value).map(([key,entry])=>key+' = '+codexMcpToml(entry)).join('\n')).join('\n\n')+'\n# END 0-CODE MCP\n';
      const base=original(path);
      const bytes=Buffer.concat([before??Buffer.alloc(0),Buffer.from(suffix)]);
      targets.set(path,{bytes,patch:{type:'suffix',text:bytes.subarray(base?.length??0).toString('utf8')}});
      for(const row of rows.filter(row=>row.engine===engine&&row.status==='delivered'))row.files.push(path);
    } else {
      const path=engine==='claude'?'.mcp.json':original('opencode.jsonc')!==null?'opencode.jsonc':'opencode.json';
      const before=targets.get(path)?.bytes??original(path),container=engine==='claude'?'mcpServers':'mcp';
      targets.set(path,addNativeJsonEntries(before,container,entries));
      for(const row of rows.filter(row=>row.engine===engine&&row.status==='delivered'))row.files.push(path);
    }
  }
  return rows;
}
