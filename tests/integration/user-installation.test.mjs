import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installUserTools, planUserInstallation, uninstallUserTools, doctorUserTools, recoverUserInstallation, userInstallationLocation } from '../../core/user-installation.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
import { parseToml } from '../../lib/toml-mini.mjs';
import { resolveMcpReference } from '../../core/mcp-reference.mjs';
import { frameworkSource } from '../helpers/framework-source.mjs';
import { runBootstrap } from '../helpers/bootstrap-run.mjs';
import { assertLifecycleDoctor } from '../helpers/lifecycle-doctor.mjs';
const repo=fileURLToPath(new URL('../../',import.meta.url)),scratch=join(dirname(repo.replace(/[\\/]$/,'')),'scratch','tmp');mkdirSync(scratch,{recursive:true});
const selection=['skills/coding-standards','agents/architect','commands/code-review','rules/common/coding-style','mcp/sentry'];
function fixture(t,extra={}) {
  const home=mkdtempSync(join(scratch,'machine-'));t.after(()=>cleanupTempDir(home));
  const env={...process.env,HOME:home,USERPROFILE:home,CLAUDE_CONFIG_DIR:join(home,'claude'),CODEX_HOME:join(home,'codex'),XDG_CONFIG_HOME:join(home,'xdg'),ZERO_CODE_USER_DIR:join(home,'pool')};
  delete env.OPENCODE_CONFIG;delete env.OPENCODE_CONFIG_DIR;
  const config={engines:['claude','codex','opencode'],toolset:{defaults:false,enable:selection},...extra};
  const source=existsSync(join(repo,'toolset/skills/coding-standards/SKILL.md'))?repo:frameworkSource(t).source;
  return {home,env,options:{home,env,config,source},put(path,value){mkdirSync(dirname(join(home,path)),{recursive:true});writeFileSync(join(home,path),value);}};
}
function bytes(root) {
  const rows=[];function visit(dir,path=''){for(const entry of readdirSync(dir,{withFileTypes:true})){const next=path?path+'/'+entry.name:entry.name;if(entry.isDirectory())visit(join(dir,entry.name),next);else rows.push([next,readFileSync(join(dir,entry.name)).toString('base64')]);}}visit(root);return rows.sort(([a],[b])=>a.localeCompare(b));
}
test('one machine installation: read-only plan, three native formats, repeat, upgrade and exact owner restoration',t=>{
  const f=fixture(t);f.put('codex/auth.json','owner auth fixture never read');f.put('claude/skills/owner/SKILL.md','own skill');
  f.put('claude/.claude.json','{ /* owner comment */ "mcpServers": {"own": {"type":"http", "url":"https://example.com"}}, "owner":"fixture" }\r\n');
  f.put('codex/config.toml','model = "owner-model"\r\n');f.put('codex/AGENTS.md','# Owner instructions\r\n');f.put('xdg/opencode/opencode.jsonc','{ // own settings\n "theme":"owner"\n}\n');
  const before=bytes(f.home),planned=planUserInstallation(f.options);assert.deepEqual(bytes(f.home),before);assert.equal(planned.receipt.delivery.ready,true);
  assert.equal(recoverUserInstallation(f.options).recovered,false);
  const installed=installUserTools(f.options);assert.ok(installed.result.changed>0);assert.equal(doctorUserTools(f.options).ok,true);
  assert.equal(parseToml(readFileSync(join(f.env.CODEX_HOME,'config.toml'),'utf8')).model,'owner-model');
  for(const profile of ['claude','codex','xdg/opencode'])assert.ok(existsSync(join(f.home,profile,'skills/0-code-coding-standards/SKILL.md')));
  const receipt=readFileSync(join(f.env.ZERO_CODE_USER_DIR,'.0-code/installation.json'),'utf8');assert.ok(!receipt.includes('owner auth fixture'));assert.ok(!receipt.includes('"owner":"fixture"'));
  assert.equal(installUserTools(f.options).result.changed,0);
  const narrowed={...f.options,config:{...f.options.config,toolset:{defaults:false,enable:['skills/coding-standards']}}};
  assert.ok(installUserTools(narrowed).result.changed>0);assert.ok(!existsSync(join(f.env.CODEX_HOME,'agents/0-code-architect.toml')));assert.equal(doctorUserTools(narrowed).ok,true);
  uninstallUserTools(narrowed);assert.deepEqual(bytes(f.home),before);assert.equal(doctorUserTools(f.options).ok,false);
});
test('late owner fields survive install and removal; changed owned body blocks the entire operation',t=>{
  const f=fixture(t);installUserTools(f.options);
  const path=join(f.env.CLAUDE_CONFIG_DIR,'.claude.json'),json=JSON.parse(readFileSync(path,'utf8'));json.owner='late';writeFileSync(path,JSON.stringify(json));
  const role=join(f.env.CODEX_HOME,'agents/0-code-architect.toml'),saved=readFileSync(role);writeFileSync(role,'developer_instructions = "changed"\n');
  const before=bytes(f.home);assert.throws(()=>uninstallUserTools(f.options),/changed/);assert.deepEqual(bytes(f.home),before);assert.equal(doctorUserTools(f.options).ok,false);
  writeFileSync(role,saved);assert.equal(doctorUserTools(f.options).ok,true);uninstallUserTools(f.options);assert.deepEqual(JSON.parse(readFileSync(path)),{owner:'late'});
});
test('collisions, unowned directories and changed native roots refuse before writes',t=>{
  const f=fixture(t);f.put('codex/agents/0-code-architect.toml','owner file');const before=bytes(f.home);
  assert.throws(()=>installUserTools(f.options),/intersections/i);assert.deepEqual(bytes(f.home),before);
  const g=fixture(t);installUserTools(g.options);
  assert.throws(()=>planUserInstallation({...g.options,env:{...g.env,CODEX_HOME:join(g.home,'other')}}),/locations changed/);
  assert.throws(()=>planUserInstallation({...g.options,config:{...g.options.config,engines:['codex']}}),/engine set/);
  const h=fixture(t);h.put('pool/.0-code/owner.txt','own');assert.throws(()=>planUserInstallation(h.options),/no ownership receipt/);
  assert.throws(()=>uninstallUserTools(h.options),/No owned/);
});
test('machine MCP keeps caller directory while reading its immutable public manifest',t=>{
  const f=fixture(t);f.options.config.toolset={defaults:false,enable:['mcp/memory']};installUserTools(f.options);
  const pool=f.env.ZERO_CODE_USER_DIR,specDir=join(pool,'.0-code/mcp'),spec=JSON.parse(readFileSync(join(specDir,readdirSync(specDir)[0])));
  assert.equal(spec.cwd,'caller');const cwd=join(f.home,'project');mkdirSync(cwd);
  const input=resolveMcpReference(pool,spec.reference,{env:{...f.env,NPM_GLOBAL_ROOT:join(f.home,'node_modules')},cwd});
  assert.equal(input.cwd,cwd);assert.ok(input.args[0].includes('server-memory'));
  uninstallUserTools(f.options);
});
test('actual CLI installs default user scope into isolated profiles and project removal leaves the machine bundle',async t=>{
  const f=fixture(t,{modules:{audits:false,session_logs:false,token_usage:false,mcp_catalog:false},toolset:{defaults:false,enable:['skills/coding-standards']}}),project=join(f.home,'project');mkdirSync(project);
  const configFile=join(f.home,'config.json');writeFileSync(configFile,JSON.stringify(f.options.config));
  const run=(args,installed=false)=>runBootstrap(process.execPath,[installed?join(project,'.0-code/tools/0code.mjs'):join(repo,'tools/0code.mjs'),...args,
    ...(args[0]==='install'?['--source',f.options.source]:[]),'--project',project,'--json'],{env:f.env});
  const preview=await run(['install','--config',configFile,'--dry-run']);assert.equal(preview.status,0,preview.stderr);assert.ok(!existsSync(join(f.home,'pool')));
  const started=performance.now(),installed=await run(['install','--config',configFile]);assert.equal(installed.status,0,installed.stderr);
  t.diagnostic('Actual user-scope CLI install with filesystem progress: '+Math.round(performance.now()-started)+' ms');
  const doctor=await run(['doctor']);assertLifecycleDoctor(JSON.parse(doctor.stdout),{cwd:project,env:f.env,engines:f.options.config.engines,status:doctor.status});
  assert.ok(!existsSync(join(project,'.0-code/toolset/skills/coding-standards/SKILL.md')));
  const repeat=await run(['install'],true);assert.equal(repeat.status,0,repeat.stderr);assert.equal(JSON.parse(repeat.stdout).changed,0);assert.equal((await run(['doctor-tools'])).status,0);
  assert.equal((await run(['uninstall'])).status,0);assert.ok(existsSync(join(f.home,'pool/.0-code/installation.json')));
  assert.equal((await run(['uninstall-tools'])).status,0);assert.ok(!existsSync(join(f.home,'pool/.0-code')));
  assert.equal(userInstallationLocation({home:f.home,env:{}}),join(f.home,'.local/share/0-code'));
});
