import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideContinuation } from '../../core/gates.mjs';

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

test('continue: iteration increment, adoption, reason taken from next_step_prompt', () => {
  const st = { current_version: '1', iteration: 5, max_iterations: 60,
    last_session_id: 'old', session_count: 3, next_step_prompt: 'do X' };
  const d = decideContinuation(st, { sessionId: 'new' });
  assert.equal(d.action, 'continue');
  assert.equal(d.next.iteration, 6);
  assert.equal(d.next.sessionCount, 4);     // a session change → +1
  assert.equal(d.next.lastSessionId, 'new');
  assert.equal(d.adopted, true);            // old != new
  assert.equal(d.reason, 'do X');
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
