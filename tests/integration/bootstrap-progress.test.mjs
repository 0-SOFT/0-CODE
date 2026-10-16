import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runCliAsync} from '../../core/backends/spawn-cli.mjs';
const observer=pathToFileURL(fileURLToPath(new URL('../helpers/bootstrap-progress.mjs',import.meta.url))).href;
test('bootstrap observer keeps real filesystem work alive beyond the silence limit',async()=>{
  const result=await runCliAsync(process.execPath,['--import',observer,'--input-type=module','-e',
    `import {readFileSync} from 'node:fs';let count=0;
     const timer=setInterval(()=>{readFileSync(process.argv[1]);if(++count===8)clearInterval(timer);},1000);`,
    fileURLToPath(new URL('../../VERSION',import.meta.url))],{idleTimeoutMs:5000,timeoutMs:30000});
  assert.equal(result.status,0,result.stderr);assert.equal(result.timedOut,false);
  assert.match(result.stderr,/__BOOTSTRAP_FS_PROGRESS__/);
});
test('bootstrap observer emits no timer heartbeat for an actually idle child',async()=>{
  const result=await runCliAsync(process.execPath,['--import',observer,'--input-type=module','-e',
    'setTimeout(()=>{},60000);'],{idleTimeoutMs:2000,timeoutMs:30000});
  assert.equal(result.timedOut,true);assert.notEqual(result.status,0);
  assert.doesNotMatch(result.stderr,/__BOOTSTRAP_FS_PROGRESS__/);
  assert.equal(result.cleanupRefused,undefined);
});
