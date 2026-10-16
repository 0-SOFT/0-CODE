import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, utimesSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTempProject, readFrontmatter } from '../helpers/index.mjs';
import { inspectStateJobs, resolveJobPath } from '../../core/long-jobs.mjs';

function fixture(t) {
  const f = mkTempProject(); t.after(f.cleanup);
  mkdirSync(join(f.dir, 'result files'));
  writeFileSync(join(f.dir, 'job.log'), 'work ran\n');
  return f;
}
function update(f, jobs) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../lib/update-state.mjs', import.meta.url)), f.stateFile], {
    input: JSON.stringify({ running_jobs: jobs }), encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return readFrontmatter(f.stateFile);
}
const deadJob = extra => ({ id: 'job', pid: 2147483647, log: 'job.log', ...extra });

test('real JSON update → YAML → completion file keeps failure separate from finished, even with a live PID', t => {
  const f = fixture(t), file = join(f.dir, 'result files', 'done.json');
  writeFileSync(file, '{"ok":false,"status":7}\n');
  const paths = ['result files/done.json', file];
  if (process.platform === 'win32') paths.push(file.replaceAll('\\', '\\\\'), file.replaceAll('\\', '/'));
  for (const done_file of paths) for (const pid of [process.pid, 2147483647]) {
    const state = update(f, [deadJob({ pid, done_file })]);
    assert.equal(state.running_jobs[0].done_file, done_file, 'serialization must not reinterpret paths');
    const [row] = inspectStateJobs(state, { cwd: f.dir });
    assert.equal(row.state, 'finished', JSON.stringify(row));
    assert.match(row.why, /determine success/);
    assert.equal(JSON.parse(readFileSync(file)).ok, false);
  }
});

test('missing, unreadable and stale completion files do not finish a job; a fresh replacement does', t => {
  const f = fixture(t), file = join(f.dir, 'done.json');
  const inspect = extra => inspectStateJobs(update(f, [deadJob(extra)]), { cwd: f.dir })[0];
  assert.equal(inspect({ done_file: 'missing.json' }).state, 'died');
  assert.equal(inspect({ pid: process.pid, done_file: 'missing.json' }).state, 'running');
  assert.match(inspect({ done_file: 'result files' }).warnings.join(' '), /not a regular|cannot be read/);
  writeFileSync(file, '{"ok":false}');
  assert.equal(inspect({ done_file: 'done.json/child' }).state, 'died');
  utimesSync(file, new Date('2000-01-01'), new Date('2000-01-01'));
  const started_at = '2020-01-01T00:00:00Z';
  const stale = inspect({ done_file: 'done.json', started_at });
  assert.equal(stale.state, 'died'); assert.match(stale.warnings.join(' '), /predates started_at/);
  unlinkSync(file); writeFileSync(file, '{"ok":false}');
  assert.equal(inspect({ done_file: 'done.json', started_at }).state, 'finished');
});

test('literal markers remain literal; path mistakes, ambiguous fields and malformed values are diagnosed', t => {
  const f = fixture(t), file = join(f.dir, 'done.json'); writeFileSync(file, '{}');
  const inspect = extra => inspectStateJobs(update(f, [deadJob(extra)]), { cwd: f.dir })[0];
  const wrong = inspect({ done_marker: file });
  assert.equal(wrong.state, 'died'); assert.match(wrong.warnings.join(' '), /use done_file/);
  writeFileSync(join(f.dir, 'job.log'), 'JOB_DONE\n');
  assert.equal(inspect({ done_marker: 'JOB_DONE' }).state, 'finished');
  const both = inspect({ done_marker: 'JOB_DONE', done_file: file });
  assert.equal(both.state, 'died'); assert.match(both.warnings.join(' '), /not both/);
  for (const done_file of ['', 42, {}, null, 'bad\0path']) {
    const row = inspect({ done_file });
    assert.equal(row.state, 'died'); assert.match(row.warnings.join(' '), /done_file must be/);
  }
});

test('platform path resolution preserves UNC identity and POSIX backslash filenames', t => {
  assert.equal(resolveJobPath('\\\\server\\share\\results\\done.json', { platform: 'win32', cwd: 'C:\\work' }), '\\\\server\\share\\results\\done.json');
  assert.equal(resolveJobPath('C:\\\\work\\\\done.json', { platform: 'win32', cwd: 'D:\\other' }), 'C:\\work\\done.json');
  assert.equal(resolveJobPath('done\\file.json', { platform: 'linux', cwd: '/tmp/work' }), '/tmp/work/done\\file.json');
  if (process.platform !== 'win32') {
    const f = fixture(t); writeFileSync(join(f.dir, 'done\\file.json'), '{}');
    assert.equal(inspectStateJobs(update(f, [deadJob({ done_file: 'done\\file.json' })]), { cwd: f.dir })[0].state, 'finished');
  }
});
