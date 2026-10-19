import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';
import { cleanupTempDir, readFrontmatter } from '../helpers/index.mjs';
import { checkFreshness } from '../../lib/step-instruction.mjs';
import {runBootstrap} from '../helpers/bootstrap-run.mjs';
import { assertLifecycleDoctor } from '../helpers/lifecycle-doctor.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const scratch = join(dirname(repo.replace(/[\\/]$/, '')), 'scratch', 'tmp'); mkdirSync(scratch, { recursive: true });
const cli = join(repo, 'tools/0code.mjs');
function fixture(t, extra = {}) {
  const root = mkdtempSync(join(scratch, 'cli-')); t.after(() => cleanupTempDir(root));
  const config = { engines: ['claude', 'codex', 'opencode'], language: 'ru',
    modules: Object.fromEntries(Object.keys(PROJECT_MODULES).map(id => [id, false])), ...extra };
  const file = join(root, 'settings.json'); writeFileSync(file, JSON.stringify(config));
  return { root, file };
}
const run = (root, args, installed = false) => runBootstrap(process.execPath,
  [installed ? join(root, '.0-code/tools/0code.mjs') : cli, ...args, '--project', root, '--json']);
test('CLI help describes commands and scope without project writes; malformed options still fail',t=>{
  const {root}=fixture(t),before=readdirSync(root).sort();
  for(const args of [['--help'],['-h'],['install','--help'],['start','-h']]) {
    const result=spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Usage:/);
    assert.match(result.stdout,/uninstall-tools/);assert.match(result.stdout,/--config/);
    assert.deepEqual(readdirSync(root).sort(),before);
  }
  for(const args of [['install','--project'],['--help','--unknown'],['install','--help','--unknown']]) {
    const result=spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8',windowsHide:true});
    assert.notEqual(result.status,0);assert.deepEqual(readdirSync(root).sort(),before);
  }
});
test('actual CLI core lifecycle: read-only preview, install, native doctor controls, repeat, upgrade and exact uninstall', async t => {
  const { root, file } = fixture(t);
  writeFileSync(join(root, 'CLAUDE.md'), '# Own instructions\r\n'); writeFileSync(join(root, '.gitignore'), 'private/\n');
  const before = readdirSync(root).sort();
  const preview = await run(root, ['install', '--config', file, '--dry-run']); assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(readdirSync(root).sort(), before);
  const installed = await run(root, ['install', '--config', file]); assert.equal(installed.status, 0, installed.stderr);
  const doctor = await run(root, ['doctor'], true);
  const result = JSON.parse(doctor.stdout);
  assertLifecycleDoctor(result, { cwd: root, engines: ['claude', 'codex', 'opencode'], status: doctor.status });
  assert.equal(result.checks.filter(check => /^guard-/.test(check.id) && check.ok).length, 3);
  for (const command of ['install', 'upgrade']) {
    const repeated = await run(root, [command], true); assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout).changed, 0);
  }
  const removed = await run(root, ['uninstall'], true); assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(readdirSync(join(root, '.0-code')), ['docs']);
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), '# Own instructions\r\n');
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), 'private/\n');
  assert.equal(existsSync(join(root, '.0-code/docs/STATE.md')), true);
});
test('actual start atomically binds version, stage, prompt, cap and fresh instruction; active cycle refuses replacement', async t => {
  const { root, file } = fixture(t, { documents: { state: { path: 'cycle/status.md' }, prompts: { path: 'cycle/prompts', name: '<version>-<name>.md' } } });
  assert.equal((await run(root, ['install', '--config', file])).status, 0);
  const prompt = join(root, 'owner-cycle.md'); writeFileSync(prompt, '---\nversion: "3.1.0"\nstage: 2\n---\n# Two tasks\nFix code and update documentation.\n');
  const state = join(root, 'cycle/status.md'), before = readFileSync(state);
  const preview = await run(root, ['start', prompt, '--max', '2', '--dry-run'], true);
  assert.equal(preview.status, 0, preview.stderr); assert.deepEqual(readFileSync(state), before);
  assert.equal(existsSync(join(root, 'cycle/prompts')), false);
  const started = await run(root, ['start', prompt, '--max', '2'], true); assert.equal(started.status, 0, started.stderr);
  const fields = readFrontmatter(state);
  assert.equal(fields.current_version, '3.1.0'); assert.equal(fields.current_stage, 2); assert.equal(fields.max_iterations, 2);
  assert.equal(fields.current_prompt_file, 'cycle/prompts/3.1.0-owner-cycle.md');
  assert.equal(checkFreshness(fields).status, 'fresh'); assert.equal(fields.iteration, 0);
  assert.deepEqual(readFileSync(join(root, fields.current_prompt_file)), readFileSync(prompt));
  const bound = readFileSync(state), refused = await run(root, ['start', prompt], true);
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /already active/); assert.deepEqual(readFileSync(state), bound);
});
test('invalid limits, prompt shape and occupied prompt path refuse without touching state', async t => {
  const { root, file } = fixture(t); assert.equal((await run(root, ['install', '--config', file])).status, 0);
  const prompt = join(root, 'owner.md'), state = join(root, '.0-code/docs/STATE.md'), before = readFileSync(state);
  for (const contents of ['# No metadata', '---\nversion: "x"\nstage: 2\n---\n', '---\nversion: "2.0.0"\nstage: 8\n---\n']) {
    writeFileSync(prompt, contents); assert.notEqual((await run(root, ['start', prompt], true)).status, 0); assert.deepEqual(readFileSync(state), before);
  }
  writeFileSync(prompt, '---\nversion: "2.0.0"\nstage: 2\n---\n# Work\n');
  for (const limit of ['0', '-1', 'no', '9007199254740992']) {
    assert.notEqual((await run(root, ['start', prompt, '--max', limit], true)).status, 0); assert.deepEqual(readFileSync(state), before);
  }
  mkdirSync(join(root, '.0-code/docs/prompts'), { recursive: true }); writeFileSync(join(root, '.0-code/docs/prompts/2.0.0_owner.md'), 'existing project prompt');
  const occupied = await run(root, ['start', prompt], true); assert.notEqual(occupied.status, 0);
  assert.equal(readFileSync(join(root, '.0-code/docs/prompts/2.0.0_owner.md'), 'utf8'), 'existing project prompt'); assert.deepEqual(readFileSync(state), before);
});
test('doctor reports changed code and invalid config instead of claiming readiness', async t => {
  const { root, file } = fixture(t); assert.equal((await run(root, ['install', '--config', file])).status, 0);
  writeFileSync(join(root, '.0-code/core/safety.mjs'), 'export const destructiveVerdict = () => null;\n');
  const changed = await run(root, ['doctor']); assert.notEqual(changed.status, 0); assert.equal(JSON.parse(changed.stdout).ok, false);
  writeFileSync(join(root, '.0-code/config.json'), 'null');
  const invalid = await run(root, ['doctor']); assert.notEqual(invalid.status, 0); assert.equal(JSON.parse(invalid.stdout).checks.find(check => check.id === 'config').ok, false);
});
test('CLI rejects invalid options and external null config before any installation write', async t => {
  const { root, file } = fixture(t); writeFileSync(file, 'null');
  const original = readdirSync(root);
  for (const args of [['install', '--config', file], ['upgrade', '--dry-run'], ['start'], ['install', '--max', '2'], ['install', '--backend', 'unknown'], ['uninstall', '--config', file]]) {
    const result = await run(root, args); assert.notEqual(result.status, 0); assert.deepEqual(readdirSync(root), original);
  }
});
