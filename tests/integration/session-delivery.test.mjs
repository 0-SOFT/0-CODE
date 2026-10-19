import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installProject, planProjectInstallation, upgradeProject } from '../../core/project-installation.mjs';
import { doctorProject } from '../../core/project-doctor.mjs';
import { verifySessionContext } from '../../core/project-delivery.mjs';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
import { frameworkSource } from '../helpers/framework-source.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url));
const scratch=join(dirname(repo.replace(/[\\/]$/,'')),'scratch','tmp');
const modules=Object.fromEntries(Object.keys(PROJECT_MODULES).map(id=>[id,false]));
const isolated=(extra={})=>({engines:['claude'],modules:{...modules,audits:true},
  instructions:{claude:'session-hook',claude_settings:'.0-code/claude/settings.json'},...extra});
function fixture(t,files={}) {
  mkdirSync(scratch,{recursive:true});
  const root=mkdtempSync(join(scratch,'session-delivery-'));t.after(()=>cleanupTempDir(root));
  for(const [path,bytes] of Object.entries(files)) {mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),bytes);}
  return root;
}
function externalFiles(root) {
  const result=[];
  function visit(directory,prefix='') {for(const entry of readdirSync(directory,{withFileTypes:true})) {
    if(!prefix&&entry.name==='.0-code')continue;
    const path=prefix+entry.name;
    if(entry.isDirectory()) {result.push([path+'/']);visit(join(directory,entry.name),path+'/');}
    else result.push([path,readFileSync(join(root,path)).toString('base64')]);
  }}
  visit(root);return result.sort(([a],[b])=>a.localeCompare(b));
}

test('isolated context exposes exact orchestrator and enabled audit sources through both native hook events',t=>{
  for(const audits of [true,false]) {
    const root=fixture(t),config=isolated({modules:{...modules,audits}});
    const preview=planProjectInstallation(root,{config});
    assert.ok(preview.plan.changes.every(entry=>entry.path.startsWith('.0-code/')));
    const installed=installProject(root,{config}),delivery=installed.receipt.delivery;
    const rows=delivery.tools.filter(row=>row.engine==='claude');
    assert.equal(rows.length,audits?3:1);assert.equal(delivery.ready,true);
    assert.ok(rows.every(row=>row.status==='reference'&&row.load_via==='session-context'));
    const guide=readFileSync(join(root,'.0-code/AGENT.md'),'utf8');
    for(const row of rows) {assert.ok(existsSync(join(root,row.source)));assert.ok(guide.includes(JSON.stringify(row.source)));}
    for(const name of ['productionaudit','productionauditloop']) {
      assert.equal(existsSync(join(root,`.0-code/commands/${name}.md`)),audits);
      assert.equal(guide.includes(`.0-code/commands/${name}.md`),audits);
    }
    for(const event of ['SessionStart','SubagentStart']) {
      const result=spawnSync('bash',[join(root,'.0-code/hooks/run-hook.cmd'),'project-context'],{cwd:root,
        env:{...process.env,CLAUDE_PROJECT_DIR:root},input:JSON.stringify({hook_event_name:event}),encoding:'utf8',windowsHide:true,timeout:15000});
      assert.equal(result.status,0,result.stderr||result.error?.message);
      assert.deepEqual(JSON.parse(result.stdout),{hookSpecificOutput:{hookEventName:event,additionalContext:guide}});
    }
    const check=doctorProject(root).checks.find(entry=>entry.id==='claude-context');assert.equal(check.ok,true,check.reason);
    verifySessionContext(root,installed.config,delivery,guide);
    assert.throws(()=>verifySessionContext(root,installed.config,delivery,guide.split('## Procedures available')[0]),/catalog/);
    assert.equal(upgradeProject(root).result.changed,0);
  }
});

test('isolated text toolset and adaptable project tools use internal references; execution controls and MCP remain unsupported',t=>{
  const source=frameworkSource(t).source;
  const files={
    '.claude/settings.json':'{"owner":"preserve"}\r\n',
    '.claude/settings.local.json':'{"permissions":{"deny":["Read(private)"]}}\n',
    '.claude/skills/native/SKILL.md':'---\nname: native\nhooks: {}\n---\nNative owner tool.\n',
    '.agents/skills/portable/SKILL.md':'---\nname: portable\ndescription: Portable instructions\n---\nUse the owner conventions.\n',
    '.opencode/rules/owner.md':'# Shared rule\nKeep project naming.\n',
    '.opencode/agents/text-only.md':'---\ndescription: Textual review guidance\n---\nRead the project boundaries.\n',
    '.opencode/commands/controlled.md':'---\ndescription: Controlled\npermission: ask\n---\nNative control matters.\n',
    '.codex/rules/owner.rules':'prefix_rule(pattern=["git"], decision="allow")\n',
    '.codex/config.toml':'[mcp_servers.owner]\ncommand="node"\nargs=["owner.mjs"]\n',
    '.mcp.json':'{"mcpServers":{"native":{"command":"node","args":["native.mjs"]}}}\n',
  };
  const root=fixture(t,files),before=externalFiles(root);
  const config=isolated({modules:{...modules,audits:true,toolset:true,mcp_catalog:true},toolset:{scope:'project',defaults:false,
    enable:['skills/api-design','agents/architect','commands/code-review','rules/common/coding-style','mcp/sentry']}});
  const installed=installProject(root,{source,config}),delivery=installed.receipt.delivery;
  assert.deepEqual(externalFiles(root),before);
  assert.ok(installed.receipt.files.every(entry=>entry.path.startsWith('.0-code/')));
  const row=id=>delivery.tools.find(tool=>tool.id===id&&tool.engine==='claude');
  for(const id of ['skills/api-design','commands/code-review','rules/common/coding-style'])assert.equal(row(id).status,'reference',id);
  assert.equal(row('agents/architect').status,'unsupported');assert.match(row('agents/architect').reason,/execution controls.*model/);
  assert.equal(row('mcp/sentry').status,'unsupported');assert.match(row('mcp/sentry').reason,/launcher/);
  const project=delivery.tools.filter(tool=>tool.origin==='project');
  assert.equal(project.find(tool=>tool.name==='native'&&tool.kind==='skills').status,'native');
  assert.equal(project.find(tool=>tool.name==='native'&&tool.kind==='mcp').status,'native');
  assert.equal(project.find(tool=>tool.name==='owner'&&tool.kind==='mcp').status,'unsupported');
  assert.equal(project.find(tool=>tool.name==='controlled').status,'unsupported');
  assert.equal(project.find(tool=>tool.kind==='rules'&&tool.source.endsWith('.rules')).status,'unsupported');
  for(const name of ['portable','owner','text-only']) {
    const reference=project.find(tool=>tool.name===name&&tool.status==='reference');
    assert.match(reference.source,/^\.0-code\/project-tools\//);assert.ok(existsSync(join(root,reference.source)));
  }
  const guide=readFileSync(join(root,'.0-code/AGENT.md'),'utf8');assert.match(guide,/do not register native slash commands, isolated agents/);
  assert.match(guide,/resolve relative resources from the directory of the original source "\.agents\/skills\/portable\/SKILL\.md"/);
  const doctor=doctorProject(root),context=doctor.checks.find(check=>check.id==='claude-context');assert.equal(context.ok,true,context.reason);
  assert.match(doctor.checks.find(check=>check.id==='native-tools').reason,/launcher/);
  assert.equal(upgradeProject(root,{source}).result.changed,0);assert.deepEqual(externalFiles(root),before);
});

test('ordinary modes keep native Claude delivery; mixed delivery creates only separately selected engine integrations',t=>{
  const source=frameworkSource(t).source;
  const toolset={scope:'project',defaults:false,enable:['skills/api-design','agents/architect','commands/code-review','rules/common/coding-style','mcp/sentry']};
  for(const instructions of [{claude:'project-file'},{claude:'session-hook'}]) {
    const root=fixture(t),installed=installProject(root,{source,config:{engines:['claude'],modules:{...modules,audits:true,toolset:true,mcp_catalog:true},toolset,instructions}});
    assert.equal(installed.receipt.delivery.ready,true);
    assert.ok(existsSync(join(root,'.claude/skills/0-code-orchestrator/SKILL.md')));
    assert.ok(existsSync(join(root,'.claude/agents/0-code-architect.md')));
    assert.ok(existsSync(join(root,'.claude/commands/0-code-productionaudit.md')));
    assert.ok(existsSync(join(root,'.mcp.json')));
  }
  const root=fixture(t),installed=installProject(root,{source,config:isolated({engines:['claude','codex','opencode'],
    modules:{...modules,audits:true,toolset:true,mcp_catalog:true},toolset})});
  const rows=installed.receipt.delivery.tools;
  assert.equal(rows.find(row=>row.id==='core/orchestrator'&&row.engine==='claude').status,'reference');
  assert.ok(rows.filter(row=>row.id==='core/orchestrator'&&row.engine!=='claude').every(row=>row.status==='delivered'));
  assert.ok(rows.filter(row=>row.id==='mcp/sentry'&&row.engine!=='claude').every(row=>row.status==='delivered'));
  assert.equal(existsSync(join(root,'.claude')),false);assert.equal(existsSync(join(root,'.mcp.json')),false);
  assert.ok(existsSync(join(root,'.codex/config.toml')));assert.ok(existsSync(join(root,'opencode.json')));
  assert.equal(upgradeProject(root,{source}).result.changed,0);
});
