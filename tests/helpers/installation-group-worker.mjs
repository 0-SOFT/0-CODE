// A real writer stopped by its parent after the first committed application file.
import { InstallationPlan } from '../../core/installation-transaction.mjs';
import { applyInstallationGroup } from '../../core/installation-group.mjs';
const roots=process.argv.slice(2),plans=roots.map(root=>{
  const plan=new InstallationPlan(root);plan.change('checkpoint','new checkpoint');
  plan.change('settings.json','installed fixture',{overwrite:true});
  for(let index=0;index<64;index++)plan.change('pending/'+String(index)+'.bin',Buffer.alloc(256*1024,index));
  return plan;
});
applyInstallationGroup(plans,{primary:roots[0]});
