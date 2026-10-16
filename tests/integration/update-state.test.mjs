import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkTempProject, readFrontmatter } from '../helpers/index.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const UPDATE = join(ROOT, 'lib', 'update-state.mjs');

function apply(stateFile, patch) {
  return spawnSync(process.execPath, [UPDATE, stateFile], { input: patch, encoding: 'utf8' });
}

test('update-state: applies the patch and creates a backup', () => {
  const p = mkTempProject({ iteration: 1 });
  try {
    const r = apply(p.stateFile, '{"iteration":7}');
    assert.equal(r.status, 0);
    assert.equal(readFrontmatter(p.stateFile).iteration, 7);
    assert.ok(existsSync(`${p.stateFile}.bak.1`));
  } finally { p.cleanup(); }
});

test('update-state: lossless strings leave a readable state through subsequent writes', () => {
  const p = mkTempProject();
  try {
    const last_action = 'engine progress\rcontinued\u2028next\u2029end';
    const scalar_values = { empty: '', negative: '-42', quoted: '"literal"',
      single: "'literal'", tab: 'x\t', inline: ['x\u2028y', 'x\u2029y'] };
    const result = apply(p.stateFile, JSON.stringify({ last_action, scalar_values }));
    assert.equal(result.status, 0, result.stderr);
    let state = readFrontmatter(p.stateFile);
    assert.equal(state.last_action, last_action);
    assert.deepEqual(state.scalar_values, scalar_values);
    const subsequent = apply(p.stateFile, '{"iteration":1}');
    assert.equal(subsequent.status, 0, subsequent.stderr);
    state = readFrontmatter(p.stateFile);
    assert.equal(state.iteration, 1);
    assert.equal(state.last_action, last_action);
    assert.deepEqual(state.scalar_values, scalar_values);
  } finally { p.cleanup(); }
});

test('update-state: unrepresentable patches refuse before backups or publication without exposing data', () => {
  const patches = [JSON.stringify({ notes: { 'invalid key': 'sensitive-marker' } }),
    JSON.stringify({ notes: [{ '': 'sensitive-marker' }] }), '{"value":1e999}'];
  for (const patch of patches) {
    const p = mkTempProject();
    try {
      const original = readFileSync(p.stateFile);
      const directory = dirname(p.stateFile), files = readdirSync(directory).sort();
      const result = apply(p.stateFile, patch);
      assert.notEqual(result.status, 0, 'an unreadable or changed representation must be refused');
      assert.doesNotMatch(result.stdout + result.stderr, /sensitive-marker/);
      assert.deepEqual(readFileSync(p.stateFile), original);
      assert.deepEqual(readdirSync(directory).sort(), files, 'even the backup ring must be unchanged');
      assert.equal(readFrontmatter(p.stateFile).iteration, 0);
    } finally { p.cleanup(); }
  }
});

test('update-state: special patch keys remain own data and merge only existing own values', () => {
  const p = mkTempProject();
  try {
    let result = apply(p.stateFile, '{"__proto__":{"first":1,"blockers":["nested"]},"constructor":{"prototype":{"marker":"ordinary"}}}');
    assert.equal(result.status, 0, result.stderr);
    let state = readFrontmatter(p.stateFile);
    assert.ok(Object.hasOwn(state, '__proto__'));
    assert.equal(Object.getPrototypeOf(state), Object.prototype);
    assert.deepEqual(state.blockers, []);
    assert.deepEqual(state.__proto__, { first: 1, blockers: ['nested'] });
    result = apply(p.stateFile, '{"__proto__":{"second":2}}');
    assert.equal(result.status, 0, result.stderr);
    state = readFrontmatter(p.stateFile);
    assert.deepEqual(state.__proto__, { first: 1, blockers: ['nested'], second: 2 });
    assert.equal(Object.prototype.marker, undefined);
  } finally { p.cleanup(); }
});

test('update-state: empty stdin → non-zero exit', () => {
  const p = mkTempProject();
  try {
    const r = apply(p.stateFile, '');
    assert.notEqual(r.status, 0);
  } finally { p.cleanup(); }
});

test('update-state: a non-JSON patch → non-zero exit', () => {
  const p = mkTempProject();
  try {
    const r = apply(p.stateFile, 'this is not json');
    assert.notEqual(r.status, 0);
  } finally { p.cleanup(); }
});

test('update-state: an array in the patch replaces rather than merges', () => {
  const p = mkTempProject({ blockers: [{ a: 1 }] });
  try {
    const r = apply(p.stateFile, '{"blockers":[]}');
    assert.equal(r.status, 0);
    assert.deepEqual(readFrontmatter(p.stateFile).blockers, []);
  } finally { p.cleanup(); }
});

test('update-state: leaves no .tmp.* file behind on success (atomicity)', () => {
  const p = mkTempProject({ iteration: 0 });
  try {
    const r = apply(p.stateFile, '{"iteration":3}');
    assert.equal(r.status, 0);
    // the real temp name is STATE.md.tmp.<pid>.<ts> — we scan the directory instead of guessing
    const leftovers = readdirSync(join(p.dir, 'docs')).filter(f => f.includes('STATE.md.tmp'));
    assert.deepEqual(leftovers, []);
  } finally { p.cleanup(); }
});

// --- v1.7.0: the barrier and the freshness stamp -----------------------------------------------
//
// Reported from a live project: the orchestrator moved current_version and current_prompt_file for
// dozens of iterations while leaving next_step_prompt untouched, so the loop kept handing out an
// instruction written two versions earlier. Nothing on the write side objected. Now it does.

test('barrier: moving the version without a new instruction is refused, STATE untouched', () => {
  const p = mkTempProject({ current_version: '1.6.1', next_step_prompt: 'old instruction' });
  try {
    const r = apply(p.stateFile, '{"current_version":"1.7.0"}');
    assert.notEqual(r.status, 0, 'the write must be refused');
    assert.match(r.stderr, /next_step_prompt/, 'the message must name what is missing');
    assert.equal(readFrontmatter(p.stateFile).current_version, '1.6.1', 'nothing was written');
  } finally { p.cleanup(); }
});

test('barrier: moving the stage or the prompt file is refused the same way', () => {
  const p = mkTempProject({ current_stage: 2, current_prompt_file: 'docs/prompts/a.md' });
  try {
    assert.notEqual(apply(p.stateFile, '{"current_stage":3}').status, 0);
    assert.notEqual(apply(p.stateFile, '{"current_prompt_file":"docs/prompts/b.md"}').status, 0);
  } finally { p.cleanup(); }
});

test('barrier: writing the same value is not a move, so it passes', () => {
  const p = mkTempProject({ current_version: '1.6.1', current_stage: 2 });
  try {
    const r = apply(p.stateFile, '{"current_version":"1.6.1","current_stage":2,"iteration":3}');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFrontmatter(p.stateFile).iteration, 3);
  } finally { p.cleanup(); }
});

// The barrier must be invisible to the two loop drivers. If it were not, a misfire would stop the
// loop dead: both the Stop hook and the supervisor treat a failed STATE write as fatal.
test('barrier: the loop drivers\' own patches are never affected', () => {
  const p = mkTempProject({ current_version: '1.6.1', current_stage: 2 });
  try {
    // The Stop hook's patch.
    assert.equal(apply(p.stateFile,
      '{"iteration":2,"last_session_id":"s1","session_count":1}').status, 0);
    // The supervisor's patch, including the cost and a no_progress blocker.
    const r = apply(p.stateFile, JSON.stringify({
      iteration: 3, last_session_id: 's1', session_count: 1,
      budget_metrics: { version_cost_usd: 1.25 },
      blockers: [{ type: 'no_progress', detail: 'three empty turns' }],
    }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFrontmatter(p.stateFile).iteration, 3);
  } finally { p.cleanup(); }
});

test('stamp: a written instruction gets a passport of the position it was written for', () => {
  const p = mkTempProject({ current_version: '1.6.1', current_stage: 2 });
  try {
    const r = apply(p.stateFile, JSON.stringify({
      current_version: '1.7.0', current_stage: 3,
      current_prompt_file: 'docs/prompts/1.7.0_x.md',
      next_step_prompt: 'stage 3: write the report',
    }));
    assert.equal(r.status, 0, r.stderr);
    const fm = readFrontmatter(p.stateFile);
    assert.equal(fm.next_step_prompt_meta.version, '1.7.0');
    assert.equal(fm.next_step_prompt_meta.stage, 3);
    assert.equal(fm.next_step_prompt_meta.prompt_file, 'docs/prompts/1.7.0_x.md');
    assert.match(String(fm.next_step_prompt_meta.at), /^\d{4}-\d{2}-\d{2}T/);
  } finally { p.cleanup(); }
});

// The passport describes the position AFTER the merge. Half of it can come from the patch and the
// other half from what was already in STATE, so minting it from the patch alone would be wrong.
test('stamp: the passport describes the merged position, not just the patch', () => {
  const p = mkTempProject({ current_version: '1.6.1', current_stage: 2,
    current_prompt_file: 'docs/prompts/kept.md' });
  try {
    apply(p.stateFile, '{"current_version":"1.7.0","next_step_prompt":"go on"}');
    const meta = readFrontmatter(p.stateFile).next_step_prompt_meta;
    assert.equal(meta.version, '1.7.0', 'from the patch');
    assert.equal(meta.prompt_file, 'docs/prompts/kept.md', 'from what STATE already held');
  } finally { p.cleanup(); }
});

// Clearing the instruction on purpose stays possible — it means "work it out from STATE", the
// contract pinned down in v1.3.0. It is the accidental case the barrier is aimed at.
test('stamp: clearing the instruction explicitly is allowed and removes the passport', () => {
  const p = mkTempProject({ current_version: '1.6.1' });
  try {
    apply(p.stateFile, '{"next_step_prompt":"something"}');
    assert.ok(readFrontmatter(p.stateFile).next_step_prompt_meta);
    const r = apply(p.stateFile, '{"current_version":"1.7.0","next_step_prompt":null}');
    assert.equal(r.status, 0, r.stderr);
    const fm = readFrontmatter(p.stateFile);
    assert.equal(fm.current_version, '1.7.0');
    assert.equal(fm.next_step_prompt_meta, undefined, 'an empty instruction has nothing to validate');
  } finally { p.cleanup(); }
});

// --- v1.14.0: the clock the silence watchdog reads ---------------------------------------------
//
// FOUND BY MEASUREMENT, not by reading. core/gates.mjs states that "lib/update-state.mjs has
// written last_action_at since the first version". No line of the tool ever did. The field was
// filled in by hand, by agents, in whatever patch they happened to remember it in — so the v1.8.0
// silence watchdog was reading a hand-maintained cache, which is precisely the defect class v1.7.0
// exists to prevent, reintroduced elsewhere.
//
// Measured on this repository: two state patches were applied in a row and last_action_at stayed at
// a value written six hours earlier, while the watchdog reported "STATE has not changed for 355
// minutes" on a project that had just changed twice.

test('the clock is wound by the tool, not by whoever remembers to write it', () => {
  const p = mkTempProject({ iteration: 1, last_action_at: '2020-01-01T00:00:00Z' });
  try {
    const before = Date.now();
    assert.equal(apply(p.stateFile, '{"last_action":"did a thing"}').status, 0);
    const stamped = Date.parse(readFrontmatter(p.stateFile).last_action_at);
    assert.ok(Number.isFinite(stamped), 'the stamp must be a readable time');
    assert.ok(stamped >= before - 1000, 'and it must describe this write, not an old one');
  } finally { p.cleanup(); }
});

// The trap this design has to avoid, and the reason a flag would have been the wrong answer: the
// drivers write to STATE on EVERY turn. If their bookkeeping wound the clock, the watchdog could
// never fire — it would be barking at its own tail, exactly as core/turn-progress.mjs describes for
// the progress detector. So the rule is derived from what the patch actually touches, and a driver
// has no way to claim otherwise.
test('driver bookkeeping does not wind the clock, or the watchdog would watch itself', () => {
  const p = mkTempProject({ iteration: 1, last_action_at: '2020-01-01T00:00:00Z' });
  try {
    assert.equal(apply(p.stateFile, '{"iteration":2,"last_session_id":"s","session_count":3}').status, 0);
    assert.equal(readFrontmatter(p.stateFile).last_action_at, '2020-01-01T00:00:00Z',
      'a turn that only counted itself is not an action');
    assert.equal(apply(p.stateFile, '{"budget_metrics":{"version_cost_usd":0.5}}').status, 0);
    assert.equal(readFrontmatter(p.stateFile).last_action_at, '2020-01-01T00:00:00Z',
      'nor is recording what the turn cost');
  } finally { p.cleanup(); }
});

test('a patch that mixes bookkeeping with real work still counts as work', () => {
  const p = mkTempProject({ iteration: 1, last_action_at: '2020-01-01T00:00:00Z' });
  try {
    assert.equal(apply(p.stateFile, '{"iteration":2,"running_jobs":[]}').status, 0);
    assert.notEqual(readFrontmatter(p.stateFile).last_action_at, '2020-01-01T00:00:00Z');
  } finally { p.cleanup(); }
});

test('an explicit stamp in the patch is respected — the tool does not overrule the author', () => {
  const p = mkTempProject({ iteration: 1 });
  try {
    assert.equal(apply(p.stateFile, '{"last_action":"x","last_action_at":"2031-05-05T05:05:05Z"}').status, 0);
    assert.equal(readFrontmatter(p.stateFile).last_action_at, '2031-05-05T05:05:05Z');
  } finally { p.cleanup(); }
});
