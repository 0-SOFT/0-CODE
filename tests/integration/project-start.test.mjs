import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installProject } from '../../core/project-installation.mjs';
import { planProjectStart, startProjectCycle } from '../../core/project-start.mjs';
import { applyInstallationPlan } from '../../core/installation-transaction.mjs';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';
import { cleanupTempDir, readFrontmatter } from '../helpers/index.mjs';
import { checkFreshness } from '../../lib/step-instruction.mjs';
const repository=fileURLToPath(new URL('../../',import.meta.url));
const scratch=join(dirname(repository.replace(/[\\/]$/,'')),'scratch','tmp');mkdirSync(scratch,{recursive:true});
function fixture(t,installed=true) {
  const root=mkdtempSync(join(scratch,'start-'));t.after(()=>cleanupTempDir(root));
  if(installed) installProject(root,{config:{modules:Object.fromEntries(Object.keys(PROJECT_MODULES).map(id=>[id,false]))}});
  const prompt=join(root,'owner.md');writeFileSync(prompt,'---\nversion: "2.1.0"\nstage: 2\n---\n# Work\n');return {root,prompt};
}
test('real source start API previews without writes, binds state with the shared stamp and refuses active replacement',t=>{
  const {root,prompt}=fixture(t),state=join(root,'docs/STATE.md'),before=readFileSync(state);
  const plan=planProjectStart(root,prompt,{maxIterations:2});assert.deepEqual(readFileSync(state),before);
  assert.equal(plan.drivers[0].engine,'claude');
  const applied=startProjectCycle(root,prompt,{maxIterations:2});assert.ok(applied.result.changed>0);
  assert.equal(readFrontmatter(state).max_iterations,2);assert.equal(checkFreshness(readFrontmatter(state)).status,'fresh');
  assert.throws(()=>startProjectCycle(root,prompt),/already active/);
  const released=spawnSync(process.execPath,[join(root,'.0-code/lib/update-state.mjs'),state],{input:JSON.stringify({released_version:'2.1.0'}),encoding:'utf8',windowsHide:true});
  assert.equal(released.status,0,released.stderr);assert.throws(()=>planProjectStart(root,prompt),/already been released/);
  writeFileSync(prompt,'---\nversion: "2.2.0"\nstage: 1\n---\n# Next cycle\n');startProjectCycle(root,prompt);
  assert.equal(readFrontmatter(state).max_iterations,null);assert.equal(readFrontmatter(state).previous_version,'2.1.0');
});
test('invalid inputs and edits after planning preserve the existing state',t=>{
  const absent=fixture(t,false);assert.throws(()=>planProjectStart(absent.root,absent.prompt),/Install/);
  const {root,prompt}=fixture(t),state=join(root,'docs/STATE.md'),before=readFileSync(state);
  for(const limit of [0,-1,1.5,NaN]) assert.throws(()=>planProjectStart(root,prompt,{maxIterations:limit}),/positive/);
  for(const text of ['# No header','---\nversion: "x"\nstage: 2\n---\n','---\nversion: "2.1.0"\nstage: 7\n---\n']) {
    writeFileSync(prompt,text);assert.throws(()=>planProjectStart(root,prompt),/frontmatter|version|stage/);assert.deepEqual(readFileSync(state),before);
  }
  writeFileSync(prompt,'---\nversion: "2.1.0"\nstage: 2\n---\n# Work\n');
  const ready=planProjectStart(root,prompt);writeFileSync(state,Buffer.concat([before,Buffer.from('Owner addition\n')]));
  const edited=readFileSync(state);assert.throws(()=>applyInstallationPlan(ready.plan),/changed/);assert.deepEqual(readFileSync(state),edited);
  writeFileSync(state,'# Human state');assert.throws(()=>planProjectStart(root,prompt),/frontmatter/);
});
