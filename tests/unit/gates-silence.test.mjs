// tests/unit/gates-silence.test.mjs — silence as an observable signal.
//
// lib/update-state.mjs has always written `last_action_at`. Measured before v1.8.0: no line of
// core/, lib/ or hooks/ ever read it. The field was decoration.
//
// Reading it closes a case the turn-based progress detector cannot see: turns that DO happen, are
// long, and produce nothing — an agent polling something that already finished, or waiting on a
// condition that will never be true.
//
// It is deliberately a WARNING and never a stop. A false stop costs more than a false warning: the
// loop exists to run without a human, and stopping it on a guess would hand the human back exactly
// the job the framework is meant to do.
//
// Honest limit, recorded so nobody over-claims later: this would NOT have prevented the incident
// behind v1.8.0. There the Stop hook was never registered in the running process, so the gates ran
// zero times and no check inside them could have fired.
//
// Written RED in v1.8.0 before any code. The threshold lives in STATE as stall_timeout_minutes and
// defaults to 20 minutes; core/gates.mjs pushes the warning into the machine-truth header, where
// every other machine-derived warning already goes, so the header stays first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideContinuation } from '../../core/gates.mjs';

const MINUTE = 60 * 1000;

function stateAgedBy(minutes, extra = {}) {
  return {
    current_version: '1.0.0',
    released_version: '0.9.0',
    blockers: [],
    iteration: 3,
    max_iterations: 60,
    next_step_prompt: 'carry on with the current step',
    last_action_at: new Date(Date.now() - minutes * MINUTE).toISOString(),
    ...extra,
  };
}

test('silence: a long-untouched STATE puts a warning in front of the agent', () => {
  const d = decideContinuation(stateAgedBy(120), { sessionId: 's' });
  assert.equal(d.action, 'continue');
  assert.match(
    d.reason, /not changed|silence|stall/i,
    'two hours without a single STATE write and the agent is told nothing — this is what an agent ' +
    'waiting for an event that already happened looks like from the outside',
  );
});

test('silence: a warning is never a stop', () => {
  const d = decideContinuation(stateAgedBy(60 * 24), { sessionId: 's' });
  assert.equal(d.action, 'continue', 'silence is a suspicion, not a verdict');
  assert.ok(!d.stopCause, `silence produced a stop cause: ${d.stopCause}`);
});

test('silence: a recently touched STATE says nothing', () => {
  const d = decideContinuation(stateAgedBy(1), { sessionId: 's' });
  assert.doesNotMatch(
    d.reason, /not changed for|silence detected|stalled/i,
    'a warning on every turn is a warning nobody reads',
  );
});

test('silence: the threshold comes from STATE, with a default when it is absent', () => {
  const quiet = stateAgedBy(30, { stall_timeout_minutes: 90 });
  assert.doesNotMatch(
    decideContinuation(quiet, { sessionId: 's' }).reason, /not changed|silence|stall/i,
    'a project that raised the threshold must not be warned below it',
  );
  const loud = stateAgedBy(30, { stall_timeout_minutes: 10 });
  assert.match(
    decideContinuation(loud, { sessionId: 's' }).reason, /not changed|silence|stall/i,
    'a project that lowered the threshold must be warned above it',
  );
});

test('silence: a STATE with no last_action_at still works', () => {
  // Projects created before v1.8.0, and the very first turn of any project.
  const st = stateAgedBy(120);
  delete st.last_action_at;
  const d = decideContinuation(st, { sessionId: 's' });
  assert.equal(d.action, 'continue');
  assert.doesNotMatch(d.reason, /not changed|silence|stall/i, 'absence of a timestamp is not silence');
});

test('silence: an unparseable last_action_at is ignored rather than treated as ancient', () => {
  const d = decideContinuation(stateAgedBy(1, { last_action_at: 'not a date' }), { sessionId: 's' });
  assert.equal(d.action, 'continue');
  assert.doesNotMatch(d.reason, /not changed|silence|stall/i);
});

test('silence: the machine-truth header still comes first', () => {
  // v1.7.0 put the machine facts at the top of every continuation reason precisely so free text
  // could not outrank them. A warning must be added under that block, not in front of it.
  const d = decideContinuation(stateAgedBy(120), { sessionId: 's' });
  assert.ok(
    d.reason.startsWith('[LOOP STATE'),
    'the silence warning must not displace the machine-truth header introduced in v1.7.0',
  );
});
