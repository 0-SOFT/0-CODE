import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafetyGuard } from '../../core/backends/project-opencode-plugin.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
const base=join(dirname(fileURLToPath(new URL('../../',import.meta.url)).replace(/[\\/]$/,'')),'scratch','tmp');
mkdirSync(base,{recursive:true});
function project(t,mode) {
  const root=mkdtempSync(join(base,'project-native-guard-'));t.after(()=>cleanupTempDir(root));
  mkdirSync(join(root,'.0-code'),{recursive:true});
  writeFileSync(join(root,'.0-code/config.json'),JSON.stringify({engines:['opencode'],guard:{mode}}));
  return root;
}
test('native OpenCode guard executes the source API, honours the project mode and records decisions in runtime',async t=>{
  const old=process.env.SAFETY_GUARD_MODE;delete process.env.SAFETY_GUARD_MODE;
  t.after(()=>{if(old===undefined)delete process.env.SAFETY_GUARD_MODE;else process.env.SAFETY_GUARD_MODE=old;});
  const root=project(t,'arbiter'),hook=(await SafetyGuard({directory:root}))['tool.execute.before'];
  await hook({},{});assert.equal(existsSync(join(root,'.0-code/run/guard.log')),false);
  await hook({tool:'bash'},{args:{command:'git status'}});
  await assert.rejects(hook({tool:'bash'},{args:{cmd:'git push --force'}}),/force/i);
  const log=readFileSync(join(root,'.0-code/run/guard.log'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(log.some(entry=>entry.mode==='arbiter'));assert.equal(existsSync(join(root,'docs/guard.log')),false);
  const allowed=project(t,'allow-all'),disabled=(await SafetyGuard({worktree:allowed}))['tool.execute.before'];
  await disabled({tool:'bash'},{args:{command:'git push --force'}});
  assert.ok(readFileSync(join(allowed,'.0-code/run/guard.log'),'utf8').includes('allow-all'));
});
test('environment overrides native project mode and a failed audit write does not change denial',async t=>{
  const old=process.env.SAFETY_GUARD_MODE;
  t.after(()=>{if(old===undefined)delete process.env.SAFETY_GUARD_MODE;else process.env.SAFETY_GUARD_MODE=old;});
  const root=project(t,'allow-all');
  process.env.SAFETY_GUARD_MODE='arbiter';
  const hook=(await SafetyGuard({directory:root}))['tool.execute.before'];
  mkdirSync(join(root,'.0-code/run/guard.log'),{recursive:true});
  await assert.rejects(hook({tool:'Bash'},{args:{command:'git push --force'}}),/force/i);
  await hook({tool:'Bash'},{args:{command:'git status'}});
  process.env.SAFETY_GUARD_MODE='unknown-fixture-mode';
  const fallback=(await SafetyGuard({directory:root}))['tool.execute.before'];
  await assert.rejects(fallback({tool:'Bash'},{args:{command:'git push --force'}}),/force/i);
});
