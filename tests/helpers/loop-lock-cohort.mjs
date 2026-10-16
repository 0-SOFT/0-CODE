import { fork } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Real processes, one IPC start barrier, and explicit exit only after the parent has measured
// every result. Delaying the dead-owner probe widens the original read-before-write defect;
// it is a bounded test stimulus, never a production wait or an ownership time-to-live.
export async function lockCohort(projectDir, moduleUrl, { count = 16, delayMs = 300, workerSource = null } = {}) {
  const worker = join(projectDir, 'lock-worker.mjs');
  writeFileSync(worker, workerSource ?? `import {acquireLock,isPidAlive} from ${JSON.stringify(moduleUrl)};
const [projectDir,delay]=process.argv.slice(2);
process.on('message',message=>{
  if(message==='exit'){process.disconnect();return;}
  if(message!=='claim')return;
  try{
    const result=acquireLock({projectDir,sessionId:'cohort-'+process.pid,pidAlive:pid=>{
      if(pid!==999999999)return isPidAlive(pid);
      process.send({type:'observed'});
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(delay));return isPidAlive(pid);
    }});
    process.send({type:'result',pid:process.pid,...result});
  }catch(error){process.send({type:'error',message:error.stack});}
});
process.send({type:'ready',pid:process.pid});
`);
  const children = [], waiters = [], states = new Map();
  const startedAt=Date.now();
  function observe(child,index) {
    const state={messages:new Map(),waiters:new Set(),stderr:'',failure:null};
    states.set(child,state);
    const fail=error=>{
      state.failure=error;
      for(const waiter of [...state.waiters])waiter();
    };
    child.stderr.on('data',chunk=>{state.stderr=(state.stderr+chunk).slice(-8192);});
    child.on('error',error=>fail(error));
    child.on('exit',(code,signal)=>fail(new Error(`Worker ${index} PID ${child.pid} exited: ${code}/${signal}; stderr=${state.stderr}`)));
    child.on('message',message=>{
      if(message.type==='error')fail(new Error(`Worker ${index} PID ${child.pid}: ${message.message}; stderr=${state.stderr}`));
      else state.messages.set(message.type,message);
      for(const waiter of [...state.waiters])waiter();
    });
  }
  function waitFor(child,type) {
    const state=states.get(child);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(new Error(`Worker PID ${child.pid} did not report ${type} after ${Date.now()-startedAt} ms; stderr=${state.stderr}`)),15000);
      function finish(error,result) {
        clearTimeout(timer);state.waiters.delete(check);
        error?reject(error):resolve(result);
      }
      function check() {
        if(state.failure)finish(state.failure);
        else if(state.messages.has(type))finish(null,state.messages.get(type));
      }
      state.waiters.add(check);check();
    });
  }
  let observed = 0;
  try {
    for (let i = 0; i < count; i++) {
      const child = fork(worker, [projectDir, String(delayMs)], {
        execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
      });
      observe(child,i);
      child.on('message', message => { if (message.type === 'observed') observed++; });
      children.push(child); waiters.push(waitFor(child, 'ready'));
    }
    await Promise.all(waiters);
    const startupMs=Date.now()-startedAt;
    const results = children.map(child => waitFor(child, 'result'));
    for (const child of children) child.send('claim');
    const rows = await Promise.all(results);
    const allAlive = children.every(child => {
      try { process.kill(child.pid, 0); return true; } catch { return false; }
    });
    return { count, observed, startupMs,elapsedMs:Date.now()-startedAt,allAlive, rows, acquired: rows.filter(row => row.acquired).length };
  } finally {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill(); }, 1000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send('exit'); else child.kill();
    })));
  }
}
