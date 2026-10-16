import {runCliAsync} from '../../core/backends/spawn-cli.mjs';
// Preserve the real shell, arguments, configuration and default module selection.
export async function runBootstrap(command,args,{env=process.env,cwd}={}) {
  const result=await runCliAsync(command,args,{cwd,env:{...env,
    NODE_OPTIONS:[env.NODE_OPTIONS||'','--import='+new URL('./bootstrap-progress.mjs',import.meta.url).href].filter(Boolean).join(' ')},
    idleTimeoutMs:30000,timeoutMs:300000});
  return {...result,stderr:result.stderr.replace(/__BOOTSTRAP_FS_PROGRESS__\r?\n/g,'')};
}
