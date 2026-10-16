import { test } from 'node:test';
import { cleanupTempDir } from '../helpers/index.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyJob, inspectJobs, summariseJobs, inspectStateJobs, terminalAdvice } from '../../core/long-jobs.mjs';

// v1.13.0. From a real session: `sleep` appeared 447 times, thirty-nine `until … do sleep N; done`
// loops, and pauses of up to 900 seconds inside a single tool call. The human asked four different
// ways whether the loop was working or standing still, 124 interventions in one session.
//
// The root is not the sleeping. It is that the framework had no idea a long job existed, so the
// agent used the shell as its scheduler — and a turn spent waiting is the loop's only resource
// spent on nothing.

const at = s => `2026-09-01T10:${String(s).padStart(2, '0')}:00Z`;
const job = extra => ({ id: 'suite', pid: 4242, started_at: at(0), ...extra });

// The three states a completion marker ALONE cannot tell apart. This is exactly why
// `until grep -q MARKER log; do sleep 15; done` waits for ever: a job that dies before writing its
// marker looks identical to a job still working.
test('a live process with no marker yet is running', () => {
  const v = classifyJob(job({ done_marker: 'DONE' }), { now: at(5), alive: true, markerSeen: false });
  assert.equal(v.state, 'running');
});

test('a finished process that wrote its marker is finished', () => {
  const v = classifyJob(job({ done_marker: 'DONE' }), { now: at(5), alive: false, markerSeen: true });
  assert.equal(v.state, 'finished');
});

test('a dead process that never wrote its marker is DIED, not still running', () => {
  const v = classifyJob(job({ done_marker: 'DONE' }), { now: at(5), alive: false, markerSeen: false });
  assert.equal(v.state, 'died', 'this is the case a marker-only wait hangs on for ever');
  assert.match(v.why, /marker/i, 'and the reason says what was expected and never arrived');
});

// Without a marker there is nothing to compare against, so "no longer running" is all we can
// honestly say. Calling that "succeeded" would be inventing a fact.
test('with no marker declared, a dead process is simply finished', () => {
  const v = classifyJob(job(), { now: at(5), alive: false, markerSeen: false });
  assert.equal(v.state, 'finished');
  assert.match(v.why, /no marker/i, 'and it is stated that success was not verified');
});

test('a job that outlived its expectation is overdue while still alive', () => {
  const v = classifyJob(job({ expect_by: at(10) }), { now: at(30), alive: true, markerSeen: false });
  assert.equal(v.state, 'overdue');
  assert.match(v.why, /expected/i);
});

test('a job inside its expectation is merely running', () => {
  const v = classifyJob(job({ expect_by: at(30) }), { now: at(10), alive: true, markerSeen: false });
  assert.equal(v.state, 'running');
});

// A malformed record must never crash a driver: the loop has to keep running.
test('a broken record is reported, not thrown', () => {
  for (const bad of [null, {}, { id: 'x' }, { pid: 'not a number' }]) {
    const v = classifyJob(bad, { now: at(5), alive: false, markerSeen: false });
    assert.ok(v && typeof v.state === 'string', `${JSON.stringify(bad)} must classify, not throw`);
  }
});

// The whole point: checking costs milliseconds. Nothing here may wait, sleep or block.
test('inspectJobs never blocks: liveness and marker checks are injected', () => {
  const calls = [];
  const jobs = [job({ id: 'a', pid: 1 }), job({ id: 'b', pid: 2, done_marker: 'DONE' })];
  const out = inspectJobs(jobs, {
    now: at(5),
    pidAlive: pid => { calls.push(pid); return pid === 1; },
    markerSeen: () => true,
  });
  assert.deepEqual(calls, [1, 2], 'every job is checked exactly once');
  assert.equal(out.find(j => j.id === 'a').state, 'running');
  assert.equal(out.find(j => j.id === 'b').state, 'finished');
});

test('inspectJobs on an absent or malformed list returns an empty result', () => {
  for (const bad of [undefined, null, 'nonsense', {}]) {
    assert.deepEqual(inspectJobs(bad, { now: at(5) }), []);
  }
});

// This is the answer to the question the human asked four different ways in one session:
// "are we waiting for something, or just standing still?"
test('summariseJobs answers "working or standing still" in one line', () => {
  const inspected = [
    { id: 'suite', state: 'running' },
    { id: 'build', state: 'overdue' },
    { id: 'old', state: 'died' },
    { id: 'done', state: 'finished' },
  ];
  const line = summariseJobs(inspected);
  assert.match(line, /running: 1/i);
  assert.match(line, /overdue: 1/i);
  assert.match(line, /died: 1/i);
  assert.match(line, /finished: 1/i);
  assert.match(line, /suite|build|old/, 'and names the jobs, so the line is actionable');
});

test('summariseJobs says so plainly when nothing is running', () => {
  assert.equal(summariseJobs([]), null, 'no jobs means nothing to report');
});

// The gathering half touches the filesystem, so it is exercised against real files: a log that
// contains the marker, one that does not, and one that is not there at all.
test('inspectStateJobs reads real logs and never throws on a missing one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
  try {
    writeFileSync(join(dir, 'done.log'), 'work happened\nSUITE FINISHED\n');
    writeFileSync(join(dir, 'partial.log'), 'work happened\n');
    const state = { running_jobs: [
      { id: 'finished', pid: 999999, log: 'done.log', done_marker: 'SUITE FINISHED' },
      { id: 'died', pid: 999998, log: 'partial.log', done_marker: 'SUITE FINISHED' },
      { id: 'no-log', pid: 999997, log: 'absent.log', done_marker: 'SUITE FINISHED' },
    ] };
    const out = inspectStateJobs(state, { cwd: dir, now: '2026-09-01T10:00:00Z' });
    const by = Object.fromEntries(out.map(j => [j.id, j.state]));
    assert.equal(by.finished, 'finished');
    assert.equal(by.died, 'died');
    assert.equal(by['no-log'], 'died', 'an unreadable log means the marker was not seen, never a crash');
  } finally { await cleanupTempDir(dir); }
});

test('inspectStateJobs on a state without jobs is empty and cheap', () => {
  for (const st of [null, {}, { running_jobs: [] }, { running_jobs: 'nonsense' }]) {
    assert.deepEqual(inspectStateJobs(st, { cwd: '.' }), []);
  }
});

// --- v1.14.0: the audit of the mechanism shipped in v1.13.0 ------------------------------------
//
// Four corners where the classifier answered confidently and wrongly. Each one is the same class
// the module was built to close: a signal that is trusted further than it can actually reach.

// A process number is not a name. The operating system hands it out again once the process is gone,
// so a job that died hours ago can be "alive" in the shape of somebody else's process — and used to
// be reported as running for ever. The marker outranks liveness because it is evidence the job
// itself wrote.
test('a written marker outranks a live process number, which the system may have reused', () => {
  const v = classifyJob(job({ done_marker: 'DONE' }), { now: at(5), alive: true, markerSeen: true });
  assert.equal(v.state, 'finished', 'the job said it finished; a live number cannot outvote that');
});

test('a process still winding down after writing its marker is finished, not running', () => {
  const seen = [];
  const out = inspectJobs([job({ done_marker: 'DONE', log: 'suite.log' })], {
    now: at(5),
    pidAlive: () => true,
    markerSeen: (j) => { seen.push(j.id); return true; },
  });
  assert.deepEqual(seen, ['suite'], 'the marker must be looked at even when the process is alive');
  assert.equal(out[0].state, 'finished');
});

// "The process is gone and no marker was declared" used to mean "finished". It also covers a job
// that never started at all — and those must not share an answer. The log file separates them:
// a job that ran wrote something; a job that never started left no file behind.
test('a job whose log was never created did not finish — it never started', () => {
  const v = classifyJob(job({ log: 'suite.log' }), {
    now: at(5), alive: false, markerSeen: false, logExists: false,
  });
  assert.equal(v.state, 'died');
  assert.match(v.why, /never (started|created)/i, 'and the reason says which of the two it is');
});

test('a job with a log but no marker is finished, with success explicitly unverified', () => {
  const v = classifyJob(job({ log: 'suite.log' }), {
    now: at(5), alive: false, markerSeen: false, logExists: true,
  });
  assert.equal(v.state, 'finished');
  assert.match(v.why, /not verified|no marker/i);
});

// A deadline that cannot be read is a deadline that silently never fires. That is precisely the
// defect class this project keeps finding: a claim that quietly stops matching behaviour.
test('an unreadable deadline is reported rather than silently ignored', () => {
  const v = classifyJob(job({ expect_by: 'some time tomorrow' }), { now: at(5), alive: true });
  assert.equal(v.state, 'running', 'a broken deadline must never change the verdict');
  assert.ok(Array.isArray(v.warnings) && v.warnings.length > 0, 'but it must be said out loud');
  assert.match(v.warnings.join(' '), /expect_by/);
});

test('a deadline that precedes the start is reported', () => {
  const v = classifyJob({ id: 'suite', pid: 4242, started_at: at(10), expect_by: at(5) },
    { now: at(11), alive: true });
  assert.match(v.warnings.join(' '), /expect_by|before/i);
});

// A marker with nowhere to look for it can never be seen, so such a job is doomed to be reported
// as died the moment its process ends. Worth saying at the moment the record is read.
test('a marker declared with no log to look in is reported as unobservable', () => {
  const v = classifyJob({ id: 'suite', pid: 4242, done_marker: 'DONE' }, { now: at(5), alive: true });
  assert.match(v.warnings.join(' '), /log/i);
});

test('a record without a usable process number is reported', () => {
  const v = classifyJob({ id: 'suite', log: 'suite.log' }, { now: at(5), alive: false });
  assert.match(v.warnings.join(' '), /pid/i);
});

// Terminal records describe what already happened, and the registry describes what is happening
// now. The mechanism cannot decide for the agent whether the result was collected, so it says what
// to do instead of doing it.
test('terminal records come with an instruction to collect and clear them', () => {
  const advice = terminalAdvice([
    { id: 'suite', state: 'finished' }, { id: 'broken', state: 'died' },
  ]);
  assert.ok(advice, 'something must be said while terminal records sit in the registry');
  assert.match(advice, /suite|broken/, 'and it must name them');
  assert.match(advice, /running_jobs/, 'and say where to clear them');
});

test('nothing is said when every job is still running', () => {
  assert.equal(terminalAdvice([{ id: 'suite', state: 'running' }]), null);
});

test('inspectStateJobs tells a job that never started from one that simply ended', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
  try {
    writeFileSync(join(dir, 'ran.log'), 'work happened\n');
    const state = { running_jobs: [
      { id: 'ran', pid: 999999, log: 'ran.log' },
      { id: 'never-started', pid: 999998, log: 'absent.log' },
    ] };
    const by = Object.fromEntries(
      inspectStateJobs(state, { cwd: dir, now: '2026-09-01T10:00:00Z' }).map(j => [j.id, j.state]));
    assert.equal(by.ran, 'finished');
    assert.equal(by['never-started'], 'died');
  } finally { await cleanupTempDir(dir); }
});
