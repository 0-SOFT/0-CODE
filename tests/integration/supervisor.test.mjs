import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { runLoop } from '../../core/supervisor.mjs';
import { mkTempProject, readFrontmatter } from '../helpers/index.mjs';

// A backend stub: implements the Backend interface (DI) and counts calls. Not a boundary mock but
// a controlled substitution honouring the contract — it lets us test the loop driver without a real CLI.
function stubBackend(runTurn) {
  return { id: 'stub', calls: 0, async runTurn(opts) { this.calls++; return runTurn(opts, this.calls); } };
}

test('runLoop: N continued iterations → iteration grows and the backend is called', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, max_iterations: 60, next_step_prompt: 'go' });
  const stub = stubBackend(() => ({ ok: true, output: 'x' }));
  try {
    const r = await runLoop({ stateFile: p.stateFile, backend: stub, maxLoops: 2, sessionId: 's', usePreflight: false });
    assert.equal(r.stopped, 'max_loops');
    assert.equal(r.loops, 2);
    assert.equal(stub.calls, 2);
    assert.equal(readFrontmatter(p.stateFile).iteration, 2);
  } finally { p.cleanup(); }
});

test('runLoop: turn_failed → stop', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, max_iterations: 60, next_step_prompt: 'go' });
  const stub = stubBackend(() => ({ ok: false, error: 'boom' }));
  try {
    const r = await runLoop({ stateFile: p.stateFile, backend: stub, maxLoops: 5, sessionId: 's', usePreflight: false });
    assert.equal(r.stopped, 'turn_failed');
    assert.equal(r.error, 'boom');
  } finally { p.cleanup(); }
});

test('runLoop: blockers → stop without calling the backend', async () => {
  const p = mkTempProject({ current_version: '1', blockers: [{ type: 'x' }], next_step_prompt: 'go' });
  const stub = stubBackend(() => ({ ok: true, output: 'x' }));
  try {
    const r = await runLoop({ stateFile: p.stateFile, backend: stub, maxLoops: 5, sessionId: 's', usePreflight: false });
    assert.equal(r.stopped, 'blockers');
    assert.equal(stub.calls, 0);
  } finally { p.cleanup(); }
});

test('runLoop: iteration cap → stop', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 60, max_iterations: 60, next_step_prompt: 'go' });
  const stub = stubBackend(() => ({ ok: true, output: 'x' }));
  try {
    const r = await runLoop({ stateFile: p.stateFile, backend: stub, maxLoops: 5, sessionId: 's', usePreflight: false });
    assert.equal(r.stopped, 'iteration_cap');
    assert.equal(stub.calls, 0);
  } finally { p.cleanup(); }
});

// --- v1.1.0, Phase 2: progress control ---

test('runLoop: 3 empty turns → escalation in the 3rd prompt, no_progress stop and a blocker in STATE', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, max_iterations: 60, next_step_prompt: 'go' });
  const prompts = [];
  const stub = stubBackend((opts) => { prompts.push(opts.prompt); return { ok: true, output: 'plan' }; });
  try {
    const r = await runLoop({ stateFile: p.stateFile, backend: stub, maxLoops: 10, sessionId: 's', usePreflight: false });
    assert.equal(r.stopped, 'no_progress');
    assert.equal(stub.calls, 3);
    assert.ok(!/SUPERVISOR ESCALATION/.test(prompts[0]));
    assert.ok(!/SUPERVISOR ESCALATION/.test(prompts[1]));
    assert.ok(/SUPERVISOR ESCALATION/.test(prompts[2]));
    const fm = readFrontmatter(p.stateFile);
    assert.equal(fm.blockers.length, 1);
    assert.equal(fm.blockers[0].type, 'no_progress');
    assert.equal(fm.iteration, 3);       // the supervisor's progress was recorded before the stop
  } finally { p.cleanup(); }
});

test('runLoop: a turn with progress resets the counter — no_progress never triggers', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, max_iterations: 60, next_step_prompt: 'go' });
  // The stub actually "works": each turn appends a line to the STATE body (a file change means progress).
  const stub = stubBackend(() => {
    writeFileSync(p.stateFile, readFileSync(p.stateFile, 'utf8') + '\n- step done');
    return { ok: true, output: 'x' };
  });
  try {
    const r = await runLoop({ stateFile: p.stateFile, backend: stub, maxLoops: 4, sessionId: 's', usePreflight: false });
    assert.equal(r.stopped, 'max_loops');
    assert.equal(stub.calls, 4);
    assert.equal(readFrontmatter(p.stateFile).blockers.length, 0);
  } finally { p.cleanup(); }
});

test('runLoop: the remaining budget is passed into runTurn as maxBudgetUsd', async () => {
  const p = mkTempProject({
    current_version: '1', iteration: 0, max_iterations: 60, next_step_prompt: 'go',
    budget_metrics: { version_cost_usd: 1, cap_usd: 3 },
  });
  let seen;
  const stub = stubBackend((opts) => { seen = opts.maxBudgetUsd; return { ok: true, output: 'x' }; });
  try {
    await runLoop({ stateFile: p.stateFile, backend: stub, maxLoops: 1, sessionId: 's', usePreflight: false });
    assert.equal(seen, 2);
  } finally { p.cleanup(); }
});

test('runLoop: with no cap the budget is not passed (undefined)', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, max_iterations: 60, next_step_prompt: 'go' });
  let seen = 'unset';
  const stub = stubBackend((opts) => { seen = opts.maxBudgetUsd; return { ok: true, output: 'x' }; });
  try {
    await runLoop({ stateFile: p.stateFile, backend: stub, maxLoops: 1, sessionId: 's', usePreflight: false });
    assert.equal(seen, undefined);
  } finally { p.cleanup(); }
});

test('runLoop: dry run → STATE is untouched and the backend is not called', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, max_iterations: 60, next_step_prompt: 'go' });
  const stub = stubBackend(() => ({ ok: true, output: 'x' }));
  try {
    const r = await runLoop({ stateFile: p.stateFile, backend: stub, dryRun: true, sessionId: 's', usePreflight: false });
    assert.equal(r.stopped, 'dry_run');
    assert.equal(stub.calls, 0);
    assert.equal(readFrontmatter(p.stateFile).iteration, 0);
  } finally { p.cleanup(); }
});

// v1.3.0: without an explicit --model the supervisor MUST pick a model through routing. It used to
// pass none at all, the engine fell back to its own default and the turn failed with a vague error.
test('runLoop: the model comes from routing when not set explicitly', async () => {
  const p = mkTempProject({ current_version: '1', released_version: '0', iteration: 0,
    max_iterations: 1, next_step_prompt: 'do X' });
  try {
    const seen = [];
    const stub = { id: 'opencode',
      async runTurn({ model }) { seen.push(model); return { ok: true, output: 'done' }; },
      guardCommand: () => null };
    await runLoop({ stateFile: p.stateFile, cwd: p.dir, backend: stub, maxLoops: 1, usePreflight: false });
    assert.equal(seen.length, 1);
    assert.match(seen[0], /kimi/, 'the opencode backend is expected to use a model from the Kimi preset');
  } finally { p.cleanup(); }
});

test('runLoop: an explicit model outranks routing', async () => {
  const p = mkTempProject({ current_version: '1', released_version: '0', iteration: 0,
    max_iterations: 1, next_step_prompt: 'do X' });
  try {
    const seen = [];
    const stub = { id: 'opencode',
      async runTurn({ model }) { seen.push(model); return { ok: true, output: 'done' }; },
      guardCommand: () => null };
    await runLoop({ stateFile: p.stateFile, cwd: p.dir, backend: stub, maxLoops: 1, model: 'own/model' });
    assert.equal(seen[0], 'own/model');
  } finally { p.cleanup(); }
});

// The v1.4.0 claims audit caught a hole: the budget gate compared version_cost_usd against the cap,
// but the supervisor NEVER wrote it — even though the turn cost is parsed and returned by the
// backend. The spending guard would never have fired, whatever the spend.
test('runLoop: the actual turn cost accumulates in STATE', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, max_iterations: 60, next_step_prompt: 'go' });
  const stub = stubBackend(() => ({ ok: true, output: 'x', costUsd: 0.25 }));
  try {
    await runLoop({ stateFile: p.stateFile, backend: stub, maxLoops: 3, sessionId: 's', usePreflight: false });
    const bm = readFrontmatter(p.stateFile).budget_metrics || {};
    assert.equal(Number(bm.version_cost_usd), 0.75, 'three turns at $0.25 must add up to $0.75');
  } finally { p.cleanup(); }
});

test('runLoop: the accumulated cost really stops the loop at the cap', async () => {
  const p = mkTempProject({
    current_version: '1', iteration: 0, max_iterations: 60, next_step_prompt: 'go',
    budget_metrics: { version_cost_usd: 0, cap_usd: 1 },
  });
  const stub = stubBackend(() => ({ ok: true, output: 'x', costUsd: 0.6 }));
  try {
    const r = await runLoop({ stateFile: p.stateFile, backend: stub, maxLoops: 10, sessionId: 's', usePreflight: false });
    assert.equal(r.stopped, 'budget_cap', 'after two turns at $0.6 the $1 cap must fire');
    assert.ok(stub.calls <= 3, 'the loop must not keep spinning after the cap is passed');
  } finally { p.cleanup(); }
});

// A turn without a cost (the backend returned none) must not corrupt the accumulation.
test('runLoop: a turn without a cost does not corrupt the accumulated total', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, max_iterations: 60, next_step_prompt: 'go' });
  const stub = stubBackend(() => ({ ok: true, output: 'x' }));
  try {
    await runLoop({ stateFile: p.stateFile, backend: stub, maxLoops: 2, sessionId: 's', usePreflight: false });
    const bm = readFrontmatter(p.stateFile).budget_metrics || {};
    assert.ok(bm.version_cost_usd === undefined || Number(bm.version_cost_usd) === 0);
  } finally { p.cleanup(); }
});

// v1.5.0 — the loop lock. Found in practice: two supervisors on the same docs/STATE.md competed
// for writes, and the iteration counter and the commits got mixed up.
test('runLoop: a second launch is refused while the owner is alive', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, max_iterations: 60, next_step_prompt: 'go' });
  try {
    const { acquireLock } = await import('../../core/loop-lock.mjs');
    const { dirname } = await import('node:path');
    const projectDir = dirname(dirname(p.stateFile));
    // another LIVE owner — we use the current process id, which is alive for certain
    acquireLock({ projectDir, pid: process.pid, engine: 'supervisor' });

    const stub = stubBackend(() => ({ ok: true, output: 'x' }));
    const r = await runLoop({ stateFile: p.stateFile, backend: stub, maxLoops: 3, sessionId: 's', usePreflight: false });
    assert.equal(r.stopped, 'locked', 'the second launch must refuse');
    assert.match(r.reason, /already running as process/);
    assert.equal(stub.calls, 0, 'not a single turn may run — the state belongs to somebody else');
  } finally { p.cleanup(); }
});

test('runLoop: with a dead owner the loop is taken over and runs', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, max_iterations: 60, next_step_prompt: 'go' });
  try {
    const { acquireLock, readLock } = await import('../../core/loop-lock.mjs');
    const { dirname } = await import('node:path');
    const projectDir = dirname(dirname(p.stateFile));
    // a process id that is certainly dead
    acquireLock({ projectDir, pid: 999999, engine: 'supervisor', pidAlive: () => true });

    const stub = stubBackend(() => ({ ok: true, output: 'x' }));
    const r = await runLoop({ stateFile: p.stateFile, backend: stub, maxLoops: 2, sessionId: 's', usePreflight: false });
    assert.equal(r.stopped, 'max_loops', 'after the take-over the loop must run');
    assert.equal(stub.calls, 2);
    assert.equal(readLock(projectDir), null, 'a normal exit releases the lock');
  } finally { p.cleanup(); }
});

// v1.5.0 — resilience to provider failures. A real case: the v1.3.0 acceptance run died on a single
// "UnknownError: Unexpected server error", although a retry would have gone through.
test('runLoop: a transient failure is survived by retries and the work completes', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, max_iterations: 60, next_step_prompt: 'go' });
  try {
    let calls = 0;
    const flaky = {
      id: 'stub', calls: 0,
      async runTurn() {
        this.calls++; calls++;
        // the first three attempts fail transiently, then it succeeds
        if (calls <= 3) return { ok: false, error: 'UnknownError: Unexpected server error' };
        return { ok: true, output: 'done' };
      },
    };
    const pauses = [];
    const r = await runLoop({
      stateFile: p.stateFile, backend: flaky, maxLoops: 1, sessionId: 's', usePreflight: false,
      sleep: async (ms) => { pauses.push(ms); },          // we do not really wait
      retryBackoff: { baseMs: 10, maxMs: 40 },
    });
    assert.equal(r.stopped, 'max_loops', 'the loop must survive the failure and finish the work');
    assert.equal(flaky.calls, 4, 'three failed attempts and one success');
    assert.deepEqual(pauses, [10, 20, 40], 'the pause doubles each time');
  } finally { p.cleanup(); }
});

test('runLoop: a real error stops immediately, with no retries', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, max_iterations: 60, next_step_prompt: 'go' });
  try {
    const stub = stubBackend(() => ({ ok: false, error: 'HTTP 401 Unauthorized: invalid api key' }));
    let slept = 0;
    const r = await runLoop({
      stateFile: p.stateFile, backend: stub, maxLoops: 5, sessionId: 's', usePreflight: false,
      sleep: async () => { slept++; },
    });
    assert.equal(r.stopped, 'turn_failed');
    assert.equal(r.failureKind, 'fatal');
    assert.equal(stub.calls, 1, 'a real error must not be retried');
    assert.equal(slept, 0, 'and there is nothing to wait for either');
  } finally { p.cleanup(); }
});

test('runLoop: a transient failure that outlives every retry stops the loop honestly', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, max_iterations: 60, next_step_prompt: 'go' });
  try {
    const stub = stubBackend(() => ({ ok: false, error: 'HTTP 503 Service Unavailable' }));
    const r = await runLoop({
      stateFile: p.stateFile, backend: stub, maxLoops: 5, sessionId: 's', usePreflight: false,
      sleep: async () => {}, retryBackoff: { baseMs: 1, maxMs: 2 },
    });
    assert.equal(r.stopped, 'turn_failed');
    assert.equal(r.failureKind, 'transient');
    assert.equal(stub.calls, 5, 'the first attempt plus four retries');
  } finally { p.cleanup(); }
});

// v1.5.0 — the engine self-check. Two reasons from experience: the response format is tied to the
// engine version (a format change means silent emptiness), and a wrong model is indistinguishable
// from a transient failure by its error text, which cost 75 seconds of useless retries.
test('runLoop: a failed self-check → the loop never starts', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, max_iterations: 60, next_step_prompt: 'go' });
  try {
    let turns = 0;
    const broken = {
      id: 'stub',
      async runTurn() { turns++; return { ok: true, output: '', sessionId: 's' }; }, // "success" with no text
    };
    const r = await runLoop({ stateFile: p.stateFile, backend: broken, maxLoops: 5, sessionId: 's' });
    assert.equal(r.stopped, 'preflight_failed');
    assert.match(r.problems.join(" "), /EMPTY|output format changed/);
    assert.equal(turns, 1, 'after a failed self-check there must be no working turns');
  } finally { p.cleanup(); }
});

test('runLoop: a passed self-check → the loop runs as usual', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, max_iterations: 60, next_step_prompt: 'go' });
  try {
    const healthy = {
      id: 'stub', calls: 0,
      async runTurn() { this.calls++; return { ok: true, output: 'OK', sessionId: 's', costUsd: 0.001 }; },
    };
    const r = await runLoop({ stateFile: p.stateFile, backend: healthy, maxLoops: 2, sessionId: 's' });
    assert.equal(r.stopped, 'max_loops');
    assert.equal(healthy.calls, 3, 'one self-check turn plus two working turns');
  } finally { p.cleanup(); }
});

test('runLoop: --no-preflight skips the self-check (for debugging)', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, max_iterations: 60, next_step_prompt: 'go' });
  try {
    const stub2 = stubBackend(() => ({ ok: true, output: 'x' }));
    const r = await runLoop({
      stateFile: p.stateFile, backend: stub2, maxLoops: 2, sessionId: 's', usePreflight: false,
    });
    assert.equal(r.stopped, 'max_loops');
    assert.equal(stub2.calls, 2, 'without the self-check there are only working turns');
  } finally { p.cleanup(); }
});
