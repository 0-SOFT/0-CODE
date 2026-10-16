// Read-only locations. An explicit Claude config directory also moves its user MCP registry.
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { compileNativeTool } from './native-tools.mjs';
import { resolveProjectPath } from './project-config.mjs';
export function resolveUserProfiles({env=process.env,home=homedir()}={}) {
  home=resolve(home);
  const directory=(value,fallback)=>{
    if(value!==undefined&&value!==''&&(typeof value!=='string'||/[\x00-\x1f]/.test(value)))throw new Error('Invalid native user directory');
    return resolve(value||fallback);
  };
  const claude=directory(env.CLAUDE_CONFIG_DIR,join(home,'.claude'));
  const codex=directory(env.CODEX_HOME,join(home,'.codex'));
  const opencode=join(directory(env.XDG_CONFIG_HOME,join(home,'.config')),'opencode');
  const mcpRoot=env.CLAUDE_CONFIG_DIR?claude:home;
  const mcpPath='.claude.json';
  return {
    claude:{root:claude,mcp:{root:mcpRoot,path:mcpPath},source:env.CLAUDE_CONFIG_DIR?'CLAUDE_CONFIG_DIR':'native home'},
    codex:{root:codex,config:'config.toml',source:env.CODEX_HOME?'CODEX_HOME':'native home'},
    opencode:{root:opencode,config:'opencode.json',source:env.XDG_CONFIG_HOME?'XDG_CONFIG_HOME':'native home',
      additional:{...(env.OPENCODE_CONFIG_DIR?{directory:directory(env.OPENCODE_CONFIG_DIR)}:{}),
        ...(env.OPENCODE_CONFIG?{config:directory(env.OPENCODE_CONFIG)}:{})}},
  };
}
export function compileUserTool(input) {
  if(typeof input.source!=='string'||!isAbsolute(input.source)||/[\x00-\x1f]/.test(input.source))throw new Error('User tool source must be an absolute file path');
  const compiled=compileNativeTool(input);
  const prefix=input.engine==='claude'?'.claude/':input.engine==='codex'&&input.kind==='agents'?'.codex/':input.kind==='skills'||input.engine==='codex'?'.agents/':'.opencode/';
  if(!compiled.path.startsWith(prefix))throw new Error('Native user tool has an unexpected project prefix');
  return {...compiled,path:compiled.path.slice(prefix.length)};
}
export function nativeUserFile(profiles,engine,path) {
  if(!['claude','codex','opencode'].includes(engine)||!profiles[engine]?.root)throw new Error('Unknown native user profile');
  return resolveProjectPath(profiles[engine].root,path,{allowFramework:true});
}
