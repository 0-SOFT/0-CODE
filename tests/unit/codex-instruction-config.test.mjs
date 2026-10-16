import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {codexInstructionConfig,inspectCodexInstructionConfig} from '../../core/backends/codex-instruction-config.mjs';
import {validateCodexInstructions} from '../../core/backends/codex.mjs';
import {resolveEngineSettings} from '../../core/engine-settings.mjs';
import {cleanupTempDir} from '../helpers/index.mjs';

const response = budget => ({result:{config:{project_doc_max_bytes:budget??32768,
  project_doc_fallback_filenames:['GUIDE.md'],project_root_markers:['.root'],
  mcp_servers:{private:{env:{TOKEN:'fixture-private-rpc-value'}}}},
  layers:[{name:{type:'user'},config:budget===undefined?{model:'owner'}:{project_doc_max_bytes:budget}}]}});

test('native instruction metadata retains explicit limits without exposing unrelated private configuration',()=>{
  const implicit=codexInstructionConfig(response());assert.equal(implicit.inheritedInstructionBudget,false);
  const explicit=codexInstructionConfig(response(4096));assert.equal(explicit.inheritedInstructionBudget,true);
  assert.deepEqual(explicit.fallbackFilenames,['GUIDE.md']);assert.deepEqual(explicit.rootMarkers,['.root']);
  assert.ok(!JSON.stringify(explicit).includes('fixture-private-rpc-value'));
  const inline=response(65536);inline.result.layers=[{name:{type:'sessionFlags'},config:{project_doc_max_bytes:65536}}];
  assert.equal(codexInstructionConfig(inline).inlineInstructionBudget,true);
  for(const bad of [{}, {result:{config:{},layers:null}}, {result:{config:{project_root_markers:[1]},layers:[]}}])
    assert.throws(()=>codexInstructionConfig(bad),/Invalid Codex/);
});

test('resolving a selected zero again never reinstates a lower-priority environment limit',()=>{
  const selected=resolveEngineSettings('codex',{instructionsMaxBytes:0},{CODEX_INSTRUCTIONS_MAX_BYTES:'4000'});
  assert.equal(selected.instructionsLimitSpecified,true);assert.equal(selected.instructionsMaxBytes,undefined);
  assert.equal(resolveEngineSettings('codex',selected,{CODEX_INSTRUCTIONS_MAX_BYTES:'4000'}).instructionsMaxBytes,undefined);
});

function fixture(t){const root=process.env.FRAMEWORK_TEST_TMPDIR||tmpdir();mkdirSync(root,{recursive:true});
  const base=mkdtempSync(join(root,'instruction-config-'));t.after(()=>cleanupTempDir(base));return base;}

test('instruction collection uses the native root markers and custom fallback filenames',t=>{
  const root=fixture(t),project=join(root,'nested');mkdirSync(project);mkdirSync(join(project,'.git'));
  writeFileSync(join(root,'.root'),'');writeFileSync(join(root,'AGENTS.md'),'Root instructions\n');
  writeFileSync(join(project,'GUIDE.md'),'Custom instruction tail\n');
  const result=validateCodexInstructions(project,{rootMarkers:['.root'],fallbackFilenames:['GUIDE.md']});
  assert.deepEqual(result.files,[join(root,'AGENTS.md'),join(project,'GUIDE.md')]);
  assert.match(result.content,/Custom instruction tail/);
  assert.throws(()=>validateCodexInstructions(project,{rootMarkers:['.root'],fallbackFilenames:['GUIDE.md'],maxBytes:1}),/configured limit/);
});

test('the real child-process handshake assembles partial RPC messages and closes after config/read',async t=>{
  const root=fixture(t),peer=join(root,'rpc-peer.mjs'),data=join(root,'response.json');
  writeFileSync(data,JSON.stringify(response(4096)));
  writeFileSync(peer,`import {createInterface} from 'node:readline';import{readFileSync}from'node:fs';
    const response=JSON.parse(readFileSync(process.argv[2],'utf8'));
    const mode=process.argv[3];let initialised=false;
    createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
      if(m.method==='initialize'){initialised=true;console.log(JSON.stringify({id:m.id,result:{}}));}
      if(m.method==='config/read'){if(!initialised)process.exit(3);
        const r=mode==='error'?{id:m.id,error:{message:'fixture-private-rpc-value'}}:{id:m.id,...response};
        const text=JSON.stringify(r)+'\\n';process.stdout.write(text.slice(0,10));
        setTimeout(()=>process.stdout.write(text.slice(10)),5);}
    });`);
  const command={bin:process.execPath,args:[peer,data]};
  const result=await inspectCodexInstructionConfig({command,cwd:root,env:process.env});
  assert.equal(result.inheritedInstructionBudget,true);assert.ok(!JSON.stringify(result).includes('fixture-private-rpc-value'));
  await assert.rejects(inspectCodexInstructionConfig({command:{...command,args:[...command.args,'error']},cwd:root,env:process.env}),
    error=>{assert.match(error.message,/Invalid Codex/);assert.ok(!error.message.includes('fixture-private-rpc-value'));return true;});
});
