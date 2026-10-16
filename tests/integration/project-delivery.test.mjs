import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installProject as install, planProjectInstallation as plan, uninstallProject, upgradeProject as upgrade } from '../../core/project-installation.mjs';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';
import { scanProject } from '../../core/project-inventory.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
import { frameworkSource } from '../helpers/framework-source.mjs';
const repo=fileURLToPath(new URL('../../',import.meta.url));
const scratch=join(dirname(repo.replace(/[\\/]$/,'')),'scratch','tmp');mkdirSync(scratch,{recursive:true});
const sources=new Map();
const installProject=(root,options={})=>install(root,{source:sources.get(root),...options});
const planProjectInstallation=(root,options={})=>plan(root,{source:sources.get(root),...options});
const upgradeProject=(root,options={})=>upgrade(root,{source:sources.get(root),...options});
const config=(extra={})=>({engines:['claude','codex','opencode'],modules:{...Object.fromEntries(Object.keys(PROJECT_MODULES).map(id=>[id,false])),toolset:true},
  toolset:{scope:'project',defaults:false,enable:['skills/api-design','agents/architect','commands/code-review','rules/common/coding-style']},...extra});
function fixture(t,files={}) {const root=mkdtempSync(join(scratch,'delivery-'));t.after(()=>cleanupTempDir(root));
  sources.set(root,existsSync(join(repo,'toolset/skills/api-design/SKILL.md'))?repo:frameworkSource(t).source);t.after(()=>sources.delete(root));
  for(const [path,value] of Object.entries(files)) {mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),value);}return root;}
test('project delivery builds actual native files, registrations and reports; project tools win and repeat writes nothing',t=>{
  const own='---\nname: api-design\ndescription: Project API conventions\n---\n# Project rules\n';
  const native='# Preserve native settings\r\nmodel = "owner-model"\r\n';
  const root=fixture(t,{'.claude/skills/api-design/SKILL.md':own,'.claude/commands/own.md':'---\ndescription: Own command\n---\nUse $ARGUMENTS.\n',
    '.claude/rules/own.md':'Own coding rules\n','.codex/config.toml':native});
  const prepared=planProjectInstallation(root,{config:config()});assert.equal(existsSync(join(root,'.0-code')),false);
  const installed=installProject(root,{config:config()}),delivery=installed.receipt.delivery;
  assert.equal(delivery.ready,true);assert.ok(delivery.overridden.some(row=>row.id==='skills/api-design'));
  assert.equal(existsSync(join(root,'.0-code/toolset/skills/api-design/SKILL.md')),false);
  assert.equal(readFileSync(join(root,'.claude/skills/api-design/SKILL.md'),'utf8'),own);
  assert.match(readFileSync(join(root,'.agents/skills/api-design/SKILL.md'),'utf8'),/\.claude\/skills\/api-design/);
  assert.equal(existsSync(join(root,'.claude/agents/0-code-architect.md')),true);
  assert.equal(existsSync(join(root,'.opencode/agents/0-code-architect.md')),true);
  assert.match(readFileSync(join(root,'.codex/agents/0-code-architect.toml'),'utf8'),/developer_instructions/);
  assert.match(readFileSync(join(root,'.codex/config.toml'),'utf8'),/^# Preserve native settings\r\nmodel = "owner-model"\r\n/);
  assert.match(readFileSync(join(root,'.codex/config.toml'),'utf8'),/\[agents\."0-code-architect"\]/);
  assert.equal(existsSync(join(root,'.agents/skills/command-0-code-code-review/SKILL.md')),true);
  assert.equal(existsSync(join(root,'.agents/skills/command-own/SKILL.md')),true);
  assert.equal(existsSync(join(root,'.claude/rules/0-code-common-coding-style.md')),true);
  assert.match(readFileSync(join(root,'.0-code/AGENT.md'),'utf8'),/\.claude\/rules\/own.md/);
  assert.ok(delivery.tools.some(row=>row.id==='agents/architect'&&row.dropped_fields?.includes('model')));
  assert.equal(installProject(root).result.changed,0);assert.equal(upgradeProject(root).result.changed,0);
  uninstallProject(root);assert.equal(readFileSync(join(root,'.codex/config.toml'),'utf8'),native);
  assert.equal(readFileSync(join(root,'.claude/skills/api-design/SKILL.md'),'utf8'),own);
  assert.equal(existsSync(join(root,'.claude/agents/0-code-architect.md')),false);assert.equal(existsSync(join(root,'.agents')),false);
});
test('module/selection changes remove only owned native files while keeping core orchestrator and original settings',t=>{
  const root=fixture(t,{'.codex/config.toml':'model = "mine"\n'});installProject(root,{config:config()});
  const mutable=JSON.parse(readFileSync(join(root,'.0-code/config.json'),'utf8'));mutable.modules.toolset=false;
  writeFileSync(join(root,'.0-code/config.json'),JSON.stringify(mutable));upgradeProject(root);
  assert.equal(existsSync(join(root,'.codex/agents/0-code-architect.toml')),false);
  assert.equal(readFileSync(join(root,'.codex/config.toml'),'utf8'),'model = "mine"\n');
  assert.equal(existsSync(join(root,'.agents/skills/0-code-orchestrator/SKILL.md')),true);
});
test('native file conflicts and inline agent tables refuse before publishing framework files',t=>{
  for(const files of [{'.claude/skills/0-code-orchestrator/SKILL.md':'Existing project skill'}, {'.codex/config.toml':'agents = { own = { description = "mine" } }\n'}]) {
    const root=fixture(t,files);assert.throws(()=>installProject(root,{config:config()}));assert.equal(existsSync(join(root,'.0-code')),false);
    for(const [path,value] of Object.entries(files)) assert.equal(readFileSync(join(root,path),'utf8'),value);
  }
});
test('unsupported controls and native execution policy are reported; existing native tools remain untouched',t=>{
  const own='---\nname: guarded\ndescription: Own guarded tool\nhooks: {}\n---\nDo work.\n';
  const root=fixture(t,{'.claude/skills/guarded/SKILL.md':own,'.codex/rules/own.rules':'prefix_rule(pattern=["git"], decision="allow")\n'});
  const installed=installProject(root,{config:config({modules:Object.fromEntries(Object.keys(PROJECT_MODULES).map(id=>[id,false]))})});
  assert.equal(installed.receipt.delivery.ready,false);
  assert.ok(installed.receipt.delivery.tools.some(row=>row.kind==='skills'&&row.status==='unsupported'));
  assert.ok(installed.receipt.delivery.tools.some(row=>row.kind==='rules'&&row.status==='unsupported'));
  assert.equal(readFileSync(join(root,'.claude/skills/guarded/SKILL.md'),'utf8'),own);
});
test('rescan during engine changes excludes owned aliases from project definitions rather than recursively adapting them',t=>{
  const root=fixture(t);installProject(root,{config:config({engines:['claude']})});
  const next=scanProject(root).suggestedConfig;next.engines=['claude','codex','opencode'];
  upgradeProject(root,{config:next});
  const stored=JSON.parse(readFileSync(join(root,'.0-code/config.json'),'utf8'));
  assert.equal(stored.inventory.tools.some(tool=>tool.name==='0-code-orchestrator'),false);
  assert.equal(existsSync(join(root,'.codex/agents/0-code-architect.toml')),true);
});
test('OpenCode JSONC instruction fields are extracted without copying adjacent credentials into descriptors',t=>{
  const source='{// Project native configuration\n"mcp":{"private":{"headers":{"Authorization":"private-fixture-value"}}},"agent":{"own":{"description":"Own role","prompt":"Use the project API.","model":"owner-model"}},"command":{"check":{"description":"Own check","template":"Review $ARGUMENTS."}}}';
  const root=fixture(t,{'opencode.jsonc':source});
  const installed=installProject(root,{config:config({toolset:{scope:'project',defaults:false},modules:Object.fromEntries(Object.keys(PROJECT_MODULES).map(id=>[id,false]))})});
  const rows=installed.receipt.delivery.tools.filter(row=>row.origin==='project'&&row.status==='delivered');
  assert.ok(rows.some(row=>row.kind==='agents'));assert.ok(rows.some(row=>row.kind==='commands'));
  for(const row of rows) for(const path of row.files) assert.equal(readFileSync(join(root,path),'utf8').includes('private-fixture-value'),false);
  assert.equal(readFileSync(join(root,'opencode.jsonc'),'utf8'),source);
  const payload=installed.receipt.files.filter(entry=>entry.path.startsWith('.0-code/project-tools/')).map(entry=>readFileSync(join(root,entry.path),'utf8'));
  assert.deepEqual(payload.sort(),['Review $ARGUMENTS.','Use the project API.']);
});
test('registered Codex role aliases adapt only their instruction fields without reading parent credentials into descriptors',t=>{
  const parent='model = "owner-model"\n[mcp_servers.private]\ncommand = "node"\n[mcp_servers.private.env]\nTOKEN = "private-parent-fixture"\n[agents."review-alias"]\ndescription = "Project review"\nconfig_file = "agents/file-name.toml"\nnickname_candidates = ["Owner"]\n';
  const role='developer_instructions = """\nReview the current project.\nRespect its conventions.\n"""\nmodel = "owner-role-model"\nmodel_reasoning_effort = "high"\n';
  const root=fixture(t,{'.codex/config.toml':parent,'.codex/agents/file-name.toml':role});
  const settings=config({modules:Object.fromEntries(Object.keys(PROJECT_MODULES).map(id=>[id,false]))});
  const before=scanProject(root).inventory.tools.filter(tool=>tool.kind==='agents');
  assert.deepEqual(before.map(tool=>tool.name),['review-alias']);assert.equal(before[0].role_path,'.codex/agents/file-name.toml');
  const installed=installProject(root,{config:settings});
  const rows=installed.receipt.delivery.tools.filter(row=>row.kind==='agents'&&row.origin==='project');
  assert.equal(rows.filter(row=>row.status==='delivered').length,2);assert.equal(rows.find(row=>row.engine==='codex').status,'native');
  assert.ok(rows.find(row=>row.engine==='claude').dropped_fields.includes('nickname_candidates'));
  for(const row of rows.filter(row=>row.status==='delivered')) for(const path of row.files) {
    const text=readFileSync(join(root,path),'utf8');assert.equal(text.includes('private-parent-fixture'),false);
    assert.equal(text.includes('owner-role-model'),false);assert.match(text,/Project review/);
  }
  const payload=installed.receipt.files.filter(entry=>entry.path.startsWith('.0-code/project-tools/')).map(entry=>readFileSync(join(root,entry.path),'utf8'));
  assert.deepEqual(payload,['Review the current project.\nRespect its conventions.\n']);
  assert.equal(readFileSync(join(root,'.codex/config.toml'),'utf8'),parent);
  assert.equal(readFileSync(join(root,'.codex/agents/file-name.toml'),'utf8'),role);
  assert.equal(upgradeProject(root).result.changed,0);uninstallProject(root);
  assert.equal(readFileSync(join(root,'.codex/config.toml'),'utf8'),parent);
});
test('an unregistered Codex file is inventoried as adaptable and registered without replacing its instruction or model',t=>{
  const own='developer_instructions = "Keep this native role."\nmodel = "owner-role-model"\n';
  const root=fixture(t,{'.codex/agents/orphan.toml':own,'.codex/config.toml':'model = "owner"\n'});
  const inventory=scanProject(root).inventory;assert.deepEqual(inventory.tools.find(tool=>tool.name==='orphan').native,[]);
  installProject(root,{config:config({modules:Object.fromEntries(Object.keys(PROJECT_MODULES).map(id=>[id,false]))})});
  assert.equal(readFileSync(join(root,'.codex/agents/orphan.toml'),'utf8'),own);
  assert.match(readFileSync(join(root,'.codex/config.toml'),'utf8'),/config_file = "agents\/orphan.toml"/);
  const next=scanProject(root).suggestedConfig;
  upgradeProject(root,{config:next});assert.equal(upgradeProject(root).result.changed,0);
  assert.equal(readFileSync(join(root,'.codex/agents/orphan.toml'),'utf8'),own);
  assert.match(readFileSync(join(root,'.codex/config.toml'),'utf8'),/config_file = "agents\/orphan.toml"/);
  assert.equal(existsSync(join(root,'.claude/agents/orphan.md')),true);
  uninstallProject(root);assert.equal(readFileSync(join(root,'.codex/config.toml'),'utf8'),'model = "owner"\n');
});
test('external role references and unsupported TOML retain native definitions while refusing cross-engine adaptation',t=>{
  for(const registration of ['config_file = "../../outside/role.toml"','config_file = "agents/own.toml"\nunknown = { policy = true }']) {
    const parent='[agents.own]\n'+registration+'\n';
    const root=fixture(t,{'.codex/config.toml':parent,'.codex/agents/own.toml':'developer_instructions = "Owner instructions."\n'});
    const installed=installProject(root,{config:config({engines:['claude','opencode'],modules:Object.fromEntries(Object.keys(PROJECT_MODULES).map(id=>[id,false]))})});
    assert.equal(installed.receipt.delivery.ready,false);
    assert.ok(installed.receipt.delivery.tools.some(row=>row.kind==='agents'&&row.status==='unsupported'));
    assert.equal(readFileSync(join(root,'.codex/config.toml'),'utf8'),parent);
    assert.equal(installed.receipt.files.some(entry=>entry.path.startsWith('.0-code/project-tools/')&&readFileSync(join(root,entry.path),'utf8').includes('config_file')),false);
  }
});
