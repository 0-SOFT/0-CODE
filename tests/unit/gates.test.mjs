import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideContinuation } from '../../core/gates.mjs';
import { STOP_HOOK_BLOCK_CAP } from '../../core/loop-limits.mjs';

test('gate: blockers → stop', () => {
  const d = decideContinuation({ current_version: '1', blockers: [{ type: 'x' }] }, { sessionId: 's' });
  assert.equal(d.action, 'stop');
  assert.equal(d.stopCause, 'blockers');
  assert.ok(d.notify);
});

test('gate: released == current → stop', () => {
  const d = decideContinuation({ current_version: '1.0', released_version: '1.0' }, { sessionId: 's' });
  assert.equal(d.action, 'stop');
  assert.equal(d.stopCause, 'released');
});

test('gate: iteration >= max → stop', () => {
  const d = decideContinuation({ current_version: '1', iteration: 60, max_iterations: 60 }, { sessionId: 's' });
  assert.equal(d.action, 'stop');
  assert.equal(d.stopCause, 'iteration_cap');
});

test('gate: budget cap exceeded → stop', () => {
  const d = decideContinuation(
    { current_version: '1', budget_metrics: { version_cost_usd: 10, cap_usd: 5 } }, { sessionId: 's' });
  assert.equal(d.action, 'stop');
  assert.equal(d.stopCause, 'budget_cap');
});

test('cap_usd = 0 (disabled) → no stop', () => {
  const d = decideContinuation(
    { current_version: '1', budget_metrics: { version_cost_usd: 999, cap_usd: 0 } }, { sessionId: 's' });
  assert.equal(d.action, 'continue');
});

test('continue: iteration increment, adoption, the step instruction is carried through', () => {
  const st = { current_version: '1', iteration: 5, max_iterations: 60,
    last_session_id: 'old', session_count: 3, next_step_prompt: 'do X' };
  const d = decideContinuation(st, { sessionId: 'new' });
  assert.equal(d.action, 'continue');
  assert.equal(d.next.iteration, 6);
  assert.equal(d.next.sessionCount, 4);     // a session change → +1
  assert.equal(d.next.lastSessionId, 'new');
  assert.equal(d.adopted, true);            // old != new
  // v1.7.0: the reason is composite — machine truth first, then the instruction. The bare
  // instruction stays available on its own for anything that needs it.
  assert.equal(d.stepInstruction, 'do X');
  assert.ok(d.reason.includes('do X'), 'the instruction is still handed to the agent');
  assert.equal(d.staleNextPrompt, null, 'nothing suggests this instruction is out of date');
});

test('continue: the same session → session_count does not grow, adopted=false', () => {
  const st = { current_version: '1', iteration: 1, max_iterations: 60, last_session_id: 's', session_count: 2 };
  const d = decideContinuation(st, { sessionId: 's' });
  assert.equal(d.next.sessionCount, 2);
  assert.equal(d.adopted, false);
  assert.ok(d.reason.length > 0);           // the default reason when next_step_prompt is empty
});

// The loop stop contract, pinned down after a real misunderstanding: the instructions promised
// that an empty next_step_prompt stops the loop — it does NOT.
test('an empty next_step_prompt does NOT stop the loop — it means decide for yourself', () => {
  const d = decideContinuation({ current_version: '1', iteration: 0, max_iterations: 10,
    next_step_prompt: '' }, { sessionId: 'live' });
  assert.equal(d.action, 'continue', 'an empty prompt is not a stop command');
  assert.match(d.reason, /STATE/, 'a generic instruction to continue from STATE is substituted');
});

test('there are exactly four ways to stop the loop', () => {
  const base = { current_version: '1', iteration: 0, max_iterations: 10, next_step_prompt: 'do X' };
  const stop = st => decideContinuation({ ...base, ...st }, { sessionId: 'live' });
  assert.equal(stop({ blockers: [{ type: 'missing_resource' }] }).stopCause, 'blockers');
  assert.equal(stop({ released_version: '1' }).stopCause, 'released');
  assert.equal(stop({ iteration: 10 }).stopCause, 'iteration_cap');
  assert.equal(stop({ budget_metrics: { cap_usd: 5, version_cost_usd: 5 } }).stopCause, 'budget_cap');
  assert.equal(stop({}).action, 'continue', 'without those conditions the loop continues');
});

// The v1.4.0 claims audit: the budget gate compared version_cost_usd against the cap, but the
// supervisor never wrote it — the guard would not have fired at any level of spending.
test('budget gate: exceeding the cap stops the loop', () => {
  const state = {
    iteration: 1, max_iterations: 100, blockers: [],
    released_version: '0.0.0', current_version: '0.1.0',
    budget_metrics: { version_cost_usd: 12.5, cap_usd: 10 },
  };
  const d = decideContinuation(state);
  assert.equal(d.action, 'stop', 'the loop must stop when the cap is exceeded');
  assert.equal(d.stopCause, 'budget_cap');
});

test('budget gate: within the cap the loop continues', () => {
  const state = {
    iteration: 1, max_iterations: 100, blockers: [],
    released_version: '0.0.0', current_version: '0.1.0',
    budget_metrics: { version_cost_usd: 2, cap_usd: 10 },
  };
  assert.equal(decideContinuation(state).action, 'continue');
});

// --- v1.7.0: the step instruction must not be able to go stale ---------------------------------
//
// Reported from a live project (COINFLIPPER-REVERSE, running framework 1.6.1). The loop refused
// to finish: on EVERY Stop hook, for two whole chains of work, the agent was handed the same
// instruction written back in the 4.6.0 era — one that announced a blocker — while STATE had long
// since moved on to 6.4.0 with `blockers: []`. The text contradicted the machine state and still
// looked more authoritative than it.
//
// The root cause is not the hook and not the gates: it is that `next_step_prompt` is a CACHE of an
// instruction with no expiry date, and nothing on either the write or the read side checks whether
// the cache still describes the live position of the loop.

test('a step instruction left over from an earlier version is not handed to the agent', () => {
  const stale = 'Stage 4.6.0 (real parity) is CLOSED. Blocker awaiting_user_direction is in ' +
    'place (4.6.0-real-parity-complete): waiting for the user to decide.';
  const d = decideContinuation({
    current_version: '6.4.0',
    current_stage: 2,
    current_prompt_file: 'docs/prompts/6.0.0_stonks-adoption.md',
    blockers: [],
    iteration: 30,
    max_iterations: 1000,
    next_step_prompt: stale,
  }, { sessionId: 'live' });

  assert.equal(d.action, 'continue', 'empty blockers still mean the loop continues');
  assert.ok(!d.reason.includes(stale),
    'an instruction from another version must never reach the agent verbatim');
  assert.ok(d.staleNextPrompt,
    'the drivers need a flag so they can say out loud why the instruction was dropped');
  assert.match(d.reason, /STATE/,
    'the generic "work it out from STATE" instruction is substituted instead');
});

// The second symptom of the same report: the emitted reason ASSERTED a blocker while
// STATE.blockers was empty. The cure is not to police the wording of free text but to make sure
// free text is never the only signal — the machine truth is stated above it, and wins.
test('the continuation reason carries the machine truth about version and blockers', () => {
  const d = decideContinuation({
    current_version: '6.4.0',
    current_stage: 2,
    current_prompt_file: 'docs/prompts/6.0.0_stonks-adoption.md',
    blockers: [],
    iteration: 30,
    max_iterations: 1000,
    next_step_prompt: 'Blocker awaiting_user_direction is in place: waiting for the user to decide.',
  }, { sessionId: 'live' });

  assert.match(d.reason, /blockers: none/i,
    'whether a blocker exists is read from the field, never from the free text');
  assert.match(d.reason, /6\.4\.0/, 'the live version is stated too');
  assert.match(d.reason, /31\/1000/, 'and so is the iteration out of its cap');
});

// --- v1.9.0: the iteration cap becomes opt-in ---------------------------------------------------
//
// A deliberate change of defaults, made by the owner of the framework: a limit is set by whoever
// wants it, rather than standing in everybody's way. Until now an absent max_iterations quietly
// became 1000 — a number nobody chose for that project.
//
// What does NOT change: a cap that IS set keeps working exactly as before. Removing a default must
// not remove a limit somebody asked for.

test('no iteration cap is set → the loop is never stopped by one', () => {
  const d = decideContinuation(
    { current_version: '1', iteration: 100000, blockers: [] }, { sessionId: 'live' });
  assert.equal(d.action, 'continue', 'an absent cap must not be invented');
  assert.notEqual(d.stopCause, 'iteration_cap');
});

test('an explicitly disabled iteration cap (null, 0, negative) never stops the loop', () => {
  for (const value of [null, 0, -1]) {
    const d = decideContinuation(
      { current_version: '1', iteration: 5000, max_iterations: value, blockers: [] },
      { sessionId: 'live' });
    assert.equal(d.action, 'continue', `max_iterations=${JSON.stringify(value)} must mean "no cap"`);
  }
});

test('with no cap the machine truth says so instead of quoting an invented number', () => {
  const d = decideContinuation(
    { current_version: '1', iteration: 7, blockers: [] }, { sessionId: 'live' });
  assert.ok(!/\/1000/.test(d.reason), 'a cap nobody set must not appear in the header');
  assert.ok(!/\/1000/.test(d.systemMessage), 'nor in the session message');
  assert.match(d.reason, /iteration: 8 \(no cap\)/,
    'the header states plainly that there is no cap');
});

// The regression that matters most: this change removes a DEFAULT, not the feature.
test('an explicit iteration cap still stops the loop exactly where it is set', () => {
  const at = decideContinuation(
    { current_version: '1', iteration: 60, max_iterations: 60, blockers: [] }, { sessionId: 'live' });
  assert.equal(at.action, 'stop');
  assert.equal(at.stopCause, 'iteration_cap');

  const below = decideContinuation(
    { current_version: '1', iteration: 59, max_iterations: 60, blockers: [] }, { sessionId: 'live' });
  assert.equal(below.action, 'continue');
  assert.match(below.reason, /iteration: 60\/60/, 'an explicit cap is still shown as N/M');
});

// The backstop must sit above the loop's own limit or it silently becomes the primary limiter.
// This happened for real: a project carried max_iterations 4444 against a backstop of 1000, and
// nothing said a word — the cap somebody deliberately set was not the one that applied.
test('an iteration cap above the backstop is named out loud', () => {
  const over = STOP_HOOK_BLOCK_CAP + 1;
  const d = decideContinuation(
    { current_version: '1', iteration: 1, max_iterations: over, blockers: [] },
    { sessionId: 'live' });
  assert.equal(d.action, 'continue');
  assert.match(d.reason, /backstop/i, 'the agent is told which limit actually applies');
  assert.match(d.reason, new RegExp(String(over)));
});

test('a cap that fits under the backstop produces no warning', () => {
  const d = decideContinuation(
    { current_version: '1', iteration: 1, max_iterations: 60, blockers: [] }, { sessionId: 'live' });
  assert.ok(!/backstop/i.test(d.reason), 'nothing to warn about');
});

// v1.9.0. The spending cap is enforced only where the counter it compares against is actually
// written, and that is the supervisor alone. Rather than leave a guard that quietly does nothing,
// the driver says which one it is and the gate reports the truth.
test('a spending cap under the Stop hook is reported as unenforceable', () => {
  const state = { current_version: '1', iteration: 1, blockers: [],
    budget_metrics: { cap_usd: 25, version_cost_usd: 0 } };
  const d = decideContinuation(state, { sessionId: 'x', driver: 'stop-hook' });
  assert.match(d.reason, /cannot fire under the Stop hook/);
  assert.match(d.reason, /supervisor/, 'and where it does work is named');
});

test('the same cap under the supervisor produces no such note', () => {
  const state = { current_version: '1', iteration: 1, blockers: [],
    budget_metrics: { cap_usd: 25, version_cost_usd: 0 } };
  const d = decideContinuation(state, { sessionId: 'x', driver: 'supervisor' });
  assert.ok(!/cannot fire/.test(d.reason), 'here the cap is real');
});

test('no spending cap set → nothing is said about one in either driver', () => {
  for (const driver of ['stop-hook', 'supervisor']) {
    const d = decideContinuation(
      { current_version: '1', iteration: 1, blockers: [] }, { sessionId: 'x', driver });
    assert.ok(!/spending cap/.test(d.reason), `${driver}: silence about a cap nobody set`);
  }
});

// The cap still stops the loop wherever the counter did get filled — the note is about visibility,
// not about weakening the guard.
test('an exceeded spending cap still stops the loop', () => {
  const d = decideContinuation(
    { current_version: '1', iteration: 1, blockers: [], budget_metrics: { cap_usd: 25, version_cost_usd: 30 } },
    { sessionId: 'x', driver: 'stop-hook' });
  assert.equal(d.action, 'stop');
  assert.equal(d.stopCause, 'budget_cap');
});
