import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonc } from '../../lib/jsonc.mjs';

test('JSONC comments and trailing commas do not change strings or escapes',()=>{
  const text='/* start */ {"uri":"https://example.invalid/a//b",\n"text":"escaped \\\" quote,}",// tail\n"items":[1,2, /* comment */],\n"literal":"/* untouched */",}\n';
  assert.deepEqual(parseJsonc(text),{uri:'https://example.invalid/a//b',text:'escaped \" quote,}',items:[1,2],literal:'/* untouched */'});
  assert.deepEqual(parseJsonc('{"empty": [], "boolean": true}'),{empty:[],boolean:true});
  assert.deepEqual(parseJsonc('{/* multiline\n block\r\n*/ "path":"a\\\\b"}'),{path:'a\\b'});
});
test('malformed strings, comments and objects are refused',()=>{
  for(const text of ['{"a":','/* missing end','{"a":"unfinished}','{a:1}','[1,,2]']) assert.throws(()=>parseJsonc(text));
});
