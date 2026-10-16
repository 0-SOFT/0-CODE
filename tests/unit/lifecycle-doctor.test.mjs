import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { mkTempProject } from '../helpers/index.mjs';
import { probeEngine, engineCommandFiles } from '../helpers/lifecycle-doctor.mjs';

test('an empty command path proves real absence without installing or replacing a CLI', t => {
  const f = mkTempProject(); t.after(f.cleanup);
  for (const engine of ['claude', 'codex', 'opencode']) {
    assert.deepEqual(probeEngine(engine, { cwd: f.dir, env: { PATH: '' } }), { available: false });
  }
});

test('a broken command file cannot be accepted as an absent engine, including Windows shims', t => {
  const f = mkTempProject(); t.after(f.cleanup);
  const file = join(f.dir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  // A negative fixture only: it cannot run or claim a successful version.
  writeFileSync(file, '#!/no-such-interpreter-for-this-test\n', { mode: 0o755 });
  const options = { cwd: f.dir, env: { PATH: f.dir } };
  assert.deepEqual(engineCommandFiles('codex', options), [file]);
  assert.throws(() => probeEngine('codex', options), /has a command file but cannot be/);
  if (process.platform === 'win32') {
    writeFileSync(join(f.dir, 'claude.ps1'), '# not an executable success fixture\n');
    assert.deepEqual(engineCommandFiles('claude', options), [join(f.dir, 'claude.ps1')]);
  }
});

test('relative and empty PATH entries and dangling links cannot hide a broken command', t => {
  const f = mkTempProject(); t.after(f.cleanup);
  const bin = join(f.dir, 'bin'); mkdirSync(bin);
  const name = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  const file = join(bin, name);
  writeFileSync(file, '#!/no-such-interpreter-for-this-test\n', { mode: 0o755 });
  const options = { cwd: f.dir, env: { PATH: 'bin' } };
  assert.deepEqual(engineCommandFiles('codex', options), [file]);
  assert.throws(() => probeEngine('codex', options), /has a command file but cannot be/);
  const local = join(f.dir, name);
  writeFileSync(local, '#!/no-such-interpreter-for-this-test\n', { mode: 0o755 });
  const empty = { cwd: f.dir, env: { PATH: '' } };
  assert.deepEqual(engineCommandFiles('codex', empty), [local]);
  assert.throws(() => probeEngine('codex', empty), /has a command file but cannot be/);
  if (process.platform !== 'win32') {
    unlinkSync(local); symlinkSync('absent-target', local);
    assert.deepEqual(engineCommandFiles('codex', empty), [local]);
    assert.throws(() => probeEngine('codex', empty), /has a command file but cannot be/);
  }
});
