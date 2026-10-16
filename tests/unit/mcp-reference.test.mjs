import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMcpReference, resolveMcpReference } from '../../core/mcp-reference.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
const base=join(dirname(fileURLToPath(new URL('../../',import.meta.url)).replace(/[\\/]$/,'')),'scratch','tmp');mkdirSync(base,{recursive:true});
function fixture(t,files) {const root=mkdtempSync(join(base,'mcp-source-'));t.after(()=>cleanupTempDir(root));
  for(const [path,data] of Object.entries(files)){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),typeof data==='string'?data:JSON.stringify(data));}return root;}
test('MCP references resolve actual Claude, OpenCode and Codex definitions while preserving private values in memory',t=>{
  const root=fixture(t,{
    '.mcp.json':{mcpServers:{own:{command:'node',args:['own.mjs'],env:{TOKEN:'${SOURCE_TOKEN}'},cwd:'service'}}},
    'opencode.jsonc':'{// Native comment\n"mcp":{"own":{"type":"local","command":["node","own.mjs"],"environment":{"TOKEN":"{env:SOURCE_TOKEN}"},"timeout":1234}}}',
    '.codex/config.toml':'[mcp_servers."own.name"]\ncommand = "node"\nargs = ["own.mjs"]\nenv_vars = ["INHERITED"]\n[mcp_servers."own.name".env]\nTOKEN = "private-fixture"\n',
  });
  const refs=[{path:'.mcp.json',format:'mcp-json',engine:'claude',name:'own'},{path:'opencode.jsonc',format:'mcp-json',engine:'opencode',name:'own'},
    {path:'.codex/config.toml',format:'mcp-toml',engine:'codex',name:'own.name'}];
  const env={SOURCE_TOKEN:'private-fixture',INHERITED:'forwarded-fixture',UNRELATED_MCP_FIXTURE:'never-forward',PATH:process.env.PATH};
  for(const ref of refs) {const actual=resolveMcpReference(root,ref,{env});assert.equal(actual.env.TOKEN,'private-fixture');assert.equal(actual.command,'node');assert.deepEqual(actual.args,['own.mjs']);
    assert.equal(actual.environment.UNRELATED_MCP_FIXTURE,ref.engine==='codex'?undefined:'never-forward');}
  assert.equal(resolveMcpReference(root,refs[0],{env}).cwd,join(root,'service'));
  assert.deepEqual(readMcpReference(root,refs[1]).dropped,['timeout']);
  assert.throws(()=>resolveMcpReference(root,refs[0],{env:{}}),/missing/);
});
test('MCP HTTP references keep inline headers at runtime and resolve Codex header and bearer variable references',t=>{
  const root=fixture(t,{'opencode.json':{mcp:{own:{type:'remote',url:'http://127.0.0.1:1/mcp',headers:{Authorization:'Bearer {env:SOURCE_TOKEN}'}}}},
    '.codex/config.toml':'[mcp_servers.own]\nurl = "http://127.0.0.1:1/mcp"\nbearer_token_env_var = "SOURCE_TOKEN"\nenv_http_headers = { "X-Owner" = "OWNER_HEADER" }\n'});
  for(const ref of [{path:'opencode.json',format:'mcp-json',engine:'opencode',name:'own'},{path:'.codex/config.toml',format:'mcp-toml',engine:'codex',name:'own'}]) {
    const value=resolveMcpReference(root,ref,{env:{SOURCE_TOKEN:'private-fixture',OWNER_HEADER:'owner-header'}});
    assert.equal(value.type,'http');assert.equal(value.headers.Authorization,'Bearer private-fixture');
    if(ref.engine==='codex')assert.equal(value.headers['X-Owner'],'owner-header');
  }
});
test('MCP unsupported controls, missing sources and malformed metadata fail without configuration values in the error',t=>{
  for(const source of [{command:'node',disabled_tools:['write']},{command:['node'],type:'local',enabled:false},{type:'oauth',url:'https://example.invalid'},
    {type:'http',url:'https://example.invalid',http_headers_helper:'private-fixture'},{command:'node',env_vars:[{name:'TOKEN',source:'remote'}]},
    {type:'http',url:9},{command:'node',cwd:9},{command:'node',cwd:'{file:private-fixture}'},{command:'node',env:{KEY:9}},{command:'{file:private-fixture}'}]) {
    const root=fixture(t,{'.mcp.json':{mcpServers:{own:source}}});
    assert.throws(()=>readMcpReference(root,{path:'.mcp.json',format:'mcp-json',engine:'claude',name:'own'}),error=>!error.message.includes('private-fixture'));
  }
  const root=fixture(t,{'.mcp.json':'{"private-fixture"'});
  assert.throws(()=>readMcpReference(root,{path:'.mcp.json',format:'mcp-json',engine:'claude',name:'own'}),error=>!error.message.includes('private-fixture'));
  assert.throws(()=>readMcpReference(root,{path:'.mcp.json',format:'bad',name:'own'}),/reference/);
  const duplicate=fixture(t,{'.mcp.json':'{"mcpServers":{"own":{"command":"node"},"own":{"command":"private-fixture"}}}'});
  assert.throws(()=>readMcpReference(duplicate,{path:'.mcp.json',format:'mcp-json',engine:'claude',name:'own'}),/safely/);
});
