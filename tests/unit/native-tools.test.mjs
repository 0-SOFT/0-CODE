import test from 'node:test';
import assert from 'node:assert/strict';
import { compileNativeTool, toolHeader } from '../../core/native-tools.mjs';
test('real markdown fields handle folded/literal descriptions while leaving the instruction body intact',()=>{
  for(const [block,expected] of [['>','first second'],['|','first\nsecond']]) {
    const result=toolHeader(Buffer.from(`---\nname: one\ndescription: ${block}-\n  first\n  second\nmodel: inherited\n---\n# Actual body\n`));
    assert.equal(result.fields.description,expected);assert.equal(result.body,'\n# Actual body\n');
  }
  assert.deepEqual(toolHeader(Buffer.from('# Plain command')), {fields:{},body:'# Plain command'});
  assert.equal(toolHeader(Buffer.from('---\ndescription: first line\n  second line\norigin: ECC\n---\n')).fields.description,'first line second line');
  assert.throws(()=>toolHeader(Buffer.from([255])),/UTF-8/);assert.throws(()=>toolHeader(Buffer.from('bad\0text')),/UTF-8/);
});
test('native compiler preserves references and reports metadata losses without transferring models or tool names',()=>{
  const fields={description:'Project architecture',model:'opus',tools:['Read'],origin:'project'};
  for(const engine of ['claude','codex','opencode']) for(const kind of ['skills','agents','commands']) {
    const result=compileNativeTool({engine,kind,name:'example',source:'.0-code/toolset/example.md',fields});
    assert.ok(result.bytes.includes(Buffer.from('.0-code/toolset/example.md')));
    assert.equal(result.bytes.includes(Buffer.from('opus')),false);assert.deepEqual(result.dropped,['model','origin','tools']);
    if(engine==='codex'&&kind==='agents') {assert.equal(result.path,'.codex/agents/example.toml');assert.equal(result.registration.file,'agents/example.toml');}
    if(engine==='codex'&&kind==='commands') assert.equal(result.path,'.agents/skills/command-example/SKILL.md');
    if(engine==='claude'&&kind==='agents') {const parsed=toolHeader(result.bytes).fields;assert.equal(parsed.name,'example');assert.equal(parsed.model,undefined);}
  }
  assert.match(compileNativeTool({engine:'opencode',kind:'agents',name:'own',source:'opencode.json',selector:'agent.own.prompt'}).bytes.toString(),/agent.own.prompt/);
});
test('unrepresentable native names, unknown kinds and execution controls are explicit refusals',()=>{
  const base={engine:'codex',kind:'skills',name:'example',source:'file.md'};
  for(const patch of [{engine:'unknown'},{kind:'hooks'},{name:'../outside'},{name:'a'.repeat(65)},
    {fields:{hooks:{}}},{fields:{permission:{}}},{fields:{permissionMode:'plan'}},{fields:{disallowedTools:['Write']}},
    {fields:{mcpServers:{}}},{fields:{disable:true}},{fields:{'disable-model-invocation':true}}]) assert.throws(()=>compileNativeTool({...base,...patch}));
  assert.throws(()=>compileNativeTool({...base,kind:'commands',name:'a'.repeat(64)}),/limit/);
});
