import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTempDir } from '../helpers/index.mjs';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';
import {runBootstrap} from '../helpers/bootstrap-run.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const scratch = join(dirname(repo.replace(/[\\/]$/, '')), 'scratch', 'tmp'); mkdirSync(scratch, { recursive: true });
function fixture(t) { const root = mkdtempSync(join(scratch, 'bootstrap-cli-')); t.after(() => cleanupTempDir(root)); return root; }
function isolatedEnv(root, extraEnv = {}) {
  const home=join(root,'isolated-home');
  return {...process.env,HOME:home,USERPROFILE:home,
    CLAUDE_CONFIG_DIR:join(home,'claude'),CODEX_HOME:join(home,'codex'),XDG_CONFIG_HOME:join(home,'xdg'),ZERO_CODE_USER_DIR:join(home,'pool'),...extraEnv};
}
async function install(root, extraEnv = {}, args = []) {
  return runBootstrap('bash', [join(repo, 'bootstrap.sh'), root, ...args],{env:isolatedEnv(root,extraEnv)});
}
test('default bootstrap completes through Node, repeats without writes and never claims the cycle is already active', async t => {
  const root = fixture(t), started=performance.now(),first = await install(root, { CLAUDECODE: '1' });
  t.diagnostic(`Default bootstrap install: ${Math.round(performance.now()-started)} ms`);
  assert.equal(first.status, 0,first.error?.message||first.stderr);
  assert.doesNotMatch(first.stdout, /Ralph Loop is now active/); assert.match(first.stdout.split(/\r?\n/).slice(-8).join('\n'), /ATTENTION.*restart/);
  assert.equal(existsSync(join(root, '.0-code/installation.json')), true);
  assert.equal(existsSync(join(root, 'lib')), false); assert.equal(existsSync(join(root, 'core')), false);
  const repeatedAt=performance.now(),repeat = await install(root, {}, ['--json']);
  t.diagnostic(`Default bootstrap repeat: ${Math.round(performance.now()-repeatedAt)} ms`);
  assert.equal(repeat.status, 0,repeat.error?.message||repeat.stderr);assert.equal(JSON.parse(repeat.stdout).changed, 0);
});
test('project ignore and attribute files remain byte-identical; runtime has its own exclusion', async t => {
  const root = fixture(t), ignore = '# Private project\r\ndocs/userdocs/VPS.md\r\n', attributes = '*.txt text eol=crlf\n';
  writeFileSync(join(root, '.gitignore'), ignore); writeFileSync(join(root, '.gitattributes'), attributes);
  const result = await install(root); assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), ignore); assert.equal(readFileSync(join(root, '.gitattributes'), 'utf8'), attributes);
  assert.equal(readFileSync(join(root, '.0-code/.gitignore'), 'utf8'), '/run/\n/docs/logs/\n');
});
test('ordinary source folders are preserved and a foreign Stop fails before writing anything', async t => {
  const root = fixture(t); mkdirSync(join(root, 'lib')); writeFileSync(join(root, 'lib/yaml-mini.mjs'), 'project module');
  mkdirSync(join(root, '.claude')); const settings = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node own-cycle.js"}]}]}}';
  writeFileSync(join(root, '.claude/settings.json'), settings); const before = readdirSync(root).sort();
  const result = await install(root); assert.notEqual(result.status, 0); assert.match(result.stderr, /Stop/);
  assert.deepEqual(readdirSync(root).sort(), before); assert.equal(readFileSync(join(root, 'lib/yaml-mini.mjs'), 'utf8'), 'project module');
  assert.equal(readFileSync(join(root, '.claude/settings.json'), 'utf8'), settings);
});
test('PowerShell and Bash entrypoints install the same core contract on Windows', async t => {
  if (process.platform !== 'win32') { assert.match(readFileSync(join(repo, 'bootstrap.ps1'), 'utf8'), /tools\/0code.mjs/); return; }
  const root = fixture(t), config = join(root, 'settings.json');
  writeFileSync(config, JSON.stringify({ engines: ['claude'], modules: Object.fromEntries(Object.keys(PROJECT_MODULES).map(id => [id, false])) }));
  const result = await runBootstrap('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'bootstrap.ps1'), root, '--config', config, '--json'],
    {cwd:root,env:isolatedEnv(root)});
  assert.equal(result.status, 0, result.stderr); assert.ok(JSON.parse(result.stdout).changed > 0);
  assert.equal(existsSync(join(root, '.0-code/core/supervisor.mjs')), true);
});
