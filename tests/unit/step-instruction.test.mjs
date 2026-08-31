import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POSITION_FIELDS, isBlank, stampFor, checkFreshness } from '../../lib/step-instruction.mjs';

// v1.7.0. `next_step_prompt` is a cache of an instruction, and this module is what gives it an
// expiry date. The tests below pin down both halves: the passport that lib/update-state.mjs mints
// on the way in, and the verdict core/gates.mjs asks for on the way out.

test('isBlank: only an actual value counts', () => {
  for (const v of [null, undefined, '', '   ']) assert.equal(isBlank(v), true, `${JSON.stringify(v)}`);
  for (const v of ['x', 0, false]) assert.equal(isBlank(v), false, `${JSON.stringify(v)}`);
});

test('stampFor: the passport records where the loop stood, plus when it was written', () => {
  const stamp = stampFor({
    current_version: '1.7.0', current_stage: 2, current_prompt_file: 'docs/prompts/x.md',
  }, { at: '2026-08-25T10:00:00Z' });
  assert.deepEqual(stamp,
    { version: '1.7.0', stage: 2, prompt_file: 'docs/prompts/x.md', at: '2026-08-25T10:00:00Z' });
});

test('stampFor: missing position fields become null rather than disappearing', () => {
  const stamp = stampFor({ current_version: '1.7.0' }, { at: 'now' });
  assert.equal(stamp.prompt_file, null);
  assert.equal(stamp.stage, null);
  assert.equal(Object.keys(stamp).length, Object.keys(POSITION_FIELDS).length + 1);
});

test('stampFor: no state and no timestamp still yields a well-formed passport', () => {
  const stamp = stampFor(null);
  assert.equal(stamp.version, null);
  assert.equal(stamp.at, null);
});

test('freshness: no instruction at all → empty', () => {
  assert.equal(checkFreshness({ next_step_prompt: '' }).status, 'empty');
  assert.equal(checkFreshness({}).status, 'empty');
  assert.equal(checkFreshness(null).status, 'empty');
});

test('freshness: a passport matching the live position → fresh', () => {
  const v = checkFreshness({
    current_version: '1.7.0', current_stage: 2, current_prompt_file: 'docs/prompts/x.md',
    next_step_prompt: 'do the next thing',
    next_step_prompt_meta: { version: '1.7.0', stage: 2, prompt_file: 'docs/prompts/x.md', at: 'now' },
  });
  assert.equal(v.status, 'fresh');
  assert.equal(v.instruction, 'do the next thing');
});

// This is the case the barrier in lib/update-state.mjs is meant to prevent. It can still arrive
// here through a hand-edited STATE, so the reader checks anyway.
test('freshness: a passport from another position → stale, and it says which field moved', () => {
  const v = checkFreshness({
    current_version: '6.4.0', current_stage: 2, current_prompt_file: 'docs/prompts/6.0.0_x.md',
    next_step_prompt: 'finish stage 4.6.0',
    next_step_prompt_meta: { version: '4.6.0', stage: 2, prompt_file: 'docs/prompts/6.0.0_x.md' },
  });
  assert.equal(v.status, 'stale');
  assert.match(v.why, /current_version/);
  assert.match(v.why, /4\.6\.0/);
  assert.match(v.why, /6\.4\.0/);
});

test('freshness: a moved prompt file alone is enough to call it stale', () => {
  const v = checkFreshness({
    current_version: '1.7.0', current_stage: 2, current_prompt_file: 'docs/prompts/new.md',
    next_step_prompt: 'do the next thing',
    next_step_prompt_meta: { version: '1.7.0', stage: 2, prompt_file: 'docs/prompts/old.md' },
  });
  assert.equal(v.status, 'stale');
  assert.match(v.why, /current_prompt_file/);
});

test('freshness: a passport of the wrong shape is ignored, not trusted', () => {
  const v = checkFreshness({
    current_version: '1.7.0', next_step_prompt: 'do X', next_step_prompt_meta: ['not', 'an', 'object'],
  });
  assert.equal(v.status, 'unverified');
});

// Projects that upgraded to v1.7.0 mid-flight have no passport at all. The heuristic is the only
// thing standing between them and the defect this version exists to fix, so it is pinned down hard.
test('freshness: no passport, and the text speaks of another version → stale', () => {
  const v = checkFreshness({
    current_version: '6.4.0',
    next_step_prompt: 'Stage 4.6.0 is CLOSED. Blocker awaiting_user_direction is in place.',
  });
  assert.equal(v.status, 'stale');
  assert.match(v.why, /4\.6\.0/);
  assert.match(v.why, /6\.4\.0/);
});

test('freshness: no passport, but the text names the live version → used, merely unverified', () => {
  const v = checkFreshness({
    current_version: '6.4.0',
    next_step_prompt: 'Stage 2 of 6.4.0: compare the behaviour with how 4.6.0 handled it.',
  });
  assert.equal(v.status, 'unverified', 'naming a neighbouring version is not drift');
  assert.match(v.instruction, /compare the behaviour/);
});

test('freshness: no passport and no version in the text → used, merely unverified', () => {
  const v = checkFreshness({ current_version: '6.4.0', next_step_prompt: 'write the report' });
  assert.equal(v.status, 'unverified');
  assert.match(v.why, /no freshness stamp/);
});

test('freshness: with no current_version there is nothing to compare against → unverified', () => {
  const v = checkFreshness({ next_step_prompt: 'finish 4.6.0' });
  assert.equal(v.status, 'unverified');
});
