import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCliLaunch } from '../../core/backends/cli-launch.mjs';
import { runCli, runCliAsync } from '../../core/backends/spawn-cli.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
import { writeNpmNodeShim } from '../helpers/npm-shim.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cli-resolver-'));
  t.after(() => cleanupTempDir(root));
  return root;
}

test('native and POSIX launches preserve data; missing Windows names keep a normal spawn error', t => {
  const root = fixture(t), args = ['quoted"&%', ''];
  assert.deepEqual(resolveCliLaunch('tool', args, { platform: 'linux' }), { command: 'tool', args });
  assert.deepEqual(resolveCliLaunch('missing-fixture-command', args, { platform: 'win32', cwd: root, env: {} }),
    { command: 'missing-fixture-command', args });
  const exe = join(root, 'fixture.exe'); writeFileSync(exe, 'native fixture');
  assert.deepEqual(resolveCliLaunch('fixture', args, { platform: 'win32', cwd: root,
    env: { Path: `"${root}"`, PathExt: '.IGNORED;.exe;.cmd' } }), { command: exe, args });
});

test('native npm forwarders resolve both dp0 spellings and reject an absent target', t => {
  const root = fixture(t), args = ['data'], exe = join(root, 'fixture.exe'), shim = join(root, 'fixture.cmd');
  writeFileSync(shim, '@ECHO off\r\n"%~dp0fixture.exe" %*\r\n');
  assert.throws(() => resolveCliLaunch(shim, args, { platform: 'win32' }), /entrypoint is missing/);
  writeFileSync(exe, 'native fixture');
  assert.deepEqual(resolveCliLaunch(shim, args, { platform: 'win32' }), { command: exe, args });
  writeFileSync(shim, '@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n"%dp0%\\fixture.exe" %*\n');
  assert.deepEqual(resolveCliLaunch(shim, args, { platform: 'win32' }), { command: exe, args });
});

test('npm Node and builtin npm/npx forwarders select JS without interpreting batch source', t => {
  const root = fixture(t), args = ['data'], script = join(root, 'cli.mjs'), shim = join(root, 'fixture.cmd');
  writeFileSync(script, 'process.stdout.write("fixture")');
  writeNpmNodeShim(shim, 'cli.mjs');
  assert.deepEqual(resolveCliLaunch(shim, args, { platform: 'win32' }),
    { command: process.execPath, args: [script, ...args] });
  const node = join(root, 'node.exe'); writeFileSync(node, 'adjacent fixture');
  assert.deepEqual(resolveCliLaunch(shim, args, { platform: 'win32' }), { command: node, args: [script, ...args] });
  for (const name of ['npm', 'npx']) {
    const command = join(root, `${name}.cmd`), variable = `${name.toUpperCase()}_CLI_JS`;
    writeFileSync(command, `:: Created by npm, please don't edit manually.\n@ECHO OFF\nSET "${variable}=%~dp0\\cli.mjs"\n"%NODE_EXE%" "%${variable}%" %*\n`);
    assert.deepEqual(resolveCliLaunch(command, args, { platform: 'win32' }), { command: node, args: [script, ...args] });
  }
});

test('arbitrary batch files are refused intact and never execute their extra command', async t => {
  const root = fixture(t), marker = join(root, 'marker.txt'), shim = join(root, 'custom.bat');
  const source = `@echo off\necho should-not-run > "${marker}"\n`;
  writeFileSync(shim, source);
  assert.throws(() => resolveCliLaunch(shim, [], { platform: 'win32' }), /Unsupported Windows batch/);
  if (process.platform === 'win32') for (const launcher of [runCli, runCliAsync]) {
    const result = await launcher(shim, [], { encoding: 'utf8' });
    assert.equal(result.status, null);
    assert.match(result.stderr, /Unsupported Windows batch/);
  }
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(shim, 'utf8'), source);
});
