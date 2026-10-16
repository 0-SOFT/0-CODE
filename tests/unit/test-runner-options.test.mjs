import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

// Exercise the actual command-line entry point up to its subprocess boundary. This must not
// start a nested full suite merely to prove which arguments and files the runner forwards.
const source = readFileSync(new URL('../run.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('const TESTS_DIR = dirname(fileURLToPath(import.meta.url));', 'const TESTS_DIR = "F:/fixture/tests";');
const normal = p => p.replaceAll('\\', '/');
const directories = {
  'F:/fixture/tests': ['unit', 'integration'],
  'F:/fixture/tests/unit': ['one.test.mjs'],
  'F:/fixture/tests/integration': ['two.test.mjs'],
};

function invoke(args, { status = 0, line = 100 } = {}) {
  const calls = [], errors = [];
  const row = { file: 'core/fixture.mjs', line, branch: 100 };
  const context = {
    join,
    existsSync: p => normal(p) in directories,
    readdirSync: p => directories[normal(p)],
    statSync: p => ({ isDirectory: () => normal(p) in directories }),
    spawnSync: (bin, argv, options) => { calls.push({ bin, argv: Array.from(argv), options }); return { status, stdout: '', stderr: '' }; },
    coverageRows: () => [row], sourceRows: rows => rows, missingSourceDirs: () => [], worstBranch: () => row,
    console: { log() {}, error: message => errors.push(message) },
    process: {
      argv: ['node', 'tests/run.mjs', ...args], execPath: 'node-under-test',
      stdout: { write() {} }, stderr: { write() {} },
    },
  };
  runInNewContext(source, context);
  return { calls, exits: [context.process.exitCode], errors };
}

test('runner forwards an explicit process limit with every selected file and keeps native defaults otherwise', () => {
  const all = invoke(['--test-concurrency=4']);
  assert.deepEqual(all.exits, [0]);
  assert.equal(all.calls.length, 1);
  assert.equal(all.calls[0].bin, 'node-under-test');
  assert.deepEqual(all.calls[0].argv.map(normal), ['--test', '--experimental-test-coverage', '--test-concurrency=4',
    'F:/fixture/tests/integration/two.test.mjs', 'F:/fixture/tests/unit/one.test.mjs']);
  const defaults = invoke([]);
  assert.deepEqual(defaults.exits, [0]);
  assert.deepEqual(defaults.calls[0].argv.map(normal), all.calls[0].argv.map(normal).filter(x => x !== '--test-concurrency=4'));
  const selected = invoke(['unit', '--test-concurrency=2']);
  assert.deepEqual(selected.calls[0].argv.map(normal), ['--test', '--experimental-test-coverage', '--test-concurrency=2',
    'F:/fixture/tests/unit/one.test.mjs']);
});

test('runner refuses invalid or repeated concurrency before starting a test process', () => {
  for (const args of [['--test-concurrency'], ['--test-concurrency='], ['--test-concurrency=0'],
    ['--test-concurrency=-1'], ['--test-concurrency=1.5'], ['--test-concurrency=NaN'],
    ['--test-concurrency=9007199254740992'], ['--test-concurrency=2', '--test-concurrency=4']]) {
    const actual = invoke(args);
    assert.deepEqual(actual.exits, [2], args.join(' '));
    assert.equal(actual.calls.length, 0, args.join(' '));
    assert.match(actual.errors.join('\n'), /positive safe integer/);
  }
});

test('an explicit process limit preserves subprocess failures and the existing coverage threshold', () => {
  assert.deepEqual(invoke(['--test-concurrency=4'], { status: 7 }).exits, [7]);
  const below = invoke(['--test-concurrency=4', '--coverage-min=80'], { line: 79 });
  assert.deepEqual(below.exits, [1]);
  assert.match(below.errors.join('\n'), /below the 80% threshold/);
  assert.deepEqual(invoke(['--test-concurrency=4', '--coverage-min=80'], { line: 80 }).exits, [0]);
});
