import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveUserProfiles, compileUserTool, nativeUserFile } from '../../core/user-profiles.mjs';
import { parseToml } from '../../lib/toml-mini.mjs';
import { toolHeader } from '../../core/native-tools.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
const repo=fileURLToPath(new URL('../../',import.meta.url)),base=join(dirname(repo.replace(/[\\/]$/,'')),'scratch','tmp');mkdirSync(base,{recursive:true});
function fixture(t) {const home=mkdtempSync(join(base,'user-profile-'));t.after(()=>cleanupTempDir(home));return home;}
test('native defaults and independent environment directories resolve without reading or writing owner files',t=>{
  const home=fixture(t),defaults=resolveUserProfiles({env:{},home});
  assert.equal(defaults.claude.root,join(home,'.claude'));assert.deepEqual(defaults.claude.mcp,{root:home,path:'.claude.json'});
  assert.equal(defaults.codex.root,join(home,'.codex'));assert.equal(defaults.opencode.root,join(home,'.config','opencode'));
  const env={CLAUDE_CONFIG_DIR:join(home,'claude'),CODEX_HOME:join(home,'codex'),XDG_CONFIG_HOME:join(home,'xdg'),
    OPENCODE_CONFIG_DIR:join(home,'extra'),OPENCODE_CONFIG:join(home,'owner.json')};
  const profiles=resolveUserProfiles({env,home});assert.deepEqual(profiles.claude.mcp,{root:env.CLAUDE_CONFIG_DIR,path:'.claude.json'});
  assert.equal(profiles.codex.root,env.CODEX_HOME);assert.equal(profiles.opencode.root,join(env.XDG_CONFIG_HOME,'opencode'));
  assert.deepEqual(profiles.opencode.additional,{directory:env.OPENCODE_CONFIG_DIR,config:env.OPENCODE_CONFIG});
  assert.equal(nativeUserFile(profiles,'codex','agents/0-code-test.toml'),join(env.CODEX_HOME,'agents','0-code-test.toml'));
  assert.throws(()=>nativeUserFile(profiles,'codex','../auth.json'));assert.throws(()=>nativeUserFile(profiles,'other','agent.md'),/Unknown/);
  assert.throws(()=>resolveUserProfiles({env:{CODEX_HOME:'unsafe\0value'},home}),/Invalid/);
  assert.deepEqual(readdirSync(home),[]);
});
test('user wrappers reuse native formats and refer to one absolute source without duplicating its instructions',t=>{
  const home=fixture(t),source=join(home,'pool','.0-code','toolset','skills','fixture','SKILL.md');
  for(const engine of ['claude','codex','opencode'])for(const kind of ['skills','agents','commands']) {
    const compiled=compileUserTool({engine,kind,name:'0-code-fixture',source,fields:{description:'Fixture description',model:'owner-model'}});
    assert.ok(!compiled.path.startsWith('.'));
    const instructions=engine==='codex'&&kind==='agents'?parseToml(compiled.bytes.toString()).developer_instructions:toolHeader(compiled.bytes).body;
    assert.ok(instructions.includes(JSON.stringify(source)));
    assert.deepEqual(compiled.dropped,['model']);
    if(engine==='codex'&&kind==='agents') {
      assert.equal(compiled.registration.file,'agents/0-code-fixture.toml');assert.ok(parseToml(compiled.bytes.toString()).developer_instructions);
    } else assert.equal(toolHeader(compiled.bytes).fields.description,'Fixture description');
  }
  assert.equal(compileUserTool({engine:'codex',kind:'commands',name:'0-code-fixture',source}).path,'skills/command-0-code-fixture/SKILL.md');
  assert.equal(compileUserTool({engine:'opencode',kind:'commands',name:'0-code-fixture',source}).path,'commands/0-code-fixture.md');
  assert.equal(compileUserTool({engine:'claude',kind:'skills',name:'0-code-fixture',source}).path,'skills/0-code-fixture/SKILL.md');
  assert.throws(()=>compileUserTool({engine:'codex',kind:'skills',name:'0-code-fixture',source:'.0-code/skill.md'}),/absolute file/);
  assert.deepEqual(readdirSync(home),[]);
});
