// tests/integration/driver-progress.test.mjs — the loop must be able to tell a working agent from
// one waiting for something that will never happen.
//
// The framework documents this as a property of "the driver":
//   SKILL.md            "Every turn is measured against three signals... Two turns without any of
//                        them and the driver adds an escalation directive to your prompt; three and
//                        it records a `no_progress` blocker."
//   docs/failure-modes  "Three turns with no measurable progress → escalation, then a blocker."
//
// It is implemented in core/progress.mjs and wired into core/supervisor.mjs — the OpenCode driver.
// The Claude Code Stop hook, which is the default driver and the one in the incident behind
// v1.8.0, never imported it. The promise was true for one driver out of two.
//
// These checks drive the real hook, because "does the module exist" and "does the driver use it"
// are different questions and only the second one protects anyone.
//
// Written RED in v1.8.0 before any code and led to green by wiring core/progress.mjs into the hook
// through core/turn-progress.mjs, which supplies the memory a short-lived process needs. The
// detector itself was not rewritten: two detectors of one thing are the defect class v1.7.1 closed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkTempProject, readFrontmatter } from '../helpers/index.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STOP_HOOK = join(ROOT, 'hooks', 'ralph-loop-stop.mjs');

// One turn of the Claude Code driver: the session ends, the Stop hook decides what happens next.
// Nothing else changes between calls — no commit, no file written, no STATE edit by the agent.
// That is precisely the shape of an agent stuck waiting.
function turn(project, session = 'stuck') {
  const r = spawnSync(process.execPath, [STOP_HOOK], {
    input: JSON.stringify({ session_id: session, stop_hook_active: false }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: project.dir },
  });
  return `${r.stdout || ''}`;
}

// The hook measures the INTERVAL between its own invocations, so its first run establishes the
// baseline and measures nothing: turn 1 cannot be judged, turns 2..N can. The promise — two empty
// turns escalate, three record a blocker — is therefore counted in MEASURED turns, and on this
// driver that lands one turn later than on the supervisor, which snapshots before the first turn
// because it starts it. Stated here rather than hidden: the alternative is a detector that guesses
// whether the first turn did anything, and a guessing detector is worse than one that starts late.
test('driver: the Claude Code hook notices turns that changed nothing', () => {
  const p = mkTempProject({ current_version: '1', released_version: '0', iteration: 0,
    max_iterations: 60, next_step_prompt: 'wait for the background job' });
  try {
    turn(p);              // baseline: nothing to compare against yet
    turn(p);              // measured empty turn 1
    const third = turn(p);// measured empty turn 2 → escalation
    assert.match(
      third, /escalat/i,
      'after two turns with no progress the driver must escalate — the agent is told to check what ' +
      'it is actually waiting for, instead of waiting again',
    );
  } finally { p.cleanup(); }
});

test('driver: three measured empty turns record a no_progress blocker', () => {
  const p = mkTempProject({ current_version: '1', released_version: '0', iteration: 0,
    max_iterations: 60, next_step_prompt: 'wait for the background job' });
  try {
    turn(p);                       // baseline
    turn(p); turn(p); turn(p);     // three measured empty turns
    const blockers = readFrontmatter(p.stateFile).blockers || [];
    const kinds = blockers.map(b => b && b.type).filter(Boolean);
    assert.ok(
      kinds.includes('no_progress'),
      `three turns with nothing changing left blockers=${JSON.stringify(blockers)}; the loop cannot ` +
      'distinguish an agent that is working from one that is waiting forever',
    );
  } finally { p.cleanup(); }
});

test("driver: the hook's own bookkeeping does not count as progress", () => {
  // The hook writes iteration and last_action_at into STATE on every call. If the progress snapshot
  // is taken AFTER that write, the driver mistakes its own bookkeeping for the agent's work and can
  // never detect a stall. The supervisor already guards against this; the hook must too.
  const p = mkTempProject({ current_version: '1', released_version: '0', iteration: 0,
    max_iterations: 60, next_step_prompt: 'wait' });
  try {
    turn(p); turn(p);
    const before = readFrontmatter(p.stateFile).iteration;
    const third = turn(p);
    const after = readFrontmatter(p.stateFile).iteration;
    assert.ok(after > before, 'the iteration counter still advances — the loop keeps running');
    assert.match(
      third, /escalat|no_progress/i,
      'the counter advancing must not be read as the agent having done something',
    );
  } finally { p.cleanup(); }
});

test('driver: real work clears the stagnation count', () => {
  // The counter must be a stall detector, not a turn limit: an agent that does something must not
  // inherit the suspicion earned by earlier idle turns.
  const p = mkTempProject({ current_version: '1', released_version: '0', iteration: 0,
    max_iterations: 60, next_step_prompt: 'wait' });
  try {
    turn(p); turn(p);
    // The agent finally writes something of its own.
    writeFileSync(join(p.dir, 'result.txt'), 'measured\n', 'utf8');
    turn(p);
    const blockers = readFrontmatter(p.stateFile).blockers || [];
    assert.deepEqual(
      blockers.map(b => b && b.type).filter(t => t === 'no_progress'), [],
      'a turn that produced a file must reset the stagnation count, not trip the blocker',
    );
  } finally { p.cleanup(); }
});

// --- The class guard ---
// The defect was not "the hook lacks a feature". It was that a document described a behaviour as a
// property of "the driver" while one driver out of two implemented it, and nothing compared the
// promise with the code. Fixing only the hook would leave the class open for the next promise.
//
// This check is deliberately structural — it reads the drivers' imports rather than driving them.
// The behavioural proof for the Claude driver is the four checks above; the supervisor cannot be
// driven in a unit test without a live backend, and a guard that can only cover one driver is
// exactly the situation being guarded against.
test('class guard: every driver reaches every shared mechanism it is documented to have', () => {
  // One promise per row, with the module that keeps it. A driver that does not reach the module
  // cannot be keeping the promise, however confidently the document states it.
  const PROMISES = [
    { promise: 'turn progress is measured (SKILL.md, docs/failure-modes.md)',
      modules: ['progress.mjs', 'turn-progress.mjs'] },
    { promise: 'a commit picking up key storage is noticed (README, GUIDELINE, docs/failure-modes.md)',
      modules: ['secret-notice.mjs'] },
    { promise: 'the same function decides whether to continue (GUIDELINE)',
      modules: ['gates.mjs'] },
    { promise: 'a second loop on one project is refused (docs/failure-modes.md)',
      modules: ['loop-lock.mjs'] },
  ];
  const DRIVERS = [
    { name: 'Claude Code Stop hook', file: join(ROOT, 'hooks', 'ralph-loop-stop.mjs') },
    { name: 'OpenCode supervisor', file: join(ROOT, 'core', 'supervisor.mjs') },
  ];

  const broken = [];
  for (const d of DRIVERS) {
    const src = readFileSync(d.file, 'utf8');
    for (const p of PROMISES) {
      if (!p.modules.some(m => src.includes(m))) broken.push(`${d.name}: ${p.promise}`);
    }
  }
  assert.deepEqual(
    broken, [],
    'a behaviour documented as belonging to "the driver" is implemented by only some drivers. ' +
    'Two such promises were found in v1.8.0 — progress measurement and the secrets notice — each ' +
    'false for the default engine across several releases, because nothing compared the documents ' +
    'with the code.',
  );
});
