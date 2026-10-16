// Preserve project-owned instructions while refreshing the framework block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupTempDir } from '../helpers/index.mjs';
import { mergeProjectInstructions, planProjectInstructions, renderProjectInstructions } from '../../lib/project-instructions.mjs';
import { main, planBootstrap } from '../../tools/bootstrap-plan.mjs';
import { CodexHome } from '../../core/backends/codex-home.mjs';
import { CodexBackend } from '../../core/backends/codex.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'instructions-'));
  t.after(() => cleanupTempDir(root));
  for (const dir of ['templates', 'config']) mkdirSync(join(root, dir));
  writeFileSync(join(root, 'templates', 'project-CLAUDE.md'), '# __PROJECT_NAME__\nVersion __FRAMEWORK_VERSION__\n');
  writeFileSync(join(root, 'VERSION'), '1.27.0\n');
  writeFileSync(join(root, 'config', 'mcp-manifest.example.json'), JSON.stringify({ schema_version: 1, servers: [] }));
  const targetDir = join(root, 'future-project');
  const env = { FRAMEWORK_CODEX_HOME: join(root, 'managed'), CODEX_HOME: join(root, 'fixture-personal') };
  return { root, targetDir, env };
}

test('rendering treats project names as literal text and replaces every placeholder', () => {
  const name = "$& $` $' / & __FRAMEWORK_VERSION__";
  assert.equal(renderProjectInstructions('__PROJECT_NAME__ __PROJECT_NAME__ __FRAMEWORK_VERSION__',
    { projectName: name, frameworkVersion: '1.27.0' }), `${name} ${name} 1.27.0`);
});

test('merging appends once and refreshes only the marked block', () => {
  const first = mergeProjectInstructions('# Preserve project policy\n', 'first framework');
  assert.match(first, /^# Preserve project policy\n\n<!-- BEGIN AUTONOMOUS FRAMEWORK -->/);
  assert.equal(mergeProjectInstructions(first, 'first framework'), first);
  const surrounded = `prefix with trailing spaces  \n${mergeProjectInstructions('', 'old')}suffix  \n`;
  assert.equal(mergeProjectInstructions(surrounded, 'new'),
    `prefix with trailing spaces  \n${mergeProjectInstructions('', 'new')}suffix  \n`);
});

test('incomplete, duplicate and reversed markers refuse rather than deleting project instructions', () => {
  const begin = '<!-- BEGIN AUTONOMOUS FRAMEWORK -->', end = '<!-- END AUTONOMOUS FRAMEWORK -->';
  for (const current of [begin, end, `${end}\n${begin}`, `${begin}\n${begin}\n${end}`, `${begin}\n${end}\n${end}`]) {
    assert.throws(() => mergeProjectInstructions(current, 'new'), /markers/);
  }
});

test('planning uses target instructions, preserves the source and creates no directory', t => {
  const f = fixture(t);
  const absent = planProjectInstructions({ ...f, frameworkVersion: '1.28.0' });
  assert.match(absent.content, /# future-project\nVersion 1.28.0/);
  assert.equal(existsSync(f.targetDir), false);
  mkdirSync(f.targetDir);
  const file = join(f.targetDir, 'CLAUDE.md');
  writeFileSync(file, 'Project-owned policy without a final newline');
  const present = planProjectInstructions({ ...f, frameworkVersion: '1.28.0' });
  assert.match(present.content, /^Project-owned policy without a final newline\n\n/);
  assert.ok(present.content.endsWith('\n'));
  assert.equal(readFileSync(file, 'utf8'), 'Project-owned policy without a final newline');
  writeFileSync(file, '<!-- BEGIN AUTONOMOUS FRAMEWORK -->\nold\n<!-- END AUTONOMOUS FRAMEWORK -->');
  assert.ok(planProjectInstructions({ ...f, frameworkVersion: '1.28.0' }).content.endsWith('\n'));
});

test('Codex preview validates the home and manifest without creating project or configuration', async t => {
  const f = fixture(t);
  const result = await planBootstrap({ ...f, backend: 'codex' });
  assert.equal(result.codex.dryRun, true);
  assert.match(result.instructions.content, /Version 1.27.0/);
  assert.equal(existsSync(f.targetDir), false);
  assert.equal(existsSync(f.env.FRAMEWORK_CODEX_HOME), false);
  await assert.rejects(planBootstrap({ ...f, backend: 'unknown' }), /backend/);
  await assert.rejects(planBootstrap({ ...f, targetDir: f.root }), /framework root/);
});

test('bootstrap plan CLI rejects ambiguous modes, typos and missing values before reading target files', async () => {
  for (const args of [[], ['--render', '--dry-run'], ['--typo'], ['--target'], ['--backend', '--dry-run']]) {
    await assert.rejects(main(args), /argument|missing value|Select exactly/);
  }
});

test('a login-scoped CODEX_HOME must be restored before selecting that managed home for execution', t => {
  const f = fixture(t), userHome = join(f.root, 'fixture-user');
  const leftAtLogin = new CodexHome({ env: { ...f.env, CODEX_HOME: f.env.FRAMEWORK_CODEX_HOME }, userHome });
  assert.throws(() => leftAtLogin.prepare({ cwd: f.targetDir, dryRun: true }), /personal Codex home/);
  const restored = new CodexHome({ env: f.env, userHome });
  assert.equal(restored.prepare({ cwd: f.targetDir, dryRun: true }).home, f.env.FRAMEWORK_CODEX_HOME);
  assert.equal(existsSync(f.env.FRAMEWORK_CODEX_HOME), false);
  assert.equal(existsSync(userHome), false);
});

test('a failed login check gives process-scoped login and restored supervisor instructions without changing caller environment', async t => {
  const f = fixture(t);
  mkdirSync(f.targetDir);
  const originalEnv = { ...f.env };
  const backend = new CodexBackend({ env: f.env, command: { bin: 'fixture', args: [] },
    inspect: (_bin, args) => args.includes('--version')
      ? { status: 0, stdout: 'codex-cli 0.162.0' } : { status: 1 },
  });
  const result = await backend.checkEngine({ cwd: f.targetDir });
  assert.equal(result.ok, false);
  assert.match(result.error, /Bash: CODEX_HOME=.* codex login/);
  assert.match(result.error, /finally \{/);
  assert.match(result.error, /\$env:CODEX_HOME = \$previousCodexHome/);
  assert.match(result.error, /FRAMEWORK_CODEX_HOME=.* node '.*core[\\/]supervisor\.mjs'/);
  assert.deepEqual(f.env, originalEnv);
  assert.equal(existsSync(f.env.CODEX_HOME), false);
});
