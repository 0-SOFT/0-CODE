// Test-only observation of real installer I/O. No timers emit artificial activity.
// A slow default install is active while it performs filesystem work; a silent hang is not.
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
let lastReport=0;
for(const name of ['lstatSync','readFileSync','writeFileSync','mkdirSync','renameSync']) {
  const original=fs[name];
  fs[name]=function(...args) {
    try {return original.apply(this,args);}
    finally {
      const now=Date.now();
      if(now-lastReport>=1000) {
        lastReport=now;
        process.stderr.write('__BOOTSTRAP_FS_PROGRESS__\n');
      }
    }
  };
}
syncBuiltinESMExports();
