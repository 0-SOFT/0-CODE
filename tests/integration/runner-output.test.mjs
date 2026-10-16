import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { cleanupTempDir } from '../helpers/index.mjs';

function fixture(t, { fail = false, partial = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'runner-output-')); t.after(() => cleanupTempDir(root));
  mkdirSync(join(root, 'tests'));
  for (const file of ['run.mjs', 'coverage-report.mjs']) copyFileSync(new URL(`../${file}`, import.meta.url), join(root, 'tests', file));
  for (const dir of ['core', 'lib', 'hooks']) {
    mkdirSync(join(root, dir));
    writeFileSync(join(root, dir, 'sample.mjs'), 'export function measured(value) {\n  if (value) {\n    return 1;\n  }\n  return 2;\n}\n');
  }
  const imports = ['core', 'lib', 'hooks'].map((dir, i) => `import {measured as m${i}} from '../${dir}/sample.mjs';`).join('\n');
  writeFileSync(join(root, 'tests', 'fixture.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\n${imports}\n`
    + `test('measured source',()=>{${[0, 1, 2].map(i => `m${i}(true);${partial ? '' : `m${i}(false);`}`).join('')}});\n`
    + `test('late sentinel',()=>{console.log('LATE_TEST_SENTINEL');${fail ? "assert.fail('LATE_FAILURE_SENTINEL');" : ''}});\n`);
  // This executes inside the real node --test process before its reporter, so the runner must
  // relay a large independent stderr as well as stdout. It never replaces the child launcher.
  const preload = join(root, 'preload.cjs');
  writeFileSync(preload, "if(process.execArgv.includes('--test')) { process.stdout.write('O'.repeat(1048576)+'\\nSTDOUT_END_SENTINEL\\n'); process.stderr.write('E'.repeat(1048576)+'\\nSTDERR_END_SENTINEL\\n'); }\n");
  return { root, preload, runner: join(root, 'tests', 'run.mjs') };
}

async function pipeRunner(f, args = [], env = {}) {
  const { NODE_TEST_CONTEXT: _parentTestContext, ...parentEnv } = process.env;
  const child = spawn(process.execPath, [f.runner, ...args], { cwd: f.root, windowsHide: true,
    env: { ...parentEnv, NODE_OPTIONS: `--require=${JSON.stringify(f.preload)}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  // Slow consumers make pending writes at runner termination observable on POSIX pipes.
  const read = async stream => {
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    return Buffer.concat(chunks).toString('utf8');
  };
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (status, signal) => resolve({ status, signal })); });
  const [stdout, stderr, result] = await Promise.all([read(child.stdout), read(child.stderr), done]);
  return { stdout, stderr, ...result };
}

test('actual runner drains large stdout and stderr with a late failure, summary and coverage through pipes', async t => {
  const result = await pipeRunner(fixture(t, { fail: true }), ['--coverage-min=80']);
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes('O'.repeat(1048576) + '\nSTDOUT_END_SENTINEL'));
  assert.ok(result.stderr.includes('E'.repeat(1048576) + '\nSTDERR_END_SENTINEL'));
  for (const text of ['LATE_FAILURE_SENTINEL', 'LATE_TEST_SENTINEL', 'end of coverage report']) assert.ok(result.stdout.includes(text), text);
  assert.ok(/(?:#|ℹ) fail 1/.test(result.stdout), 'late failure summary was lost');
  assert.doesNotMatch(result.stdout, /OK measured source/);
});

test('actual runner drains output and enforces both successful and failing coverage gates', async t => {
  const passed = await pipeRunner(fixture(t), ['--coverage-min=80']);
  assert.equal(passed.status, 0, passed.stderr.slice(-1000));
  assert.ok(/OK measured source modules \(3\)/.test(passed.stdout), 'coverage success summary was lost');
  assert.ok(/(?:#|ℹ) fail 0/.test(passed.stdout), 'success summary was lost');
  assert.ok(passed.stderr.includes('STDERR_END_SENTINEL'), 'stderr tail was lost');
  const failed = await pipeRunner(fixture(t, { partial: true }), ['--coverage-min=100']);
  assert.equal(failed.status, 1); assert.match(failed.stderr, /below the 100% threshold/);
  assert.match(failed.stdout, /end of coverage report/); assert.doesNotMatch(failed.stdout, /OK measured source/);
});

test('actual runner reports child startup errors and never continues to coverage success', async t => {
  const f = fixture(t);
  const preload = join(f.root, 'missing-child.cjs');
  // Keep the real entrypoint and spawnSync. A deleted executable is not portable on Windows;
  // an absent executable path provokes a real OS ENOENT at that same boundary.
  writeFileSync(preload, "Object.defineProperty(process, 'execPath', {value: require('node:path').join(process.cwd(),'absent-node-executable')});\n");
  const result = await pipeRunner(f, ['--coverage-min=80'], { NODE_OPTIONS: `--require=${JSON.stringify(preload)}` });
  assert.equal(result.status, 1); assert.match(result.stderr, /could not complete the test process:.*ENOENT/);
  assert.doesNotMatch(result.stdout, /OK measured source|NOT checked/);
});
