// Original synthetic inputs keep distribution tests independent of the private tool corpus.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { cleanupTempDir } from './index.mjs';
const repo=fileURLToPath(new URL('../../',import.meta.url));
const scratch=join(dirname(repo.replace(/[\\/]$/,'')),'scratch','tmp');
function copyRuntime(source,put) {
  for(const family of ['VERSION','core','lib','hooks','templates','schemas'])cpSync(join(repo,family),join(source,family),{recursive:true});
  for(const file of ['tools/0code.mjs','tools/mcp-reference-run.mjs','config/mcp-manifest.schema.json','commands/productionaudit.md','commands/productionauditloop.md'])put(file,readFileSync(join(repo,file)));
  if(!existsSync(join(source,'schemas/STATE.schema.json')))put('docs/schemas/STATE.schema.json',readFileSync(join(repo,'docs/schemas/STATE.schema.json')));
}
function toolsetFixtures(put) {
  const bodies={
    'skills/api-design/SKILL.md':'---\nname: api-design\ndescription: Synthetic API fixture\n---\nRespect project API conventions.\n',
    'skills/coding-standards/SKILL.md':'---\nname: coding-standards\ndescription: Synthetic code fixture\n---\nUse descriptive names.\n',
    'agents/architect.md':'---\nname: architect\ndescription: Synthetic architecture fixture\nmodel: fixture-model\n---\nReview the project boundaries.\n',
    'commands/code-review.md':'---\ndescription: Synthetic review fixture\n---\nReview $ARGUMENTS using project conventions.\n',
    'rules/common/coding-style.md':'# Synthetic rule fixture\nKeep owner code readable.\n',
  };
  const elements=Object.entries(bodies).map(([file,body])=>{
    const kind=file.split('/')[0],name=file.slice(kind.length+1).replace(/\/SKILL\.md$|\.md$/,'');
    put('toolset/'+file,body);
    return {id:kind+'/'+name,kind,name,source:'toolset/'+file,status:'optional',compatibility:{claude:'native',codex:'native',opencode:'native'},
      files:[{path:'toolset/'+file,sha256:createHash('sha256').update(body).digest('hex')}]};
  });
  const manifest=JSON.parse(readFileSync(join(repo,'config/mcp-manifest.example.json'),'utf8'));
  const servers=[...manifest.servers.filter(server=>server.npm_package),{name:'sentry',type:'http',url:'https://oauth.example.invalid/mcp',source:'local',portable:true}];
  for(const server of servers)elements.push({id:'mcp/'+server.name,kind:'mcp',name:server.name,source:'config/mcp-manifest.json',status:'optional',compatibility:{claude:'native',codex:'native',opencode:'native'}});
  put('config/mcp-manifest.json',JSON.stringify({schema_version:1,servers}));
  put('toolset/catalog.json',JSON.stringify({schema_version:1,elements}));put('toolset/CATALOG.md','# Synthetic test catalog\n');
}
function legacyFixtures(put) {
  const legacyFiles={'core/gates.mjs':'// Synthetic legacy gate\n','hooks/safety-guard.mjs':'// Synthetic legacy guard\n',
    '.claude/skills/orchestrator-wrapper/SKILL.md':'---\nname: legacy-fixture\ndescription: Synthetic legacy wrapper\n---\nUse the owner roadmap.\n',
    'lib/yaml-mini.mjs':'// Synthetic legacy library\n'};
  const instructions='# Project: __PROJECT_NAME__\n\nThis project is managed by the **Claude Code Autonomous Framework** v__FRAMEWORK_VERSION__.\n\nA continuous autonomous Ralph Loop: synthetic test instructions.\n';
  const settings={hooks:{PreToolUse:[{matcher:'Bash',hooks:[{type:'command',command:'node ${CLAUDE_PROJECT_DIR}/hooks/run-hook.mjs'}]}],
    Stop:[{hooks:[{type:'command',command:'node ${CLAUDE_PROJECT_DIR}/hooks/legacy-stop.mjs'}]}]},statusLine:{type:'command',command:'node ${CLAUDE_PROJECT_DIR}/hooks/legacy-status.mjs'}};
  const evidence={schema_version:1,versions:[{tag:'fixture-legacy',commit:'0'.repeat(40),url:'https://example.invalid/fixture'}],
    files:Object.entries(legacyFiles).map(([path,bytes])=>({path,hashes:{[createHash('sha256').update(bytes).digest('hex')]:['fixture-legacy']}})),
    instructions:[{tag:'fixture-legacy',template:instructions}],settings:[{tag:'fixture-legacy',template:settings}]};
  put('config/legacy-installations.json',JSON.stringify(evidence));
  return {legacyFiles,instructions,settings};
}
export function frameworkSource(t) {
  mkdirSync(scratch,{recursive:true});
  const source=mkdtempSync(join(scratch,'synthetic-source-'));t.after(()=>cleanupTempDir(source));
  const put=(path,bytes)=>{mkdirSync(dirname(join(source,path)),{recursive:true});writeFileSync(join(source,path),bytes);};
  copyRuntime(source,put);toolsetFixtures(put);
  return {source,...legacyFixtures(put)};
}
