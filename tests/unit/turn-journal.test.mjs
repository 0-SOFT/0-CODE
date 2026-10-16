import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadProjectConfig} from '../../core/project-config.mjs';
import {saveTurnJournal} from '../../core/turn-journal.mjs';
import {parseClaudeJson} from '../../core/backends/claude.mjs';
import {parseCodexEvents} from '../../core/backends/codex.mjs';
import {parseOpenCodeEvents} from '../../core/backends/opencode.mjs';
import {cleanupTempDir} from '../helpers/index.mjs';
function fixture(t,config={}) {
  const root=mkdtempSync(join(process.env.FRAMEWORK_TEST_TMPDIR||tmpdir(),'turn-journal-'));
  t.after(()=>cleanupTempDir(root));
  const project=loadProjectConfig({projectDir:root,config:{documents:{logs:{path:'evidence/turns',name:'<date>-<id>.jsonl'}},...config}});
  return {root,project,save:(record,options={})=>saveTurnJournal(project,record,{env:{},...options})};
}
test('real adapter parsers retain distinct result shapes in the configured journal role',t=>{
  const f=fixture(t);
  const codex=parseCodexEvents(readFileSync(new URL('../fixtures/codex/0.160.1-ok.jsonl',import.meta.url),'utf8'));
  const claude={ok:true,...parseClaudeJson(JSON.stringify({result:'OK',session_id:'claude-session',total_cost_usd:0.01}))};
  const opencode=parseOpenCodeEvents(JSON.stringify({type:'text',sessionID:'open-session',part:{text:'OK'}})+'\n');
  for(const [engine,turn] of [['claude',claude],['codex',codex],['opencode',opencode]]) {
    const path=f.save({engine,phase:'work',attempt:1,turn});
    assert.equal(dirname(path),join(f.root,'evidence/turns'));
    const record=JSON.parse(readFileSync(path,'utf8'));
    assert.equal(record.engine,engine);assert.deepEqual(record.turn,JSON.parse(JSON.stringify(turn)));
    assert.equal(record.accounting,false);assert.equal(record.source,'0-code-supervisor');
  }
  assert.equal(readdirSync(join(f.root,'evidence/turns')).length,3);
});
test('known env and project secrets are masked in strings, keys, nested events and errors',t=>{
  const f=fixture(t),a='fixture-exported-secret',b='fixture-file-secret';
  writeFileSync(join(f.root,'.env'),`FIXTURE_KEY='${b}'\n`);
  const path=f.save({engine:'codex',phase:'work',attempt:2,turn:{ok:false,error:a,raw:[{[b]:a}],output:b}},
    {env:{FIXTURE_TOKEN:a}});
  const bytes=readFileSync(path,'utf8');assert.ok(!bytes.includes(a));assert.ok(!bytes.includes(b));
  assert.match(bytes,/REDACTED/);
});
test('disabled journals create no files; collisions preserve ordinary foreign bytes',t=>{
  const disabled=fixture(t,{modules:{session_logs:false}});
  assert.equal(disabled.save({engine:'codex'}),null);assert.deepEqual(readdirSync(disabled.root),[]);
  const f=fixture(t),options={id:'fixed',now:new Date('2026-10-14T12:00:00Z')};
  const path=f.save({turn:{ok:false,error:'failed'}},options),before=readFileSync(path);
  assert.throws(()=>f.save({turn:{ok:true}},options),/Cannot create/);assert.deepEqual(readFileSync(path),before);
});
test('custom role templates without an ID remain unique and env read failures are visible',t=>{
  const f=fixture(t,{documents:{logs:{path:'logs',name:'<name>.jsonl'}}});
  assert.notEqual(f.save({attempt:1}),f.save({attempt:2}));
  mkdirSync(join(f.root,'config'));mkdirSync(join(f.root,'config/.env'));
  assert.throws(()=>f.save({attempt:3}),/redaction source/);
  assert.equal(readdirSync(join(f.root,'logs')).length,2);
});
test('logs parent link refusal propagates; native links are exercised when supported',t=>{
  const f=fixture(t),outside=mkdtempSync(join(process.env.FRAMEWORK_TEST_TMPDIR||tmpdir(),'foreign-logs-'));
  t.after(()=>cleanupTempDir(outside));mkdirSync(join(f.root,'evidence'));
  try {symlinkSync(outside,join(f.root,'evidence/turns'),process.platform==='win32'?'junction':'dir');}
  catch(error) {
    assert.ok(process.platform==='win32'&&['EISDIR','EPERM','ENOTSUP'].includes(error.code));
    t.diagnostic('This filesystem cannot create links; the real project-config path checks are covered separately.');
    f.project.documentPath=()=>{throw new Error('Document path uses a symlink');};
  }
  assert.throws(()=>f.save({attempt:1}),/symlink/);assert.deepEqual(readdirSync(outside),[]);
});
