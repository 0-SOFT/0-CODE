// Native descriptors contain references to the owned source, rather than another instruction copy.
import { parseYaml } from '../lib/yaml-mini.mjs';
import { codexMcpToml } from './backends/codex-mcp.mjs';
import { projectRelativePath } from './project-config.mjs';
export function toolHeader(bytes) {
  const text=bytes.toString('utf8');
  if(!Buffer.from(text).equals(bytes)||text.includes('\0')) throw new Error('Tool definition is not valid UTF-8 text');
  const match=text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if(!match) return {fields:{},body:text};
  // The STATE parser deliberately has no block scalars; descriptor fields accept their folded form.
  const lines=match[1].split(/\r?\n/),scalars=[];
  for(let i=0;i<lines.length;i++) {
    const block=lines[i].match(/^([\w.-]+):\s*([>|])[-+]?\s*$/);
    const plain=lines[i].match(/^description:\s+([^"'\[{>|].*)$/);
    if(plain&&i+1<lines.length&&/^\s+\S/.test(lines[i+1])) {
      const value=[plain[1]];while(i+1<lines.length&&/^\s+\S/.test(lines[i+1]))value.push(lines[++i].trim());
      scalars.push('description: '+JSON.stringify(value.join(' ')));continue;
    }
    if(!block) {scalars.push(lines[i]);continue;}
    const value=[];while(i+1<lines.length&&(/^\s/.test(lines[i+1])||!lines[i+1])) value.push(lines[++i].trim());
    scalars.push(`${block[1]}: ${JSON.stringify(value.join(block[2]==='>'?' ':'\n').trim())}`);
  }
  return {fields:parseYaml(scalars.join('\n')),body:text.slice(match[0].length)};
}
export function compileNativeTool({engine,kind,name,source,selector,fields={}}) {
  if(!['claude','codex','opencode'].includes(engine)||!['skills','agents','commands'].includes(kind)) throw new Error('Unsupported native tool kind');
  if(kind==='agents') {if(typeof name!=='string'||name.length>256||projectRelativePath(name).includes('/')||name.startsWith('.')) throw new Error('Agent name cannot be represented by a native file');}
  else if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('Tool name cannot be represented by a native skill name');
  if(fields.hooks||fields.permission||fields.permissionMode||fields.disallowedTools||fields.mcpServers
    ||fields.disable===true||fields['disable-model-invocation']) throw new Error('Execution controls cannot be dropped by this adapter');
  const description=typeof fields.description==='string'&&fields.description.trim()?fields.description.trim():`Use ${name} for the current project task.`;
  const dropped=Object.keys(fields).filter(key=>!['name','description'].includes(key)).sort();
  const body=`Read ${JSON.stringify(source)} before using this tool.${selector?` Use the ${JSON.stringify(selector)} field as its instruction body.`:''} Follow its instruction body; native metadata is defined here. The owner's project rules, active cycle prompt, document roles and engine settings take precedence. This tool does not introduce a loop driver or mandatory extra stages. Treat $ARGUMENTS in a command source as the current invocation arguments.\n`;
  if(kind==='agents'&&engine==='codex') {
    return {path:`.codex/agents/${name}.toml`,bytes:Buffer.from(`developer_instructions = ${codexMcpToml(body)}\n`),dropped,description,registration:{name,description,file:`agents/${name}.toml`}};
  }
  const nativeKind=kind==='commands'&&engine==='codex'?'skills':kind;
  const nativeName=kind==='commands'&&engine==='codex'?`command-${name}`:name;
  if(nativeName.length>64) throw new Error('Adapted command name exceeds the native limit');
  const directory=engine==='claude'?'.claude':nativeKind==='skills'?'.agents':'.opencode';
  const path=nativeKind==='skills'?`${directory}/skills/${nativeName}/SKILL.md`:`${directory}/${nativeKind}/${nativeName}.md`;
  const header={...(nativeKind==='skills'||nativeKind==='agents'&&engine==='claude'?{name:nativeName}:{}),description,
    ...(nativeKind==='agents'&&engine==='opencode'?{mode:'subagent'}:{})};
  const yaml=Object.entries(header).map(([key,value])=>`${key}: ${JSON.stringify(value)}`).join('\n');
  return {path,bytes:Buffer.from(`---\n${yaml}\n---\n\n${body}`),dropped,description};
}
