import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { installProject, upgradeProject, uninstallProject } from '../../core/project-installation.mjs';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';
import { scanProject } from '../../core/project-inventory.mjs';
import { parseToml } from '../../lib/toml-mini.mjs';
import { parseJsonc } from '../../lib/jsonc.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
const repo=fileURLToPath(new URL('../../',import.meta.url)).replace(/[\\/]$/,'');
const base=join(dirname(repo),'scratch','tmp'),echo=join(repo,'tests/helpers/mcp-echo-server.mjs');mkdirSync(base,{recursive:true});
const config={engines:['claude','codex','opencode'],modules:Object.fromEntries(Object.keys(PROJECT_MODULES).map(id=>[id,false]))};
function fixture(t,files={}) {
  const root=mkdtempSync(join(base,'mcp-delivery-'));t.after(()=>cleanupTempDir(root));
  for(const [path,value] of Object.entries(files)){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),typeof value==='string'?value:JSON.stringify(value));}
  return root;
}
function client(t,entry,root) {
  const command=Array.isArray(entry.command)?entry.command[0]:entry.command,args=Array.isArray(entry.command)?entry.command.slice(1):entry.args;
  const child=spawn(command,args,{cwd:root,env:{...process.env,UNRELATED_MCP_FIXTURE:'host-fixture'},stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
  const pending=new Map();let serial=0,stderr='';
  const exited=new Promise(resolve=>child.once('exit',resolve));
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.once('exit',code=>{for(const reply of pending.values())reply({error:{message:'Actual MCP process exited before a reply: '+String(code)}});});
  createInterface({input:child.stdout}).on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}pending.get(value.id)?.(value);});
  async function close() {
    child.stdin.end();let timer;
    await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>{child.kill();resolve();},3000);})]);clearTimeout(timer);
  }
  t.after(close);
  return {
    async call(method,params) {
      const id=++serial,promise=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Actual MCP process did not answer: '+method));},10000);
        pending.set(id,value=>{clearTimeout(timer);pending.delete(id);value.error?reject(new Error(value.error.message)):resolve(value.result);});});
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return promise;
    },
    notify(method,params){child.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n');},
    stderr:()=>stderr,
    close,
  };
}
async function handshake(rpc) {
  const initialized=await rpc.call('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'transport-test',version:'1.0.0'}});
  assert.equal(initialized.protocolVersion,'2025-03-26');rpc.notify('notifications/initialized',{});
  const tools=await rpc.call('tools/list',{});assert.equal(tools.tools[0].name,'echo');
}
test('project stdio MCP reaches the real server through both recipient formats, preserves credentials and restores exact files',async t=>{
  const privateValue='private-stdio-fixture',source=JSON.stringify({mcpServers:{own:{command:process.execPath,args:[echo],env:{TOKEN:privateValue},cwd:'service'}}});
  const native='{// Keep this comment\r\n"model":"owner/model","owner":"preserve",\r\n}\r\n';
  const root=fixture(t,{'.mcp.json':source,'opencode.jsonc':native,'.codex/config.toml':'model = "owner"\n'});mkdirSync(join(root,'service'));
  const installed=installProject(root,{config});
  assert.equal(installed.receipt.delivery.ready,true);
  assert.equal(readFileSync(join(root,'.mcp.json'),'utf8'),source);
  const codex=parseToml(readFileSync(join(root,'.codex/config.toml'),'utf8')).mcp_servers.own;
  const open=parseJsonc(readFileSync(join(root,'opencode.jsonc'),'utf8')).mcp.own;
  assert.equal(open.command[0],realpathSync(process.execPath));assert.equal(codex.command,realpathSync(process.execPath));
  assert.ok(readFileSync(join(root,'opencode.jsonc'),'utf8').includes('// Keep this comment\r\n'));
  for(const row of installed.receipt.delivery.tools.filter(row=>row.kind==='mcp'&&row.status==='delivered'))
    for(const file of row.files)assert.equal(readFileSync(join(root,file),'utf8').includes(privateValue),false);
  for(const entry of [codex,open]) {
    const rpc=client(t,entry,root);await handshake(rpc);
    const actual=JSON.parse((await rpc.call('tools/call',{name:'echo',arguments:{text:'Quoted %&$() and \u043a\u0438\u0440\u0438\u043b\u043b\u0438\u0446\u0430'}})).content[0].text);
    assert.equal(actual.text,'Quoted %&$() and \u043a\u0438\u0440\u0438\u043b\u043b\u0438\u0446\u0430');assert.equal(actual.cwd,join(root,'service'));
    assert.equal(actual.tokenDigest,createHash('sha256').update(privateValue).digest('hex'));
    assert.equal(rpc.stderr().includes(privateValue),false);
    await rpc.close();
  }
  assert.equal(upgradeProject(root).result.changed,0);
  const rescan=scanProject(root).suggestedConfig;rescan.engines=config.engines;rescan.modules=config.modules;
  upgradeProject(root,{config:rescan});assert.equal(upgradeProject(root).result.changed,0);
  assert.equal(JSON.parse(readFileSync(join(root,'.0-code/config.json'),'utf8')).inventory.tools.filter(row=>row.kind==='mcp').length,1);
  uninstallProject(root);assert.equal(readFileSync(join(root,'.mcp.json'),'utf8'),source);
  assert.equal(readFileSync(join(root,'opencode.jsonc'),'utf8'),native);
  assert.equal(readFileSync(join(root,'.codex/config.toml'),'utf8'),'model = "owner"\n');
});
test('Codex MCP literal environment and whitelist survive delivery through real Claude and OpenCode stdio processes',async t=>{
  const source='[mcp_servers.own]\ncommand = '+JSON.stringify(process.execPath)+'\nargs = ['+JSON.stringify(echo)+']\nenv_vars = []\n[mcp_servers.own.env]\nTOKEN = "private-codex-fixture"\n';
  const root=fixture(t,{'.codex/config.toml':source});installProject(root,{config});
  const claude=JSON.parse(readFileSync(join(root,'.mcp.json'),'utf8')).mcpServers.own;
  const open=JSON.parse(readFileSync(join(root,'opencode.json'),'utf8')).mcp.own;
  for(const entry of [claude,open]) {
    const rpc=client(t,entry,root);await handshake(rpc);
    const actual=JSON.parse((await rpc.call('tools/call',{name:'echo',arguments:{text:'whitelist'}})).content[0].text);
    assert.equal(actual.unrelatedPresent,false);
    assert.equal(actual.tokenDigest,createHash('sha256').update('private-codex-fixture').digest('hex'));
    await rpc.close();
  }
  assert.equal(readFileSync(join(root,'.codex/config.toml'),'utf8'),source);
});
test('real Streamable HTTP MCP preserves private headers, session and SSE responses through the reference transport',async t=>{
  const seen=[],server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const message=JSON.parse(raw);seen.push({method:message.method,authorization:req.headers.authorization,session:req.headers['mcp-session-id'],version:req.headers['mcp-protocol-version']});
    if(message.id===undefined){res.writeHead(202).end();return;}
    let result;
    if(message.method==='initialize') {res.setHeader('Mcp-Session-Id','test-session');result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'http-echo',version:'1'}};}
    else if(message.method==='tools/list')result={tools:[{name:'echo',inputSchema:{type:'object'}}]};
    else result={content:[{type:'text',text:message.params.arguments.text}]};
    if(message.method==='tools/call') {res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: message\r');setImmediate(()=>res.end('\ndata: '+JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\r\n\r\n'));}
    else {res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const source={mcp:{own:{type:'remote',url:'http://127.0.0.1:'+server.address().port+'/mcp',headers:{Authorization:'Bearer private-http-fixture'}}}};
  const root=fixture(t,{'opencode.json':source});const installed=installProject(root,{config});assert.equal(installed.receipt.delivery.ready,true);
  const entry=JSON.parse(readFileSync(join(root,'.mcp.json'),'utf8')).mcpServers.own;
  const rpc=client(t,entry,root);await handshake(rpc);
  assert.equal((await rpc.call('tools/call',{name:'echo',arguments:{text:'actual HTTP reply'}})).content[0].text,'actual HTTP reply');
  assert.ok(seen.every(row=>row.authorization==='Bearer private-http-fixture'));
  assert.equal(seen.find(row=>row.method==='tools/call').session,'test-session');
  assert.equal(seen.find(row=>row.method==='tools/call').version,'2025-03-26');
  await rpc.close();
  for(const row of installed.receipt.delivery.tools.filter(row=>row.kind==='mcp'&&row.status==='delivered'))for(const file of row.files)
    assert.equal(readFileSync(join(root,file),'utf8').includes('private-http-fixture'),false);
});
test('owner native settings can change outside the managed entries and survive upgrade and uninstall',t=>{
  const source={mcpServers:{own:{command:'node',args:['owner.mjs']}}};
  const root=fixture(t,{'.mcp.json':source,'opencode.json':'{"model":"first","owner":true}\n','AGENTS.md':'Owner rules.\n'});
  installProject(root,{config});
  const native=readFileSync(join(root,'opencode.json'),'utf8').replace('"first"','"second"');
  writeFileSync(join(root,'opencode.json'),native);
  writeFileSync(join(root,'AGENTS.md'),readFileSync(join(root,'AGENTS.md'),'utf8')+'More owner rules.\n');
  upgradeProject(root);assert.ok(readFileSync(join(root,'opencode.json'),'utf8').includes('"second"'));
  uninstallProject(root);
  assert.deepEqual(JSON.parse(readFileSync(join(root,'opencode.json'),'utf8')),{model:'second',owner:true});
  assert.equal(readFileSync(join(root,'AGENTS.md'),'utf8'),'Owner rules.\nMore owner rules.\n');
});
test('native MCP collisions refuse before writing, while unsupported controls and competing definitions are explicit',t=>{
  const root=fixture(t,{'.mcp.json':{mcpServers:{own:{command:'node'}}},'.codex/config.toml':'mcp_servers = { mine = { command = "node" } }\n'});
  assert.throws(()=>installProject(root,{config}),/Inline/);assert.equal(existsSync(join(root,'.0-code')),false);
  for(const definitions of [
    {'.mcp.json':{mcpServers:{own:{command:'node',disabled_tools:['write']}}}},
    {'.mcp.json':{mcpServers:{own:{command:'node'}}},'opencode.json':{mcp:{own:{type:'local',command:['owner-tool']}}}},
  ]) {
    const project=fixture(t,definitions),result=installProject(project,{config});
    assert.equal(result.receipt.delivery.ready,false);
    assert.ok(result.receipt.delivery.tools.some(row=>row.kind==='mcp'&&row.status==='unsupported'));
  }
});
test('selected framework MCP uses the common reference launcher and module changes remove only its entries',t=>{
  const root=fixture(t,{'opencode.json':'{"owner":true}\n'});
  const options={...config,modules:{...config.modules,toolset:true,mcp_catalog:true},toolset:{scope:'project',defaults:false,enable:['mcp/context7']}};
  installProject(root,{config:options});
  const descriptor=JSON.parse(readFileSync(join(root,'opencode.json'),'utf8')).mcp['0-code-context7'];
  assert.ok(descriptor.command[1].endsWith('mcp-reference-run.mjs'));
  assert.equal(upgradeProject(root).result.changed,0);
  const updated=JSON.parse(readFileSync(join(root,'.0-code/config.json'),'utf8'));updated.modules.toolset=false;
  writeFileSync(join(root,'.0-code/config.json'),JSON.stringify(updated));upgradeProject(root);
  assert.equal(readFileSync(join(root,'opencode.json'),'utf8'),'{"owner":true}\n');
  assert.equal(existsSync(join(root,'.mcp.json')),false);
});
test('Claude MCP approvals name only known servers and retain explicit native rejections',t=>{
  const own={mcpServers:{accepted:{command:'node'},rejected:{command:'node'}}};
  const native={enabledMcpjsonServers:['owner-existing'],disabledMcpjsonServers:['rejected'],enableAllProjectMcpServers:false};
  const root=fixture(t,{'.mcp.json':own,'.claude/settings.json':native});
  installProject(root,{config});
  const installed=JSON.parse(readFileSync(join(root,'.claude/settings.json'),'utf8'));
  assert.deepEqual(installed.enabledMcpjsonServers,['owner-existing','accepted']);
  assert.deepEqual(installed.disabledMcpjsonServers,['rejected']);assert.equal(installed.enableAllProjectMcpServers,false);
  uninstallProject(root);assert.deepEqual(JSON.parse(readFileSync(join(root,'.claude/settings.json'),'utf8')),native);
});
test('fixture catalog HTTP uses native OAuth-capable transports and keeps bearer values as environment references',t=>{
  const servers=[
    {name:'oauth-example',type:'http',url:'https://oauth.example.invalid/mcp',source:'local',portable:true},
    {name:'bearer-example',type:'http',url:'https://bearer.example.invalid/mcp',source:'local',portable:true,
      headers:{Authorization:'Bearer ${EXAMPLE_MCP_TOKEN}'},secrets:['EXAMPLE_MCP_TOKEN']},
  ];
  const source=fixture(t,{
    'toolset/catalog.json':{schema_version:1,elements:servers.map(server=>({id:'mcp/'+server.name,kind:'mcp',name:server.name,
      source:'config/mcp-manifest.json',status:'optional',compatibility:{claude:'native',codex:'native',opencode:'native'}}))},
    'toolset/CATALOG.md':'# Synthetic HTTP catalog\n',
    'config/mcp-manifest.json':{schema_version:1,servers},
    'config/mcp-manifest.schema.json':readFileSync(join(repo,'config/mcp-manifest.schema.json'),'utf8'),
    'docs/schemas/STATE.schema.json':readFileSync(join(repo,'docs/schemas/STATE.schema.json'),'utf8'),
    'tools/0code.mjs':readFileSync(join(repo,'tools/0code.mjs'),'utf8'),
    'tools/mcp-reference-run.mjs':readFileSync(join(repo,'tools/mcp-reference-run.mjs'),'utf8'),
  });
  // Copy only public runtime families; no private catalog or development documents are inputs.
  for(const family of ['VERSION','core','lib','hooks','templates','schemas'])cpSync(join(repo,family),join(source,family),{recursive:true});
  const root=fixture(t);
  const installed=installProject(root,{source,config:{...config,modules:{...config.modules,toolset:true,mcp_catalog:true},
    toolset:{scope:'project',defaults:false,enable:servers.map(server=>'mcp/'+server.name)}}});
  const codex=parseToml(readFileSync(join(root,'.codex/config.toml'),'utf8')).mcp_servers;
  const open=JSON.parse(readFileSync(join(root,'opencode.json'),'utf8')).mcp;
  const claude=JSON.parse(readFileSync(join(root,'.mcp.json'),'utf8')).mcpServers;
  assert.equal(codex['0-code-oauth-example'].url,'https://oauth.example.invalid/mcp');
  assert.equal(codex['0-code-bearer-example'].bearer_token_env_var,'EXAMPLE_MCP_TOKEN');
  assert.equal(open['0-code-bearer-example'].headers.Authorization,'Bearer {env:EXAMPLE_MCP_TOKEN}');
  assert.equal(claude['0-code-bearer-example'].headers.Authorization,'Bearer ${EXAMPLE_MCP_TOKEN}');
  assert.ok(installed.receipt.delivery.tools.filter(row=>row.kind==='mcp').every(row=>row.native_transport));
  assert.equal(upgradeProject(root,{source}).result.changed,0);uninstallProject(root);
  assert.equal(existsSync(join(root,'.mcp.json')),false);
});
test('a comment added to a created registry remains after its last managed entry is removed',t=>{
  const root=fixture(t,{'.codex/config.toml':'[mcp_servers.own]\ncommand="node"\n'});
  installProject(root,{config});
  const native=readFileSync(join(root,'.mcp.json'),'utf8').replace('{','{\n// Owner comment\n');
  writeFileSync(join(root,'.mcp.json'),native);uninstallProject(root);
  assert.ok(readFileSync(join(root,'.mcp.json'),'utf8').includes('// Owner comment'));
  assert.deepEqual(parseJsonc(readFileSync(join(root,'.mcp.json'),'utf8')),{});
});
