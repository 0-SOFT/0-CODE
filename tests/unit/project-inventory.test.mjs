import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scanProject, inventorySummary } from '../../core/project-inventory.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';

const repository=fileURLToPath(new URL('../../',import.meta.url));
const scratch=join(dirname(repository.replace(/[\\/]$/,'')),'scratch','tmp');
mkdirSync(scratch,{recursive:true});
function fixture(t,files={}) {
  const root=mkdtempSync(join(scratch,'inventory-'));
  t.after(()=>cleanupTempDir(root));
  for(const [name,content] of Object.entries(files)) { mkdirSync(dirname(join(root,name)),{recursive:true}); writeFileSync(join(root,name),typeof content==='string'?content:JSON.stringify(content)); }
  return root;
}
function tree(root) {
  const walk=path=>readdirSync(join(root,path),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
    const name=join(path,entry.name);return entry.isDirectory()?walk(name):[[name,createHash('sha256').update(readFileSync(join(root,name))).digest('hex')]];
  });return walk('');
}

test('empty project scan is deterministic and creates no installation or documents',t=>{
  const root=fixture(t),before=tree(root);
  const first=scanProject(root);
  assert.deepEqual(scanProject(root),first);
  assert.deepEqual(tree(root),before);
  assert.deepEqual(first.inventory.tools,[]);
  assert.deepEqual(first.suggestedConfig.engines,['claude']);
  assert.equal(first.suggestedConfig.language,'en');
  assert.match(inventorySummary(first),/Check commands: 0/);
});

test('project tools from all four surfaces are inventoried without exposing keys',t=>{
  const privateValue='only-for-this-inventory-fixture';
  const root=fixture(t,{
    '.claude/skills/local/SKILL.md':'---\nname: local\ndescription: Local skill\n---\nRead code.',
    '.agents/skills/shared/SKILL.md':'---\nname: shared\ndescription: Shared skill\n---\nRead code.',
    '.opencode/skills/open/SKILL.md':'---\nname: open\ndescription: Open skill\n---\nRead code.',
    '.codex/skills/codex/SKILL.md':'---\nname: codex\ndescription: Codex skill\n---\nRead code.',
    '.claude/agents/review.md':'---\nname: review\n---\nRead code.',
    '.claude/commands/check.md':'Check source code.',
    '.claude/rules/readability.md':'Use clear names.',
    '.claude/hooks/project.js':'console.log("project hook")',
    '.claude/settings.json':{hooks:{PreToolUse:[{hooks:[{type:'command',command:'echo '+privateValue}]}],Stop:[{hooks:[{type:'command',command:'node own-loop.js'}]}]}},
    '.mcp.json':{mcpServers:{local:{command:'node',args:['local.js'],env:{OWN_KEY:privateValue}}}},
    '.codex/config.toml':'[mcp_servers."local.codex"]\ncommand = "node"\n[mcp_servers."local.codex".env]\nTOKEN = "'+privateValue+'"\n[agents.reviewer]\nconfig_file = "agents/reviewer.toml"\n',
    '.codex/agents/reviewer.toml':'developer_instructions = "Read code."',
    '.codex/rules/local.rules':'prefix_rule(pattern=["echo"], decision="allow")',
    'opencode.json':{mcp:{open:{type:'remote',url:'https://example.invalid',headers:{Authorization:privateValue}}},agent:{review:{}},command:{check:{}},plugin:['./own.js']},
    'AGENTS.md':'Project instructions',
    '.env':'OWN_KEY='+privateValue,
  });
  const before=tree(root),result=scanProject(root),serialized=JSON.stringify(result);
  assert.equal(serialized.includes(privateValue),false);
  assert.deepEqual(tree(root),before);
  assert.equal(result.inventory.tools.filter(tool=>tool.kind==='skills').length,4);
  const claudeSkill=result.inventory.tools.find(tool=>tool.path==='.claude/skills/local/SKILL.md');
  assert.deepEqual(claudeSkill.native,['claude','opencode']);
  const codexMcp=result.inventory.tools.filter(tool=>tool.kind==='mcp' && tool.engine==='codex');
  assert.equal(codexMcp.length,1);
  assert.equal(codexMcp[0].name,'local.codex');
  assert.deepEqual(result.inventory.tools.find(tool=>tool.kind==='mcp' && tool.path==='.mcp.json').environmentNames,['OWN_KEY']);
  assert.deepEqual(result.suggestedConfig.engines,['claude','codex','opencode']);
  assert.equal(result.conflicts.length,1);
  assert.match(result.conflicts[0].name,/Stop/);
});

test('build and check commands cover workspaces, Python, Make, Go and Rust without execution',t=>{
  const root=fixture(t,{
    'package.json':{scripts:{test:'node impossible-to-execute.js',lint:'echo arbitrary text'}},
    'packages/ui/package.json':{scripts:{test:'echo UI tests',build:'echo build'}},
    'packages/ui/pnpm-lock.yaml':'lockfileVersion: 9',
    'python/pyproject.toml':'[project]\nname = "sample"\ndependencies = ["pytest", "ruff"]\n[tool.poe.tasks]\ncheck = "pytest"\n',
    'python/uv.lock':'version = 1',
    'Makefile':'test: setup\n\tfalse\nlint:\n\tfalse\nVAR := value\n',
    'go/go.mod':'module example.invalid/sample\ngo 1.22',
    'rust/Cargo.toml':'[package]\nname="example"\nversion="0.1.0"',
    'node_modules/ignored/package.json':{scripts:{test:'never read'}},
    '.0-code/internal/package.json':{scripts:{test:'never read'}},
  });
  const result=scanProject(root),checks=result.inventory.checks;
  assert.deepEqual(checks.find(check=>check.id==='packages/ui/package.json:test').argv,['pnpm','run','test']);
  assert.equal(checks.find(check=>check.id==='packages/ui/package.json:test').cwd,'packages/ui');
  assert.deepEqual(checks.find(check=>check.id==='python/pyproject.toml:test').argv,['uv','run','pytest']);
  assert.deepEqual(checks.find(check=>check.id==='python/pyproject.toml:check').argv,['poetry','run','poe','check']);
  assert.deepEqual(checks.find(check=>check.id==='go/go.mod:test').argv,['go','test','./...']);
  assert.deepEqual(checks.find(check=>check.id==='rust/Cargo.toml:check').argv,['cargo','check']);
  assert.ok(checks.some(check=>check.id==='Makefile:lint'));
  assert.equal(checks.some(check=>check.name==='VAR'),false);
  assert.equal(checks.some(check=>check.path.includes('node_modules')||check.path.includes('.0-code')),false);
});

test('existing document scheme, language and installed settings are retained',t=>{
  const root=fixture(t,{
    'README.md':'# \u041f\u0440\u043e\u0435\u043a\u0442\n\u041e\u043f\u0438\u0441\u0430\u043d\u0438\u0435 \u043f\u0440\u043e\u0435\u043a\u0442\u0430 \u0438 \u043f\u0440\u0430\u0432\u0438\u043b\u0430 \u0440\u0430\u0437\u0440\u0430\u0431\u043e\u0442\u043a\u0438. \u042d\u0442\u043e\u0442 \u043f\u0440\u043e\u0435\u043a\u0442 \u043f\u0440\u043e\u0432\u0435\u0440\u044f\u0435\u0442 \u043e\u0442\u0447\u0451\u0442\u044b \u0438 \u0440\u0435\u0448\u0435\u043d\u0438\u044f.\n',
    'CHANGELOG.md':'# \u0418\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f\n\u041f\u043b\u0430\u043d \u0438 \u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442\u044b.',
    'docs/adr/0001-storage.md':'# \u0420\u0435\u0448\u0435\u043d\u0438\u0435\n\u0425\u0440\u0430\u043d\u0438\u043c \u0434\u043e\u043a\u0443\u043c\u0435\u043d\u0442\u044b \u043f\u0440\u043e\u0435\u043a\u0442\u0430.',
    '.0-code/config.json':{engines:['codex'],language:'de',documents:{state:{path:'operations/status.md'},roadmap:{path:'CHANGELOG.md'}}},
  });
  const result=scanProject(root);
  assert.equal(result.inventory.language.language,'ru');
  assert.equal(result.suggestedConfig.language,'de');
  assert.deepEqual(result.suggestedConfig.engines,['codex']);
  assert.equal(result.suggestedConfig.documents.state.path,'operations/status.md');
  assert.equal(result.inventory.documents.find(doc=>doc.path==='CHANGELOG.md').role,'roadmap');
  assert.equal(result.inventory.documents.find(doc=>doc.path==='docs/adr/0001-storage.md').role,'decisions');
});

test('legacy ownership is only reported as a candidate; scan never deletes it',t=>{
  const root=fixture(t,{'core/supervisor.mjs':'old supervisor','lib/update-state.mjs':'old writer',
    'hooks/ralph-loop-stop':'old hook','docs/STATE.md':'---\nframework_version: "1.30.0"\n---\nOld state'});
  const before=tree(root),result=scanProject(root);
  assert.equal(result.inventory.legacy.detected,true);
  assert.equal(result.inventory.legacy.frameworkVersion,'1.30.0');
  assert.deepEqual(tree(root),before);
});

test('malformed project metadata yields value-free diagnostics and guard conflicts',t=>{
  const privateValue='do-not-print-this-broken-metadata';
  const root=fixture(t,{'package.json':'{'+privateValue,'.mcp.json':'null',
    '.claude/settings.json':{hooks:{PreToolUse:[{hooks:[{type:'command',command:'node own-safety-guard.js'}]}],Stop:'invalid'}},
    '.codex/config.toml':'[mcp_servers.bad syntax]\ncommand="secret"\n'});
  const result=scanProject(root);
  assert.equal(result.inventory.warnings.length,3);
  assert.equal(JSON.stringify(result).includes(privateValue),false);
  assert.equal(result.conflicts.length,1);
  assert.equal(result.inventory.tools.some(tool=>tool.kind==='mcp'),false);
});

test('language inference handles multiple writing systems and exposes its basis',t=>{
  for(const [language,text] of [['ja','日本語のプロジェクトの説明です'],['zh','项目文档和开发规范'],
    ['uk','\u041f\u0440\u043e\u0454\u043a\u0442: \u0456\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0456\u0457 \u0442\u0430 \u0456\u0441\u0442\u043e\u0440\u0456\u044f \u0437\u043c\u0456\u043d'],['de','Das Projekt und die Tests mit der Anleitung'],
    ['fr','Le projet avec les tests pour cette application'],['es','El proyecto con los tests para este trabajo'],
    ['pt','Este projeto com uma ferramenta para todos, não é difícil'],['ar','مشروع برمجي للاختبار'],['ko','프로젝트 개발 문서 테스트']]) {
    const root=fixture(t,{'README.md':'# '+text});
    assert.equal(scanProject(root).inventory.language.language,language,text);
  }
});

test('OpenCode JSONC keeps string contents while accepting comments and trailing commas',t=>{
  const root=fixture(t,{'opencode.jsonc':'{\n// Local project\n"mcp": {"one": {"type":"remote", "url":"https://example.invalid/path/*literal*/",},},\n"agent": {"reader": {},},\n}'});
  const result=scanProject(root);
  assert.equal(result.inventory.warnings.length,0);
  assert.equal(result.inventory.tools.find(tool=>tool.kind==='mcp').name,'one');
  assert.equal(result.inventory.tools.find(tool=>tool.kind==='agents').name,'reader');
  assert.equal(JSON.stringify(result).includes('example.invalid'),false);
  assert.deepEqual(result.suggestedConfig.engines,['opencode']);
});

test('real scan CLI prints JSON and text without changing the target project',t=>{
  const root=fixture(t,{'package.json':{scripts:{test:'never execute this'}},'README.md':'# Example\nThe project and the tests.'});
  const before=tree(root),cli=join(repository,'tools/0code.mjs');
  const json=spawnSync(process.execPath,[cli,'scan','--project',root,'--json'],{encoding:'utf8',windowsHide:true});
  assert.equal(json.status,0,json.stderr);
  assert.equal(JSON.parse(json.stdout).inventory.checks[0].name,'test');
  const human=spawnSync(process.execPath,[cli,'scan','--project',root],{encoding:'utf8',windowsHide:true});
  assert.equal(human.status,0,human.stderr);
  assert.match(human.stdout,/Inventory:/);
  assert.match(human.stdout,/Suggested configuration/);
  assert.deepEqual(tree(root),before);
  for(const args of [[],['scan','--project'],['scan','--unknown'],['scan','--project',root,'--project',root]]) {
    const invalid=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',windowsHide:true});
    assert.notEqual(invalid.status,0);
  }
});

test('git exclusions remove experiment trees while ignored engine metadata remains visible',t=>{
  const root=fixture(t,{'.gitignore':'experiments/\n.claude/\n.opencode/\n',
    'package.json':{scripts:{test:'node --test'}},
    'experiments/copy/package.json':{scripts:{wrong:'must not be inventoried'}},
    '.claude/skills/owned/SKILL.md':'---\nname: owned\ndescription: Project skill\n---\nRead code.',
    '.opencode/plugins/own-safety-guard.js':'export const Guard = async () => ({})',
  });
  assert.equal(spawnSync('git',['init',root],{encoding:'utf8'}).status,0);
  const before=tree(root),result=scanProject(root);
  assert.deepEqual(tree(root),before);
  assert.equal(result.inventory.scope,'git-files-and-engine-metadata');
  assert.equal(result.inventory.checks.some(check=>check.path.startsWith('experiments/')),false);
  assert.ok(result.inventory.tools.some(tool=>tool.name==='owned'));
  assert.ok(result.conflicts.some(conflict=>conflict.path==='.opencode/plugins/own-safety-guard.js'));
});
