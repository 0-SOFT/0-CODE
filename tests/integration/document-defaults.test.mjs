import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCUMENT_DEFAULTS, LEGACY_DOCUMENT_DEFAULTS, loadProjectConfig } from '../../core/project-config.mjs';
import { installProject, readInstallationReceipt, uninstallProject, upgradeProject } from '../../core/project-installation.mjs';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';

const repository=fileURLToPath(new URL('../../',import.meta.url));
const scratch=join(dirname(repository.replace(/[\\/]$/,'')),'scratch','tmp');
const config={engines:['claude'],modules:Object.fromEntries(Object.keys(PROJECT_MODULES).map(id=>[id,false]))};
function fixture(t) {
  mkdirSync(scratch,{recursive:true});
  const root=mkdtempSync(join(scratch,'document-defaults-'));t.after(()=>cleanupTempDir(root));
  return root;
}

test('all nine default roles persist through upgrade, uninstall and reinstall without touching product docs',t=>{
  const root=fixture(t);
  mkdirSync(join(root,'docs'));
  const product=Buffer.from('# Product state\r\nOwner bytes.  \r\n');
  writeFileSync(join(root,'docs/STATE.md'),product);
  installProject(root,{config});
  const project=loadProjectConfig({projectDir:root});
  assert.deepEqual(project.config.documents,DOCUMENT_DEFAULTS);
  const files=new Map();
  for(const [role,document] of Object.entries(DOCUMENT_DEFAULTS)) {
    const path=project.documentPath(role,document.name?{version:'2.1.0',name:'proof',date:'2026-10-18',id:'fixture'}:undefined);
    mkdirSync(dirname(path),{recursive:true});
    if(document.name) writeFileSync(path,Buffer.from([0,13,10,255,32]));
    files.set(path,readFileSync(path));
    assert.ok(readFileSync(join(root,'.0-code/AGENT.md'),'utf8').includes('- '+role+': '+document.path));
  }
  assert.equal(readInstallationReceipt(root).files.some(entry=>entry.path.startsWith('.0-code/docs/')),false);
  assert.equal(upgradeProject(root,{config}).result.changed,0);
  uninstallProject(root);
  for(const [path,bytes] of files) assert.deepEqual(readFileSync(path),bytes,path);
  assert.equal(existsSync(join(root,'.0-code/core')),false);
  installProject(root,{config});
  for(const [path,bytes] of files) assert.deepEqual(readFileSync(path),bytes,path);
  assert.deepEqual(readFileSync(join(root,'docs/STATE.md')),product);
});

test('partial upgrade inherits explicit external paths and names while applying only requested roles',t=>{
  const root=fixture(t),documents={...LEGACY_DOCUMENT_DEFAULTS,
    state:{path:'ops/status.md'},roadmap:{path:'plans/roadmap.md'},reports:{path:'results',name:'report-<name>.md'}};
  installProject(root,{config:{...config,documents}});
  const before=readFileSync(join(root,'ops/status.md'));
  assert.equal(upgradeProject(root,{config}).result.changed,0);
  assert.deepEqual(loadProjectConfig({projectDir:root}).config.documents,documents);
  assert.deepEqual(readFileSync(join(root,'ops/status.md')),before);
  assert.equal(existsSync(join(root,'.0-code/docs/STATE.md')),false);
  upgradeProject(root,{config:{...config,documents:{state:{path:'.0-code/docs/ROADMAP.md'},reports:{path:'new-results'}}}});
  const changed=loadProjectConfig({projectDir:root}).config.documents;
  assert.equal(changed.state.path,'.0-code/docs/ROADMAP.md');
  assert.equal(changed.roadmap.path,'plans/roadmap.md');
  assert.deepEqual(changed.reports,{path:'new-results',name:'report-<name>.md'});
  assert.deepEqual(readFileSync(join(root,'ops/status.md')),before);
  assert.throws(()=>upgradeProject(root,{config:{...config,documents:{unknown:{path:'unrecognized'}}}}),/unknown property/);
});
