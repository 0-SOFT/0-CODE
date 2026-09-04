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
    // Another LIVE owner, and genuinely another one. Using this process's own number would now read
    // as "the loop is already ours" — identity comes from the evidence, and the evidence would
    // match. So the owner here is a Claude Code session proved alive by a transcript we just wrote,
    // which is exactly the shape of owner this supervisor has to yield to in the field.
    acquireLock({
      projectDir, pid: 4242, engine: 'stop-hook', sessionId: 'a-live-claude-session',
      liveness: { kind: 'file', id: p.stateFile },     // freshly written, so freshly alive
    });

    const stub = stubBackend(() => ({ ok: true, output: 'x' }));
    const r = await runLoop({ stateFile: p.stateFile, backend: stub, maxLoops: 3, sessionId: 's', usePreflight: false });
    assert.equal(r.stopped, 'locked', 'the second launch must refuse');
    assert.match(r.reason, /already driven by/);
    assert.match(r.reason, /a-live-claude-session/, 'and it must name who holds the loop');
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

// --- v1.15.0: the supervisor is made the equal of the Stop hook, not its understudy -------------

// DEFECT 1 — one rule, two implementations. "Two empty turns escalate, three record a no_progress
// blocker" lives on disk for the Stop hook (core/turn-progress.mjs, survives a restart) and in a
// local variable for the supervisor (reset by every launch). So a run that is restarted can never
// reach three, and the blocker never arrives. This is the drift class v1.7.1 spent a version on.
test('the count of empty turns survives a restart of the supervisor', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, next_step_prompt: 'go' });
  try {
    const idle = () => stubBackend(() => ({ ok: true, output: 'nothing happened' }));
    // Two launches of one turn each: exactly the shape of a run interrupted and resumed.
    await runLoop({ stateFile: p.stateFile, backend: idle(), maxLoops: 1, sessionId: 's', usePreflight: false });
    await runLoop({ stateFile: p.stateFile, backend: idle(), maxLoops: 1, sessionId: 's', usePreflight: false });
    const r = await runLoop({ stateFile: p.stateFile, backend: idle(), maxLoops: 1, sessionId: 's', usePreflight: false });
    assert.equal(r.stopped, 'no_progress',
      'three empty turns are three empty turns, whether or not the process was restarted between them');
    assert.ok((readFrontmatter(p.stateFile).blockers || []).some(b => b.type === 'no_progress'));
  } finally { p.cleanup(); }
});

// DEFECT 3 — the engine self-check ran BEFORE the state was even read, so starting the supervisor on
// a finished version spent a paid engine call in order to then say "the loop is over".
test('a stop gate is reached without spending a single engine call on a self-check', async () => {
  const p = mkTempProject({ current_version: '1', released_version: '1', next_step_prompt: 'go' });
  try {
    const stub = stubBackend(() => ({ ok: true, output: 'x' }));
    const r = await runLoop({ stateFile: p.stateFile, backend: stub, maxLoops: 5, sessionId: 's' });
    assert.equal(r.stopped, 'released');
    assert.equal(stub.calls, 0, 'nothing may be paid for before we know there is work to do');
  } finally { p.cleanup(); }
});

// DEFECT 4 — the lock was refreshed only BETWEEN turns, and the deadline was chosen from a number
// that turned out not to be the number. core/loop-lock.mjs claimed "an agent turn is capped at
// 15 minutes (OPENCODE_TURN_TIMEOUT_MS), so 30 minutes gives a twofold margin". The constant is
// 4 HOURS. Measured: the turn cap is eight times the lock deadline, not half of it — so an
// ordinary long turn could have its lock taken from underneath a working process, which is exactly
// the state corruption the lock exists to prevent.
test('the lock keeps beating while a turn is still running', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, next_step_prompt: 'go' });
  try {
    const { readLock } = await import('../../core/loop-lock.mjs');
    const { dirname } = await import('node:path');
    const projectDir = dirname(dirname(p.stateFile));
    // Both readings are taken INSIDE the turn, so the only thing that can move the heartbeat
    // between them is a beat of its own. Comparing against a moment before runLoop would have
    // passed on the old code too — acquireLock stamps the lock on the way in — and a test that
    // cannot fail is not a test.
    let atTurnStart = null, atTurnEnd = null;
    const slow = stubBackend(async () => {
      atTurnStart = readLock(projectDir).heartbeatAt;
      await new Promise(r => setTimeout(r, 400));       // a turn that outlives the beat interval
      atTurnEnd = readLock(projectDir).heartbeatAt;
      return { ok: true, output: 'x' };
    });
    await runLoop({
      stateFile: p.stateFile, backend: slow, maxLoops: 1, sessionId: 's', usePreflight: false,
      heartbeatMs: 100,
    });
    assert.ok(atTurnStart && atTurnEnd, 'the lock must exist for the whole turn');
    assert.ok(atTurnEnd > atTurnStart,
      'a working turn must keep proving it is alive, or a long turn loses its own lock');
  } finally { p.cleanup(); }
});

// DEFECT 5 — the `lock_lost` exits returned without going through finish(), and killAllChildren was
// wired only to process exit. Used as a library — which is how the tests and any wrapper use it —
// the engine processes of an abandoned loop simply kept running.
test('no exit path leaves an engine process behind', async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, next_step_prompt: 'go' });
  try {
    const { runCliAsync } = await import('../../core/backends/spawn-cli.mjs');
    const { isPidAlive } = await import('../../core/loop-lock.mjs');
    const { dirname } = await import('node:path');
    const projectDir = dirname(dirname(p.stateFile));
    let childPid = null;
    const stub = stubBackend(async () => {
      // A real long-lived engine process, launched the way the adapters launch one.
      const running = runCliAsync(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {});
      await new Promise(r => setTimeout(r, 300));
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      try {
        childPid = JSON.parse(readFileSync(join(projectDir, 'docs', '.loop-children'), 'utf8')).pids[0];
      } catch { childPid = null; }
      // Somebody else takes the loop while our turn is in flight. The lock file is written
      // directly, because since v1.14.0 acquireLock correctly REFUSES a live owner — which is the
      // whole point of that version. What we are reproducing here is the on-disk result of a
      // take-over that already happened, not the act of stealing a live lock.
      const { writeFileSync: write } = await import('node:fs');
      const { lockPath } = await import('../../core/loop-lock.mjs');
      write(lockPath(projectDir), JSON.stringify({
        pid: 4242, host: 'other-host', engine: 'other', sessionId: 'other',
        liveness: { kind: 'heartbeat', id: 'other' },
        startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
      }), 'utf8');
      running.catch(() => {});
      return { ok: true, output: 'x' };
    });
    const r = await runLoop({ stateFile: p.stateFile, backend: stub, maxLoops: 1, sessionId: 's', usePreflight: false });
    assert.equal(r.stopped, 'lock_lost');
    assert.ok(childPid, 'the probe must actually have started an engine process');
    await new Promise(res => setTimeout(res, 500));
    assert.equal(isPidAlive(childPid), false,
      'an abandoned loop must not leave its engine running');
  } finally { p.cleanup(); }
});

// DEFECT 2 — `--max` without a usable number produced NaN, and `loops >= NaN` is always false, so a
// request for a LIMIT silently became the absence of one. Measured before the fix:
//   maxLoops = NaN | loops >= maxLoops -> false -> no limit at all
// Turning a request to be constrained into an unbounded run is the worst possible reading of it.
test('an option that asks for a limit never silently becomes no limit', async () => {
  const { parseArgs } = await import('../../core/supervisor.mjs');
  for (const argv of [['--max'], ['--max', 'lots'], ['--max', '0'], ['--max', '-3']]) {
    const r = parseArgs(argv);
    assert.ok(r.error, `${JSON.stringify(argv)} must be refused, not quietly ignored`);
    assert.match(r.error, /--max/);
  }
  assert.equal(parseArgs(['--max', '5']).maxLoops, 5, 'a real number still works');
  for (const flag of ['--state', '--model', '--backend']) {
    assert.ok(parseArgs([flag]).error, `${flag} with no value must be refused`);
  }
});

// DEFECT 6 — WHERE THE ENGINE RUNS, found the hard way rather than by measurement. `cwd` defaulted
// to `process.cwd()`, so a supervisor started from one directory with `--state` pointing at another
// drove one project while running the engine inside a different one. In the incident that exposed
// this, that meant a real Claude Code session started inside the framework repository, on an
// instruction meant for another project, next to a session already working there.
test("the engine runs in the project the state belongs to, not where the supervisor was called", async () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, next_step_prompt: 'go' });
  try {
    const { dirname } = await import('node:path');
    const projectDir = dirname(dirname(p.stateFile));
    let seen = null;
    const stub = stubBackend((opts) => { seen = opts.cwd; return { ok: true, output: 'x' }; });
    await runLoop({ stateFile: p.stateFile, backend: stub, maxLoops: 1, sessionId: 's', usePreflight: false });
    assert.equal(seen, projectDir,
      'the project is dirname(dirname(stateFile)), never the directory the process happens to be in');
  } finally { p.cleanup(); }
});

test("an explicit --cwd still wins, for a state file kept outside its project", async () => {
  const { parseArgs } = await import('../../core/supervisor.mjs');
  assert.equal(parseArgs(['--cwd', '/somewhere']).cwd, '/somewhere');
  assert.ok(parseArgs(['--cwd']).error, 'and a missing value is refused like every other option');
});
