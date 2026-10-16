// A real writer stopped by its parent after the first committed application file.
import fs from 'node:fs';
import {basename} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import { InstallationPlan } from '../../core/installation-transaction.mjs';
import { applyInstallationGroup } from '../../core/installation-group.mjs';
const rename=fs.renameSync;
fs.renameSync=(source,target)=>{
  rename(source,target);
  if(basename(target)==='checkpoint')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
};
syncBuiltinESMExports();
const roots=process.argv.slice(2),plans=roots.map(root=>{
  const plan=new InstallationPlan(root);plan.change('checkpoint','new checkpoint');
  plan.change('settings.json','installed fixture',{overwrite:true});
  for(let index=0;index<64;index++)plan.change('pending/'+String(index)+'.bin',Buffer.alloc(256*1024,index));
  return plan;
});
applyInstallationGroup(plans,{primary:roots[0]});
