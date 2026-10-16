import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { runLoop } from '../../core/supervisor.mjs';
import { readLock, lockPath, acquireLock, releaseLock } from '../../core/loop-lock.mjs';
import { mkTempProject, cleanupTempDir, readFrontmatter } from '../helpers/index.mjs';

const scratch = process.env.FRAMEWORK_TEST_TMPDIR || tmpdir();
const project = (state = {}) => mkTempProject({ current_version: '1', iteration: 0,
  next_step_prompt: 'work', ...state }, { baseDir: scratch });
const success = () => ({ ok: true, output: 'OK', sessionId: 'probe', costUsd: 0.01,
  usage: { inputTokens: 1, outputTokens: 1 }, usageTotal: { inputTokens: 1, outputTokens: 1 } });

function holdMutation(projectDir) {
  const guard = lockPath(projectDir) + '.guard', marker = join(guard, 'owner-01234567-abcd-4567-890a-0123456789ab.json');
  mkdirSync(guard); writeFileSync(marker, JSON.stringify({ pid: process.pid, host: hostname() }));
  return () => { unlinkSync(marker); rmdirSync(guard); };
}

test('a brief busy mutex delays work until serialized ownership is confirmed and cleans its timer', async t => {
  const p = project(); const initialListeners = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'].map(s => process.listenerCount(s));
  let releaseTimer, leave, calls = 0, released = false, cleared = 0;
  const originalClear = globalThis.clearInterval;
  t.mock.method(globalThis, 'clearInterval', timer => { cleared++; return originalClear(timer); });
  const backend = { id: 'stub', async ensureReady() {
    if (leave || released) return;
    leave = holdMutation(p.dir);
    releaseTimer = setTimeout(() => { leave(); leave = null; released = true; }, 40);
  }, async runTurn() {
    calls++; assert.equal(released, true, 'work must not start from a busy snapshot'); return success();
  } };
  try {
    const result = await runLoop({ stateFile: p.stateFile, backend, usePreflight: false, maxLoops: 1, heartbeatMs: 5 });
    assert.equal(result.stopped, 'max_loops'); assert.equal(calls, 1);
    assert.equal(readFrontmatter(p.stateFile).iteration, 1); assert.equal(readLock(p.dir), null);
    assert.equal(cleared, 1);
    assert.deepEqual(['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'].map(s => process.listenerCount(s)), initialListeners);
  } finally { clearTimeout(releaseTimer); if (leave) leave(); t.mock.restoreAll(); await cleanupTempDir(p.dir); }
});

for (const phase of ['before-work', 'after-work']) {
  test(`persistent busy mutex ${phase} gives lock_busy without STATE writes or invented loss`, async t => {
    const p = project(); const before = readFileSync(p.stateFile);
    const initialListeners = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'].map(s => process.listenerCount(s));
    let leave, calls = 0, cleared = 0;
    const originalClear = globalThis.clearInterval;
    t.mock.method(globalThis, 'clearInterval', timer => { cleared++; return originalClear(timer); });
    const backend = { id: 'stub', async ensureReady() {
      if (phase === 'before-work' && !leave) leave = holdMutation(p.dir);
    }, async runTurn() { calls++; leave = holdMutation(p.dir); return success(); } };
    try {
      const result = await runLoop({ stateFile: p.stateFile, backend, usePreflight: false, maxLoops: 1, heartbeatMs: 5 });
      assert.equal(result.stopped, 'lock_busy'); assert.equal(result.loops, 0);
      assert.equal(calls, phase === 'before-work' ? 0 : 1);
      assert.deepEqual(readFileSync(p.stateFile), before);
      assert.equal(readLock(p.dir).pid, process.pid, 'busy is not a claim that ownership was lost');
      assert.equal(cleared, 1);
      assert.deepEqual(['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'].map(s => process.listenerCount(s)), initialListeners);
    } finally { if (leave) leave(); t.mock.restoreAll(); await cleanupTempDir(p.dir); }
  });
}

test('dispatching the registered signal handler during async confirmation exits the real process without work or STATE writes', async () => {
  const p = project(), worker = join(p.dir, 'signal-worker.mjs');
  const before = readFileSync(p.stateFile), supervisor = new URL('../../core/supervisor.mjs', import.meta.url).href;
  writeFileSync(worker, `import {runLoop} from ${JSON.stringify(supervisor)};
import {mkdirSync,writeFileSync} from 'node:fs';import {hostname} from 'node:os';
const [project,stateFile]=process.argv.slice(2);
process.on('message',message=>{if(message==='signal')process.emit('SIGTERM');});
runLoop({stateFile,usePreflight:false,heartbeatMs:5,backend:{id:'stub',
  async ensureReady(){const guard=project+'/docs/.loop.lock.guard';mkdirSync(guard);
    writeFileSync(guard+'/owner-01234567-abcd-4567-890a-0123456789ab.json',JSON.stringify({pid:process.pid,host:hostname()}));
    process.send({type:'ready'});},
  async runTurn(){process.send({type:'unexpected-work'});return {ok:true};}}})
 .then(result=>{process.send({type:'unexpected-completion',result});process.disconnect();})
 .catch(error=>{process.send({type:'error',error:error.stack});process.exitCode=1;process.disconnect();});
`);
  const child = fork(worker, [p.dir, p.stateFile], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const safety = setTimeout(() => child.kill(), 15000);
  const messages = [];
  const closed = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('signal worker did not enter async confirmation')), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.on('message', message => {
        messages.push(message);
        if (message.type === 'ready') { clearTimeout(timer); resolve(); }
        if (message.type === 'error') { clearTimeout(timer); reject(new Error(message.error)); }
      });
    });
    child.send('signal');
    const result = await closed;
    assert.equal(result.code, 130);
    assert.equal(messages.some(message => message.type === 'unexpected-work' || message.type === 'unexpected-completion'), false);
    assert.deepEqual(readFileSync(p.stateFile), before);
    assert.equal(acquireLock({ projectDir: p.dir }).acquired, true, 'the exited holder leaves no permanent mutex obstruction');
    assert.equal(releaseLock({ projectDir: p.dir }), true);
  } finally {
    clearTimeout(safety);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed; await cleanupTempDir(p.dir);
  }
});

test('a failed STATE write reports the real subprocess error and releases the lock', async t => {
  const p = project();
  let diagnostic = '';
  t.mock.method(process.stderr, 'write', value => { diagnostic += value; return true; });
  const backend = { id: 'stub', async runTurn() {
    writeFileSync(p.stateFile, 'damaged state');
    return success();
  } };
  try {
    const result = await runLoop({ stateFile: p.stateFile, backend, usePreflight: false });
    assert.equal(result.stopped, 'state_write_failed');
    assert.match(result.error, /update-state: no YAML frontmatter found/);
    assert.match(diagnostic, /STATE update failed: update-state: no YAML frontmatter found/);
    assert.equal(readFileSync(p.stateFile, 'utf8'), 'damaged state');
    assert.equal(readLock(p.dir), null);
  } finally { t.mock.restoreAll(); await cleanupTempDir(p.dir); }
});

test('protection is restored before engine checks, the probe and each retry', async () => {
  const p = project();
  const guard = join(p.dir, 'guard.txt');
  writeFileSync(guard, 'damaged before preflight');
  const order = [];
  let calls = 0;
  const backend = { id: 'stub',
    async ensureReady() { order.push('restore'); writeFileSync(guard, 'protected'); },
    async checkEngine() {
      order.push('check'); assert.equal(readFileSync(guard, 'utf8'), 'protected');
      return { ok: true, notes: [] };
    },
    async runTurn() {
      calls++; order.push(`turn ${calls}`);
      assert.equal(readFileSync(guard, 'utf8'), 'protected');
      writeFileSync(guard, 'damaged by previous attempt');
      return calls === 2 ? { ok: false, error: 'HTTP 503 Service Unavailable' } : success();
    },
  };
  try {
    const r = await runLoop({ stateFile: p.stateFile, backend, maxLoops: 1, sleep: async () => {} });
    assert.equal(r.stopped, 'max_loops');
    assert.deepEqual(order, ['restore', 'check', 'turn 1', 'restore', 'turn 2', 'restore', 'turn 3']);
    assert.equal(readFrontmatter(p.stateFile).iteration, 1);
  } finally { await cleanupTempDir(p.dir); }
});

test('a restoration failure blocks the probe, first attempt or retry and releases resources', async (t) => {
  for (const phase of ['preflight', 'first attempt', 'retry']) {
    await t.test(phase, async (t) => {
      const p = project();
      const initialState = readFileSync(p.stateFile, 'utf8');
      const initialListeners = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'].map(s => process.listenerCount(s));
      const originalClear = globalThis.clearInterval;
      let cleared = 0, restores = 0, checks = 0, turns = 0;
      t.mock.method(globalThis, 'clearInterval', timer => { cleared++; return originalClear(timer); });
      const backend = { id: 'stub',
        async ensureReady() {
          restores++;
          await new Promise(resolve => setTimeout(resolve, 20));
          if (phase !== 'retry' || restores === 2) throw new Error('reference is unreadable');
        },
        async checkEngine() { checks++; return { ok: true }; },
        async runTurn() { turns++; return { ok: false, error: 'HTTP 503 Service Unavailable' }; },
      };
      try {
        const r = await runLoop({ stateFile: p.stateFile, backend, maxLoops: 1, heartbeatMs: 5,
          usePreflight: phase === 'preflight', sleep: async () => {} });
        assert.equal(r.stopped, 'protection_failed');
        assert.match(r.error, /reference is unreadable/);
        assert.equal(checks, 0);
        assert.equal(turns, phase === 'retry' ? 1 : 0);
        assert.equal(readFileSync(p.stateFile, 'utf8'), initialState);
        assert.equal(readLock(p.dir), null);
        assert.equal(cleared, 1, 'the heartbeat must be stopped on restoration failure');
        assert.deepEqual(['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'].map(s => process.listenerCount(s)), initialListeners);
      } finally { t.mock.restoreAll(); await cleanupTempDir(p.dir); }
    });
  }
});

test('a thrown adapter call releases the lock, heartbeat and process listeners', async (t) => {
  const p = project();
  const originalClear = globalThis.clearInterval;
  let cleared = 0;
  t.mock.method(globalThis, 'clearInterval', timer => { cleared++; return originalClear(timer); });
  const backend = { id: 'stub', async runTurn() { throw new Error('adapter crashed'); } };
  try {
    await assert.rejects(runLoop({ stateFile: p.stateFile, backend, usePreflight: false,
      heartbeatMs: 5 }), /adapter crashed/);
    assert.equal(readLock(p.dir), null);
    assert.equal(cleared, 1);
    assert.equal(readFrontmatter(p.stateFile).iteration, 0);
  } finally { t.mock.restoreAll(); await cleanupTempDir(p.dir); }
});

test('loss of ownership during restoration prevents the preflight launch', async () => {
  const p = project();
  let calls = 0;
  const backend = { id: 'stub', async ensureReady() {
    writeFileSync(lockPath(p.dir), JSON.stringify({ pid: 4242, host: 'other-host', engine: 'other',
      sessionId: 'other', liveness: { kind: 'heartbeat', id: 'other' },
      startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
  }, async runTurn() { calls++; return success(); } };
  try {
    const r = await runLoop({ stateFile: p.stateFile, backend });
    assert.equal(r.stopped, 'lock_lost');
    assert.equal(calls, 0);
    assert.equal(readLock(p.dir).sessionId, 'other', 'do not remove the new owner lock');
  } finally { await cleanupTempDir(p.dir); }
});

test('a positive Codex USD cap refuses before restoration or any engine call', async () => {
  for (const usePreflight of [true, false]) {
    const p = project({ budget_metrics: { cap_usd: 3, version_cost_usd: 0 } });
    let calls = 0;
    const backend = { id: 'codex', async ensureReady() { calls++; },
      async checkEngine() { calls++; return { ok: true }; }, async runTurn() { calls++; return success(); } };
    try {
      const initial = readFileSync(p.stateFile, 'utf8');
      const r = await runLoop({ stateFile: p.stateFile, backend, usePreflight });
      assert.equal(r.stopped, 'unsupported_budget');
      assert.match(r.error, /cap_usd.*tokens, not USD/);
      assert.equal(calls, 0);
      assert.equal(readFileSync(p.stateFile, 'utf8'), initial);
      assert.equal(readLock(p.dir), null);
    } finally { await cleanupTempDir(p.dir); }
  }
});

test('absent, null, zero and negative Codex caps still permit ordinary launches', async () => {
  for (const cap of [undefined, null, 0, -1]) {
    const p = project({ budget_metrics: cap === undefined ? {} : { cap_usd: cap } });
    let calls = 0;
    const backend = { id: 'codex', async runTurn(opts) {
      calls++; assert.equal(opts.maxBudgetUsd, undefined); return success();
    } };
    try {
      const r = await runLoop({ stateFile: p.stateFile, backend, maxLoops: 1 });
      assert.equal(r.stopped, 'max_loops');
      assert.equal(calls, 2, 'one probe and one working turn');
    } finally { await cleanupTempDir(p.dir); }
  }
});

test('dry-run and stop gates never restore protection or launch an engine', async () => {
  for (const mode of ['dry-run', 'released', 'blockers']) {
    const p = project(mode === 'released' ? { released_version: '1' }
      : mode === 'blockers' ? { blockers: [{ type: 'resource' }] } : {});
    const filesBefore = readdirSync(join(p.dir, 'docs')).sort();
    const stateBefore = readFileSync(p.stateFile, 'utf8');
    let calls = 0;
    const backend = { id: 'stub', async ensureReady() { calls++; }, async runTurn() { calls++; return success(); } };
    try {
      const r = await runLoop({ stateFile: p.stateFile, backend, dryRun: mode === 'dry-run' });
      assert.equal(r.stopped, mode === 'dry-run' ? 'dry_run' : mode);
      assert.equal(calls, 0);
      assert.equal(readFileSync(p.stateFile, 'utf8'), stateBefore);
      assert.equal(existsSync(lockPath(p.dir)), false);
      if (mode === 'dry-run') assert.deepEqual(readdirSync(join(p.dir, 'docs')).sort(), filesBefore);
    } finally { await cleanupTempDir(p.dir); }
  }
});
