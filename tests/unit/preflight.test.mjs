import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessProbe, explainFailure, preflight, PREFLIGHT_PROMPT } from '../../core/preflight.mjs';

// The self-check came from two observations: (1) the event parser is tied to the engine version and
// a format change makes turns silently return nothing; (2) a wrong model is indistinguishable from a
// transient failure by its error text and costs 75 seconds of useless retries (measured live).

test('a healthy answer: the check passes with no notes', () => {
  const r = assessProbe({ ok: true, output: 'OK', sessionId: 'ses_1', costUsd: 0.0004 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.notes, []);
});

test('the turn failed: a refusal that states the reason', () => {
  const r = assessProbe({ ok: false, error: 'UnknownError: Unexpected server error' });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /the probe turn failed/);
  assert.match(r.problems.join(' '), /UnknownError/);
});

// Exactly the case this check exists for: the format changed, turns "succeed" but come back empty.
test('success with an empty answer: that is a format change, not success', () => {
  const r = assessProbe({ ok: true, output: '   ', sessionId: 'ses_1', costUsd: 0.1 });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /answer is EMPTY|output format changed/);
});

test('a silent hang is recognised separately', () => {
  const r = assessProbe({ ok: false, timedOut: true, error: 'timeout' });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /did not answer within the allotted time/);
});

// Do not overreach: small format changes must not block the work.
test('no cost and no session id is a note, not a failure', () => {
  const r = assessProbe({ ok: true, output: 'OK' });
  assert.equal(r.ok, true, 'a detail must not break the run');
  assert.equal(r.notes.length, 2);
  assert.match(r.notes.join(' '), /session id/);
  assert.match(r.notes.join(' '), /budget guard/);
});

test('the engine returned nothing at all', () => {
  assert.equal(assessProbe(null).ok, false);
  assert.equal(assessProbe(undefined).ok, false);
});

test('the failure explanation names the engine, the model and the substance', () => {
  const text = explainFailure({
    problems: ['the probe turn failed: no such model'],
    backendId: 'opencode', model: 'moonshotai/kimi-k99', engineVersion: '1.18.16',
  });
  assert.match(text, /loop was NOT started/);
  assert.match(text, /opencode/);
  assert.match(text, /kimi-k99/);
  assert.match(text, /1\.18\.16/);
  assert.match(text, /--no-preflight/, 'it must say how to switch it off');
});

test('preflight: performs exactly one tiny turn with the same model', async () => {
  const calls = [];
  const backend = {
    id: 'stub',
    async runTurn(opts) { calls.push(opts); return { ok: true, output: 'OK', sessionId: 's', costUsd: 0 }; },
  };
  const r = await preflight({ backend, model: 'loop-model', cwd: '/here' });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1, 'the check must be cheap — a single turn');
  assert.equal(calls[0].model, 'loop-model',
    'the probe must use THE SAME model, otherwise a wrong loop model goes unnoticed');
  assert.equal(calls[0].prompt, PREFLIGHT_PROMPT);
});

test('preflight: an exception on launch is a refusal, not a crash', async () => {
  const backend = { id: 'stub', async runTurn() { throw new Error('the engine is not installed'); } };
  const r = await preflight({ backend, model: 'm' });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /the engine is not installed/);
});
