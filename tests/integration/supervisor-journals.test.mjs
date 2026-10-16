import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runLoop} from '../../core/supervisor.mjs';
import {mkTempProject} from '../helpers/index.mjs';
function config(root,enabled=true) {
  mkdirSync(join(root,'.0-code/run'),{recursive:true});
  writeFileSync(join(root,'.0-code/config.json'),JSON.stringify({engines:['claude','codex','opencode'],
    modules:{session_logs:enabled,telegram:false},documents:{logs:{path:'evidence/attempts',name:'<id>-<date>.jsonl'}}}));
}
test('supervisor saves preflight and working errors, retries and exceptions for all engines',async()=>{
  for(const engine of ['claude','codex','opencode']) {
    const p=mkTempProject({current_version:'1',next_step_prompt:'go'}),root=dirname(dirname(p.stateFile));
    try {
      config(root);let call=0;
      const backend={id:engine,async runTurn(){
        call++;
        if(call===1)throw new Error('os error 11001');
        if(call===3)return {ok:false,error:'HTTP 503'};
        return {ok:true,output:'OK',sessionId:engine+'-session',usage:{input:1,output:1},usageTotal:{input:1,output:1}};
      }};
      const result=await runLoop({projectDir:root,stateFile:p.stateFile,backend,useLock:false,maxLoops:1,sleep:async()=>{}});
      assert.equal(result.loops,1);
      const rows=readdirSync(join(root,'evidence/attempts')).map(name=>JSON.parse(readFileSync(join(root,'evidence/attempts',name),'utf8')));
      assert.equal(rows.length,4);
      assert.deepEqual(rows.map(row=>[row.phase,row.attempt,row.turn.ok]).sort(),
        [['preflight',1,false],['preflight',2,true],['work',1,false],['work',2,true]].sort());
      assert.ok(rows.every(row=>row.engine===engine&&row.supervisor_session));
    } finally {p.cleanup();}
  }
});
test('disabled supervisor logs stay absent; a storage failure is visible before continuation',async()=>{
  const p=mkTempProject({current_version:'1',next_step_prompt:'go'}),root=dirname(dirname(p.stateFile));
  try {
    config(root,false);
    const backend={id:'claude',async runTurn(){return {ok:true,output:'OK'};}};
    await runLoop({projectDir:root,stateFile:p.stateFile,backend,useLock:false,usePreflight:false,maxLoops:1});
    assert.ok(!readdirSync(root).includes('evidence'));
    config(root);writeFileSync(join(root,'evidence'),'foreign bytes');
    await assert.rejects(runLoop({projectDir:root,stateFile:p.stateFile,backend,useLock:false,usePreflight:false,maxLoops:1}),/journal could not be saved/);
    assert.equal(readFileSync(join(root,'evidence'),'utf8'),'foreign bytes');
  } finally {p.cleanup();}
});
test('supervisor journals do not disguise empty turns as project progress',async()=>{
  const p=mkTempProject({current_version:'1',next_step_prompt:'go',roadmap_review_every:0}),root=dirname(dirname(p.stateFile));
  try {
    config(root);
    const git=args=>{const result=spawnSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);};
    git(['init','-q']);writeFileSync(join(root,'.gitignore'),'.0-code/run/\ndocs/.turn-progress.json\n');
    git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','initial']);
    const backend={id:'claude',async runTurn(){return {ok:true,output:'OK'};}};
    const result=await runLoop({projectDir:root,stateFile:p.stateFile,backend,useLock:false,usePreflight:false,maxLoops:5});
    assert.equal(result.stopped,'no_progress');assert.equal(result.loops,3);
    assert.equal(readdirSync(join(root,'evidence/attempts')).length,3);
  } finally {p.cleanup();}
});
