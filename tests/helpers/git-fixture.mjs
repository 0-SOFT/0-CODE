import {spawnSync} from 'node:child_process';
import {lstatSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';

const MAX_CLONE_ATTEMPTS=3;
const RETRY_PAUSE_MS=25;
const pause=new Int32Array(new SharedArrayBuffer(4));

function pathExists(path) {
  try {lstatSync(path);return true;}
  catch(error) {if(error.code==='ENOENT')return false;throw error;}
}

export function isTransientCloneLock(result,target,platform=process.platform) {
  if(platform!=='win32'||result.status!==128||result.error||result.signal)return false;
  const config=join(resolve(target),'.git','config').replaceAll('\\','/');
  const lines=String(result.stderr||'').replaceAll('\\','/').split(/\r?\n/);
  return lines.includes(`error: could not lock config file ${config}: File exists`)
    &&lines.includes("fatal: could not set 'core.repositoryformatversion' to '0'");
}

// Never remove a surviving destination or lock; a retry can use a fresh sibling fixture.
// Fixtures inject failures or wrap actual Git; successful integration clones always come from Git.
export function cloneFixtureRepository(source,target,{
  cwd=dirname(target),env=process.env,onRetry=()=>{},onAttempt=()=>{},launch=spawnSync,platform=process.platform,
}={}) {
  const initiallyOccupied=pathExists(target);let destination=target,last;
  for(let attempt=1;attempt<=MAX_CLONE_ATTEMPTS;attempt++) {
    if(attempt>1&&pathExists(destination))return last;
    const result=launch('git',['-c','core.autocrlf=true','clone',source,destination],
      {cwd,env,encoding:'utf8',windowsHide:true});
    last={...result,destination};
    const occupied=pathExists(destination),transient=isTransientCloneLock(result,destination,platform);
    onAttempt({attempt,destination,status:result.status,signal:result.signal??null,errorCode:result.error?.code??null,occupied,transient});
    if(attempt===MAX_CLONE_ATTEMPTS||!transient||initiallyOccupied)return last;
    const next=occupied?target+'-retry-'+randomUUID():destination;
    onRetry({attempt,status:result.status,stderr:result.stderr,destination,next,preserved:occupied});
    destination=next;
    Atomics.wait(pause,0,0,RETRY_PAUSE_MS);
  }
}
