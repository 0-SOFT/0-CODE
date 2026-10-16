import {readFileSync,writeFileSync,renameSync,unlinkSync,lstatSync,existsSync,realpathSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {isOwnerTelegramMcp} from '../lib/cloud-mcp-policy.mjs';

function ordinary(file,missing=true){
 try{const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw Error('Cloud MCP requires an ordinary configuration file: '+file);return stat;}
 catch(error){if(error.code==='ENOENT'&&missing)return null;throw error;}
}
function projectRoot(cwd){
 let directory=realpathSync.native(cwd);
 while(true){if(existsSync(join(directory,'.git')))return directory;const parent=dirname(directory);if(parent===directory)return realpathSync.native(cwd);directory=parent;}
}
export function claudeMcpFiles({env=process.env,cwd=process.cwd(),home=homedir()}={}){
 const user=env.CLAUDE_CONFIG_DIR?join(resolve(env.CLAUDE_CONFIG_DIR),'.claude.json'):join(home,'.claude.json');
 return [{file:user,scope:'user/local'},{file:join(projectRoot(cwd),'.mcp.json'),scope:'project'}];
}
function readConfig(file){
 const stat=ordinary(file);if(!stat)return null;
 let config;try{config=JSON.parse(readFileSync(file,'utf8'));}catch{throw Error('Cloud MCP cannot verify malformed configuration: '+file);}
 if(!config||typeof config!=='object'||Array.isArray(config))throw Error('Cloud MCP expects an object configuration: '+file);
 return {config,stat};
}
function servers(config,scope){
 const groups=[];
 if(config.mcpServers!==undefined){if(!config.mcpServers||typeof config.mcpServers!=='object'||Array.isArray(config.mcpServers))throw Error('Cloud MCP expects mcpServers to be an object');groups.push({servers:config.mcpServers,scope:scope==='project'?'project':'user'});}
 if(scope==='user/local'&&config.projects!==undefined){
  if(!config.projects||typeof config.projects!=='object'||Array.isArray(config.projects))throw Error('Cloud MCP expects projects to be an object');
  for(const project of Object.values(config.projects)){if(!project||typeof project!=='object'||Array.isArray(project))throw Error('Cloud MCP cannot verify a malformed local project');if(project.mcpServers!==undefined){if(!project.mcpServers||typeof project.mcpServers!=='object'||Array.isArray(project.mcpServers))throw Error('Cloud MCP expects local mcpServers to be an object');groups.push({servers:project.mcpServers,scope:'local'});}}
 }
 return groups;
}
function forbidden(config,scope){return servers(config,scope).flatMap(group=>Object.entries(group.servers).filter(([name,server])=>isOwnerTelegramMcp(server,name)).map(([name])=>({...group,name})));}
function replace(file,config,stat){
 const current=ordinary(file,false);
 if(current.dev!==stat.dev||current.ino!==stat.ino||current.mtimeMs!==stat.mtimeMs||current.size!==stat.size)throw Error('Cloud MCP configuration changed during cleanup: '+file);
 const temporary=join(dirname(file),'.cloud-mcp-'+randomUUID()+'.tmp');
 try{writeFileSync(temporary,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:stat.mode});ordinary(temporary,false);renameSync(temporary,file);}
 finally{if(existsSync(temporary))unlinkSync(temporary);}
}
export function cleanCloudClaudeMcp({env=process.env,cwd=process.cwd(),home=homedir(),dryRun=false,checkOnly=false}={}){
 const configurations=claudeMcpFiles({env,cwd,home}).map(target=>({...target,...readConfig(target.file)}));
 const removed=[];
 // Validate both scopes before writing either file; no CLI is called here.
 for(const target of configurations){if(!target.config)continue;for(const entry of forbidden(target.config,target.scope)){removed.push({name:entry.name,scope:entry.scope});if(!checkOnly)delete entry.servers[entry.name];}}
 if(checkOnly&&removed.length)throw Error('Cloud MCP verification refused: owner Telegram remains in '+removed.map(entry=>entry.scope+':'+entry.name).join(', '));
 if(!dryRun&&!checkOnly){for(const target of configurations){if(target.config&&removed.some(entry=>entry.scope==='project'?target.scope==='project':target.scope==='user/local'))replace(target.file,target.config,target.stat);}}
 if(!dryRun){for(const target of configurations){const checked=readConfig(target.file);if(checked&&forbidden(checked.config,target.scope).length)throw Error('Cloud MCP cleanup did not remove owner Telegram: '+target.file);}}
 return {dryRun,verified:!dryRun,removed};
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 try{
  const flags=process.argv.slice(2);if(flags.some(flag=>!['--dry-run','--check'].includes(flag)))throw Error('Unsupported cloud MCP cleanup argument');
  const result=cleanCloudClaudeMcp({dryRun:flags.includes('--dry-run'),checkOnly:flags.includes('--check')});
  for(const item of result.removed)console.log('    MCP '+item.name+': '+(result.dryRun?'would remove':'removed')+' owner Telegram from '+item.scope+' scope.');
  console.log('    Cloud MCP '+(result.verified?'verified':'preview')+': '+result.removed.length+' owner Telegram registrations '+(result.dryRun?'would be removed':'removed')+'.');
 }catch(error){console.error('provision-toolset: '+error.message);process.exitCode=1;}
}
