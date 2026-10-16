// Actual shell entrypoint into the common installer; no copied legacy shell helpers or fake CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
import {runBootstrap} from '../helpers/bootstrap-run.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const scratch = join(dirname(repo.replace(/[\\/]$/, '')), 'scratch', 'tmp'); mkdirSync(scratch, { recursive: true });
function fixture(t) {
  const dir = mkdtempSync(join(scratch, 'bootstrap-')); t.after(() => cleanupTempDir(dir));
  const target = join(dir, 'project with spaces'), config = join(dir, 'settings.json'), home = join(dir, 'personal');
  mkdirSync(home); writeFileSync(join(home, 'auth.json'), 'fixture-login'); writeFileSync(join(home, 'config.toml'), 'model = "fixture"\n');
  writeFileSync(config, JSON.stringify({ engines: ['codex'], modules: Object.fromEntries(Object.keys(PROJECT_MODULES).map(id => [id, false])) }));
  const env = { ...process.env, CODEX_HOME: home }; delete env.CODEX_INSTRUCTIONS_MAX_BYTES;
  return { dir, target, config, home, env };
}
function run(f, args = []) {
  return runBootstrap('bash', [join(repo, 'bootstrap.sh'), f.target, '--config', f.config, ...args],{env:f.env});
}
test('Codex shell preview creates neither a missing project nor any personal-home change', async t => {
  const f = fixture(t), before = readFileSync(join(f.home, 'auth.json'));
  const result = await run(f, ['--dry-run', '--json']); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).dryRun, true); assert.equal(existsSync(f.target), false);
  assert.deepEqual(readFileSync(join(f.home, 'auth.json')), before); assert.deepEqual(readdirSync(f.home).sort(), ['auth.json', 'config.toml']);
});
test('Codex shell installation and repeat preserve independent instructions, code folders and login bytes', async t => {
  const f = fixture(t); mkdirSync(f.target); mkdirSync(join(f.target, 'core'));
  writeFileSync(join(f.target, 'core/gates.mjs'), 'own source\n'); writeFileSync(join(f.target, 'AGENTS.md'), '# Codex project rules\r\n');
  writeFileSync(join(f.target, 'CLAUDE.md'), '# Different Claude rules\n'); writeFileSync(join(f.target, '.gitignore'), 'private/\n');
  const first = await run(f, ['--json']); assert.equal(first.status, 0, first.stderr);
  assert.ok(JSON.parse(first.stdout).changed > 0); assert.equal(existsSync(join(f.target, '.0-code/core/supervisor.mjs')), true);
  assert.equal(existsSync(join(f.target, '.claude/settings.json')), false); assert.equal(existsSync(join(f.target, 'ecosystem.json')), false);
  assert.match(readFileSync(join(f.target, 'AGENTS.md'), 'utf8'), /^# Codex project rules\r\n/);
  assert.match(readFileSync(join(f.target, 'CLAUDE.md'), 'utf8'), /^# Different Claude rules\n/);
  assert.equal(readFileSync(join(f.target, 'core/gates.mjs'), 'utf8'), 'own source\n');
  assert.equal(readFileSync(join(f.target, '.gitignore'), 'utf8'), 'private/\n');
  const second = await run(f, ['--json']); assert.equal(second.status, 0, second.stderr); assert.equal(JSON.parse(second.stdout).changed, 0);
  assert.equal(readFileSync(join(f.home, 'auth.json'), 'utf8'), 'fixture-login'); assert.equal(readFileSync(join(f.home, 'config.toml'), 'utf8'), 'model = "fixture"\n');
});
test('an explicitly limited Codex instruction file refuses before writing any installation', async t => {
  const f = fixture(t); mkdirSync(f.target); const before = 'x'.repeat(32769); writeFileSync(join(f.target, 'AGENTS.md'), before);
  f.env.CODEX_INSTRUCTIONS_MAX_BYTES = '32768';
  const result = await run(f); assert.notEqual(result.status, 0); assert.match(result.stderr, /configured limit/);
  assert.deepEqual(readdirSync(f.target), ['AGENTS.md']); assert.equal(readFileSync(join(f.target, 'AGENTS.md'), 'utf8'), before);
});
test('an occupied framework folder or malformed markers refuse without overwriting project files', async t => {
  for (const shape of ['occupied', 'markers']) {
    const f = fixture(t); mkdirSync(f.target);
    if (shape === 'occupied') { mkdirSync(join(f.target, '.0-code')); writeFileSync(join(f.target, '.0-code/own.txt'), 'project data'); }
    else writeFileSync(join(f.target, 'AGENTS.md'), '<!-- BEGIN 0-CODE -->\nincomplete');
    const result = await run(f); assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(f.target, '.0-code/installation.json')), false);
    if (shape === 'occupied') assert.equal(readFileSync(join(f.target, '.0-code/own.txt'), 'utf8'), 'project data');
    else assert.equal(readFileSync(join(f.target, 'AGENTS.md'), 'utf8'), '<!-- BEGIN 0-CODE -->\nincomplete');
  }
});
test('malformed shell arguments and source-as-target refuse before installation', t => {
  const f = fixture(t);
  for (const args of [['--backend'], ['--unknown'], ['--backend', 'unknown'], ['first', 'second']]) {
    const result = spawnSync('bash', [join(repo, 'bootstrap.sh'), ...args], { cwd: f.dir, env: f.env, encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0); assert.equal(existsSync(f.target), false);
  }
  const same = spawnSync('bash', [join(repo, 'bootstrap.sh'), repo, '--dry-run'], { env: f.env, encoding: 'utf8', windowsHide: true });
  assert.notEqual(same.status, 0); assert.match(same.stderr, /source directory/);
});
