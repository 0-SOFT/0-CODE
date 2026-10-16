// Every interruption follows a real filesystem operation in this disposable child.
import fs from 'node:fs';
import {basename,dirname} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {InstallationPlan,applyInstallationPlan,recoverInstallation} from '../../core/installation-transaction.mjs';
import {applyInstallationGroup,recoverInstallationGroup} from '../../core/installation-group.mjs';
const [mode,phase,...roots]=process.argv.slice(2),write=fs.writeFileSync;
fs.writeFileSync=(path,data,options)=>{
  const entryStage=typeof path==='string'&&/^\.0code-.*\.tmp$/.test(basename(path))&&basename(dirname(path))==='pending';
  const rollbackStage=typeof path==='string'&&/^\.0code-.*\.tmp$/.test(basename(path))&&Buffer.from(data).toString('utf8')==='Owner settings\r\n';
  if(phase==='collide-owner-hardlink'&&typeof path==='string'&&path.endsWith('.staging-conflict')) {
    const owner=dirname(path)+'/installation.lock/owner.json',external=roots.find(root=>owner.startsWith(root))+'/shared-owner.json';
    fs.renameSync(owner,external);fs.linkSync(external,owner);
    throw Object.assign(new Error('fixture refuses sidecar after hardlink replacement'),{code:'EACCES'});
  }
  if(phase==='collide-sidecar-failure'&&typeof path==='string'&&path.endsWith('.staging-conflict'))
    throw Object.assign(new Error('fixture directory refuses a new conflict sidecar'),{code:'EACCES'});
  if(['collide','collide-sidecar-failure','collide-owner-hardlink'].includes(phase)&&entryStage
    ||['collide-recovery','collide-rollback'].includes(phase)&&rollbackStage)write(path,data,{flag:'wx'});
  write(path,data,options);
  if(phase==='collide-rollback'&&entryStage)throw Object.assign(new Error('real forward stage written before fixture I/O failure'),{code:'EIO'});
  if(phase==='mutate'&&entryStage){write(path,'Owner changed after stage write');return;}
  if(typeof path!=='string'||!/^\.0code-.*\.tmp$/.test(basename(path)))return;
  const text=Buffer.from(data).toString('utf8');
  if(phase==='entry'&&basename(dirname(path))==='pending'
    ||phase==='recovery'&&text==='Owner settings\r\n'
    ||phase==='ignore'&&text==='*\n'
    ||phase==='commit'&&text.includes('"phase":"committed"')) {
    fs.writeSync(1,JSON.stringify({phase,path})+'\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
  }
};
syncBuiltinESMExports();
if(mode==='group-recover')recoverInstallationGroup(roots[0],roots);
else if(mode==='single-recover')recoverInstallation(roots[0]);
else {
  const plans=roots.map(root=>{
    const plan=new InstallationPlan(root);
    plan.change('settings.json','Installed settings',{overwrite:true});
    plan.change('pending/0.bin',Buffer.alloc(256*1024,7));
    return plan;
  });
  if(mode==='group')applyInstallationGroup(plans,{primary:roots[0]});
  else applyInstallationPlan(plans[0]);
}
