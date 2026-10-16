import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { InstallationPlan, applyInstallationPlan, fileSnapshot, hashBytes, recoverInstallation } from '../../core/installation-transaction.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const scratch=join(dirname(root.replace(/[\\/]$/,'')),'scratch','tmp');mkdirSync(scratch,{recursive:true});
function fixture(t) { const dir=mkdtempSync(join(scratch,'transaction-'));t.after(()=>cleanupTempDir(dir));return dir; }
function put(root,path,bytes) {mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),bytes);}

test('a conflicting plan leaves every project byte and directory untouched',t=>{
  const root=fixture(t);put(root,'AGENTS.md','own rules\r\n');
  const plan=new InstallationPlan(root);plan.change('.0-code/VERSION','2.0.0\n');plan.change('AGENTS.md','replacement');
  assert.throws(()=>applyInstallationPlan(plan),/intersections/);
  assert.deepEqual(readdirSync(root),['AGENTS.md']);assert.equal(readFileSync(join(root,'AGENTS.md'),'utf8'),'own rules\r\n');
});
test('successful transaction creates, appends and deletes using the observed original bytes',t=>{
  const root=fixture(t);put(root,'AGENTS.md','own rules\r\n');put(root,'obsolete.txt','obsolete');
  const plan=new InstallationPlan(root);plan.change('.0-code/VERSION','2.0.0\n');
  plan.change('AGENTS.md','own rules\r\n\nframework link\n',{overwrite:true});plan.change('obsolete.txt',null,{overwrite:true});
  assert.equal(applyInstallationPlan(plan).changed,3);
  assert.equal(readFileSync(join(root,'.0-code/VERSION'),'utf8'),'2.0.0\n');assert.equal(existsSync(join(root,'obsolete.txt')),false);
  assert.equal(readFileSync(join(root,'.0-code/run/.gitignore'),'utf8'),'*\n');
  assert.equal(existsSync(join(root,'.0-code/run/installation-transaction.json')),false);
  assert.deepEqual(plan.summary().map(entry=>entry.operation),['create','update','remove']);
  assert.deepEqual(recoverInstallation(root),{recovered:false});
});
test('same bytes are a no-op; stale ownership and edits after planning refuse before writing',t=>{
  const root=fixture(t);put(root,'keep.txt','first');
  const noop=new InstallationPlan(root);assert.equal(noop.change('keep.txt','first'),false);assert.equal(applyInstallationPlan(noop).changed,0);
  assert.equal(existsSync(join(root,'.0-code')),false);
  const stale=new InstallationPlan(root);stale.change('keep.txt','second',{overwrite:true,expectedHash:hashBytes(Buffer.from('old'))});
  assert.throws(()=>applyInstallationPlan(stale),/intersections/);
  const changed=new InstallationPlan(root);changed.change('keep.txt','second',{overwrite:true});put(root,'keep.txt','editor change');
  assert.throws(()=>applyInstallationPlan(changed),/target changed/);assert.equal(readFileSync(join(root,'keep.txt'),'utf8'),'editor change');
});
test('directory and parent-child intersections cannot cause a partial installation',t=>{
  const root=fixture(t);mkdirSync(join(root,'directory'));
  assert.throws(()=>new InstallationPlan(root).change('directory','bytes'),/ordinary/);
  const overlap=new InstallationPlan(root);overlap.change('file','bytes');overlap.change('file/child','bytes');
  assert.throws(()=>applyInstallationPlan(overlap),/overlap/);assert.equal(existsSync(join(root,'file')),false);
  assert.throws(()=>new InstallationPlan(root).change('../outside','bytes'));
  assert.throws(()=>new InstallationPlan(root).change('.git/config','bytes'));
  assert.throws(()=>new InstallationPlan(root).change('.0-code/run/installation-transaction.json','bytes'),/internals/);
});
function crashJournal(root,{edited=false}={}) {
  const before=Buffer.from('original private settings\r\n'),after=Buffer.from('installed settings');
  put(root,'settings.json',edited?'later edit':after);put(root,'added.txt','new file');
  const journal={schema_version:1,missingDirectories:['.0-code','.0-code/run'],changes:[
    {path:'settings.json',before:before.toString('base64'),beforeHash:hashBytes(before),beforeMode:0o644,afterHash:hashBytes(after)},
    {path:'added.txt',before:null,beforeHash:null,beforeMode:null,afterHash:hashBytes(Buffer.from('new file'))},
  ]};put(root,'.0-code/run/installation-transaction.json',JSON.stringify(journal));return before;
}
test('real files from an interrupted transaction restore exactly and remove added files',t=>{
  const root=fixture(t),before=crashJournal(root);
  assert.deepEqual(recoverInstallation(root),{recovered:true,files:2});
  assert.deepEqual(readFileSync(join(root,'settings.json')),before);assert.equal(existsSync(join(root,'added.txt')),false);
  assert.equal(existsSync(join(root,'.0-code')),false);
});
test('recovery detects edits and active locks without overwriting or discarding its journal',t=>{
  const root=fixture(t);crashJournal(root,{edited:true});assert.throws(()=>recoverInstallation(root),/intersection/);
  assert.equal(readFileSync(join(root,'settings.json'),'utf8'),'later edit');assert.equal(existsSync(join(root,'added.txt')),true);
  put(root,'.0-code/run/installation.lock/owner.json',JSON.stringify({pid:process.pid,host:hostname()}));assert.throws(()=>recoverInstallation(root),/active/);
  assert.equal(existsSync(join(root,'.0-code/run/installation-transaction.json')),true);
});
test('recovery releases a lock only when its recorded local process has really exited',t=>{
  const root=fixture(t);crashJournal(root);
  const exited=spawnSync(process.execPath,['--version'],{encoding:'utf8'});assert.equal(exited.status,0);
  put(root,'.0-code/run/installation.lock/owner.json',JSON.stringify({pid:exited.pid,host:hostname()}));
  assert.equal(recoverInstallation(root).recovered,true);assert.equal(existsSync(join(root,'.0-code')),false);
});
test('malformed recovery journals and a foreign runtime ignore cannot be applied',t=>{
  const root=fixture(t);put(root,'.0-code/run/installation-transaction.json','{"schema_version":1}');
  assert.throws(()=>recoverInstallation(root),/Invalid/);
  const other=fixture(t);put(other,'.0-code/run/.gitignore','project-owned ignore');const plan=new InstallationPlan(other);plan.change('new','text');
  assert.throws(()=>applyInstallationPlan(plan),/intersects/);assert.equal(existsSync(join(other,'new')),false);
  assert.equal(fileSnapshot(other,'absent').hash,null);
});
