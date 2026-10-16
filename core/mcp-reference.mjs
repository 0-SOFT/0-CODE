// Native MCP descriptors contain source references. Private values are read only at launch.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveProjectPath } from './project-config.mjs';
import { readNativeJson } from '../lib/native-json.mjs';
import { parseToml } from '../lib/toml-mini.mjs';
import { resolveMcpInput, resolvePublicMcpValue } from './backends/mcp-input.mjs';
import { runCli } from './backends/spawn-cli.mjs';
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const controls=['disabled_tools','enabled_tools','tools','permission','oauth','scopes','required','experimental_environment','http_headers_helper','headersHelper'];
const fields=new Set(['type','command','args','env','environment','env_vars','cwd','url','headers','http_headers','env_http_headers','bearer_token_env_var',
  'enabled','disabled','timeout','startup_timeout_sec','startup_timeout_ms','tool_timeout_sec']);
const manifestFields=new Set(['name','description','note','secrets','portable','source','needs_setup','npm_package','repo','version','setup','linux_setup']);
function text(bytes) {const value=bytes.toString('utf8');if(!Buffer.from(value).equals(bytes)||value.includes('\0'))throw new Error('MCP source is not ordinary UTF-8 text');return value;}
export function readMcpReference(root,reference,{read=path=>readFileSync(resolveProjectPath(root,path,{allowFramework:true}))}={}) {
  if(!record(reference)||!['mcp-json','mcp-toml','manifest'].includes(reference.format)||typeof reference.name!=='string')throw new Error('Invalid MCP reference');
  let definition,engine=reference.engine;
  const source=text(read(reference.path));
  try {
    if(reference.format==='mcp-toml') {definition=parseToml(source).mcp_servers?.[reference.name];engine='codex';}
    else if(reference.format==='manifest') definition=JSON.parse(source).servers?.find(entry=>entry.name===reference.name);
    else definition=readNativeJson(Buffer.from(source))[engine==='opencode'?'mcp':'mcpServers']?.[reference.name];
  } catch {throw new Error('MCP source format cannot be read safely');}
  if(!record(definition))throw new Error('MCP definition is absent');
  if(controls.some(key=>Object.hasOwn(definition,key))||definition.enabled===false||definition.disabled===true)
    throw new Error('MCP execution controls or account setup cannot be transferred safely');
  if(Object.keys(definition).some(key=>!fields.has(key)&&!(reference.format==='manifest'&&manifestFields.has(key))))
    throw new Error('MCP has unsupported native settings');
  if(reference.format==='manifest'&&(definition.portable===false||definition.needs_setup||definition.source==='claude_ai'))
    throw new Error('MCP requires native account or executable setup');
  let command=definition.command,args=definition.args??[],environment=definition.env??{};
  let type=definition.type??(definition.url?'http':'stdio'),headers=definition.headers??{};
  if(engine==='opencode') {
    if(type==='local'){if(!Array.isArray(command)||!command.length)throw new Error('MCP local command is not an argument array');[command,...args]=command;}
    environment=definition.environment??{};type=type==='local'?'stdio':type==='remote'?'http':type;
  }
  if(type==='streamable-http')type='http';
  if(!['stdio','http'].includes(type))throw new Error('MCP transport is not supported by the reference launcher');
  if(type==='http'&&(typeof definition.url!=='string'||!definition.url.trim()))throw new Error('MCP endpoint is not text');
  if(definition.cwd!==undefined&&(typeof definition.cwd!=='string'||definition.cwd.includes('\0')))throw new Error('MCP working directory cannot be represented');
  const inherited=definition.env_vars??[];
  if(!Array.isArray(inherited)||inherited.some(name=>typeof name!=='string'||!/^[A-Za-z_]\w*$/.test(name)))
    throw new Error('MCP environment whitelist cannot be transferred');
  if(engine==='codex') {
    headers={...definition.http_headers,...headers};
    for(const [key,name] of Object.entries(definition.env_http_headers??{})) {
      if(typeof name!=='string'||!/^[A-Za-z_]\w*$/.test(name))throw new Error('Invalid MCP header reference');
      headers[key]='${'+name+'}';
    }
    if(definition.bearer_token_env_var!==undefined) {
      if(typeof definition.bearer_token_env_var!=='string'||!/^[A-Za-z_]\w*$/.test(definition.bearer_token_env_var))throw new Error('Invalid MCP bearer reference');
      if(Object.keys(headers).some(key=>key.toLowerCase()==='authorization'))throw new Error('Competing MCP authentication definitions');
      headers.Authorization='Bearer ${'+definition.bearer_token_env_var+'}';
    }
  }
  if(typeof command!=='string'&&type==='stdio'||!Array.isArray(args)||args.some(value=>typeof value!=='string')||!record(environment)||!record(headers)
    ||[...Object.values(environment),...Object.values(headers)].some(value=>typeof value!=='string'))throw new Error('Invalid MCP command, environment or headers');
  const convert=value=>engine==='opencode'?value.replace(/\{env:([A-Za-z_]\w*)\}/g,(_,name)=>'${'+name+'}'):value;
  if([command,...args,...Object.values(environment),definition.cwd,definition.url,...Object.values(headers)].some(value=>typeof value==='string'&&value.includes('{file:')))
    throw new Error('MCP file interpolation needs its native account setup');
  const dropped=Object.keys(definition).filter(key=>['timeout','startup_timeout_sec','startup_timeout_ms','tool_timeout_sec'].includes(key));
  return {server:{name:'managed',type,...(type==='stdio'?{command:convert(command),args:args.map(convert),env:Object.fromEntries(Object.entries(environment).map(([key,value])=>[key,convert(value)]))}
    :{url:typeof definition.url==='string'?convert(definition.url):definition.url,headers:Object.fromEntries(Object.entries(headers).map(([key,value])=>[key,convert(value)]))}),
    ...(reference.format==='manifest'?{secrets:definition.secrets??[],source:definition.source,portable:definition.portable}: {})},
    cwd:typeof definition.cwd==='string'?convert(definition.cwd):undefined,inherited,dropped,npm_package:definition.npm_package};
}
export function resolveMcpReference(root,reference,{env=process.env,read,cwd=root}={}) {
  const parsed=readMcpReference(root,reference,{read});
  const runtimeEnv={...env};
  if(parsed.npm_package&&!runtimeEnv.NPM_GLOBAL_ROOT) {
    const response=runCli('npm',['root','-g'],{env:runtimeEnv,encoding:'utf8',timeoutMs:10000});
    if(response.status!==0||!response.stdout.trim())throw new Error('MCP package location is unavailable');
    runtimeEnv.NPM_GLOBAL_ROOT=response.stdout.trim();
  }
  const input=resolveMcpInput(parsed.server,runtimeEnv);
  // Codex forwards only its declared whitelist and literals; other sources inherit native process env.
  const childEnv=reference.engine==='codex'?Object.fromEntries(parsed.inherited.filter(name=>runtimeEnv[name]!==undefined).map(name=>[name,runtimeEnv[name]])):runtimeEnv;
  // PATH/SystemRoot are transport infrastructure, rather than a copy of every credential in the host.
  if(reference.engine==='codex') for(const key of Object.keys(runtimeEnv)) if(/^(?:path|pathext|systemroot|windir|tmp|temp|tmpdir|home|userprofile)$/i.test(key)) childEnv[key]=runtimeEnv[key];
  Object.assign(childEnv,input.env??{});
  return {...input,cwd:typeof parsed.cwd==='string'?resolve(cwd,resolvePublicMcpValue(parsed.cwd,runtimeEnv,parsed.server.secrets??[])):cwd,environment:childEnv};
}
