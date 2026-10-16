import test from 'node:test';
import assert from 'node:assert/strict';
import { addNativeJsonEntries, stripNativeJsonEntries, addNativeJsonChanges, stripNativeJsonChanges } from '../../lib/native-json.mjs';
import { parseJsonc } from '../../lib/jsonc.mjs';
test('native JSON edits preserve project text, comments and credentials while adding only absent entries',()=>{
  for(const source of ['{\r\n// Owner text\r\n"mcp":{"own":{"type":"local","command":["node"]}},\r\n"owner":"private-fixture",\r\n}\r\n','{"owner":"private-fixture"}','{"mcp":{}}','{"mcp":{"own":{},}}']) {
    const before=Buffer.from(source),added=addNativeJsonEntries(before,'mcp',{managed:{type:'local',command:['node','managed.mjs']}});
    if(source.includes('// Owner text')) assert.ok(added.bytes.toString().includes('// Owner text\r\n'));
    if(source.includes('"owner":"private-fixture"')) assert.ok(added.bytes.toString().includes('"owner":"private-fixture"'));
    if(source.includes('"own":{"type":"local","command":["node"]}')) assert.ok(added.bytes.toString().includes('"own":{"type":"local","command":["node"]}'));
    assert.equal(parseJsonc(added.bytes.toString()).owner,parseJsonc(source).owner);
    assert.deepEqual(parseJsonc(stripNativeJsonEntries(added.bytes,added.patch).toString()),parseJsonc(source));
  }
});
test('removing owned native entries retains later owner edits and refuses changed entries or duplicate declarations',()=>{
  const added=addNativeJsonEntries(Buffer.from('{"model":"owner"}'),'mcp',{one:{command:'node'},two:{command:'node'}});
  const changed=Buffer.from(added.bytes.toString().replace('"owner"','"new-owner"'));
  assert.deepEqual(parseJsonc(stripNativeJsonEntries(changed,added.patch).toString()),{model:'new-owner'});
  const extended=Buffer.from(added.bytes.toString().replace('"two":{"command":"node"}','"two":{"command":"node"},"new":{"command":"owner-tool"}'));
  assert.deepEqual(parseJsonc(stripNativeJsonEntries(extended,added.patch).toString()),{model:'owner',mcp:{new:{command:'owner-tool'}}});
  assert.throws(()=>stripNativeJsonEntries(Buffer.from(added.bytes.toString().replace('"one":{"command":"node"}','"one":{"command":"different"}')),added.patch),/changed/);
  for(const bytes of [Buffer.from('{"mcp":{},"mcp":{}}'),Buffer.from('{"mcp":[]}'),Buffer.from('{"private-fixture"'),Buffer.from([0xff])])
    assert.throws(()=>addNativeJsonEntries(bytes,'mcp',{one:{}}),error=>!error.message.includes('private-fixture'));
  assert.throws(()=>addNativeJsonEntries(Buffer.from('{"mcp":{"one":{}}}'),'mcp',{one:{}}),/belongs/);
});

test('nested native additions preserve owner bytes and remove only verified values and hook groups',()=>{
  const original=Buffer.from('{\r\n"owner":"private-fixture", "hooks":{"PreToolUse":[]}, "enabledMcpjsonServers":["own",],\r\n}\r\n');
  const added=addNativeJsonChanges(original,{values:[{path:['env','CAP'],value:'200'}],arrays:[
    {path:['hooks','PreToolUse'],values:[{matcher:'*',hooks:[{command:'guard'}]}]},
    {path:['hooks','Stop'],values:[{hooks:[{command:'loop'}]}]},
    {path:['enabledMcpjsonServers'],values:['managed']}]});
  assert.ok(added.bytes.toString().startsWith('{\r\n"owner":"private-fixture", '));
  assert.equal(JSON.stringify(added.patch).includes('private-fixture'),false);
  assert.deepEqual(parseJsonc(stripNativeJsonChanges(added.bytes,added.patch).toString()),parseJsonc(original.toString()));
  const later=parseJsonc(added.bytes.toString());later.env.LOCAL='owner';later.hooks.Stop.push({hooks:[{command:'own-later'}]});later.new='owner';
  const recovered=parseJsonc(stripNativeJsonChanges(Buffer.from(JSON.stringify(later)),added.patch).toString());
  assert.deepEqual(recovered,{owner:'private-fixture',hooks:{PreToolUse:[],Stop:[{hooks:[{command:'own-later'}]}]},enabledMcpjsonServers:['own'],env:{LOCAL:'owner'},new:'owner'});
  for(const change of [data=>data.env.CAP='300',data=>data.hooks.Stop=[],data=>data.hooks.PreToolUse.push(data.hooks.PreToolUse[0])]) {
    const data=parseJsonc(added.bytes.toString());change(data);assert.throws(()=>stripNativeJsonChanges(Buffer.from(JSON.stringify(data)),added.patch),/changed/);
  }
  assert.throws(()=>addNativeJsonChanges(original,{values:[{path:['owner'],value:'replace'}]}),/belongs/);
  for(const changes of [{values:[{path:[],value:1}]},{values:[{path:['owner','sub'],value:1}]},{arrays:[{path:['owner'],values:[1]}]},{arrays:[{path:['items'],values:[]}]}])
    assert.throws(()=>addNativeJsonChanges(original,changes));
  assert.throws(()=>stripNativeJsonChanges(added.bytes,{type:'native-json-delta'}));
});
