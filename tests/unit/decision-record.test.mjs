import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDecision, validateDecision, scoreOf, rankOptions, MIN_OPTIONS, findDecisionFor,
} from '../../core/decision-record.mjs';

// v1.16.0. THE DEFECT, measured across the whole project rather than asserted:
//
//   version prompts carrying a brainstorm ......... 21 of 52  (40 %)
//   reports naming a rejected alternative ......... 11 of 72  (15 %)
//
// So in 85 % of the work delivered, no alternative was ever named. It is not laziness: where a
// prompt asked for a brainstorm, the brainstorm is there and it is real. The defect is that the
// practice lives in a document instead of a mechanism, so it switches on when instructed and off
// when not. Observed on the author within a single session: the choice of liveness evidence went
// through four options with one of them measured and rejected, while the choice of process identity
// an hour later was the first thing that came to mind, with no alternative named at all.

const good = () => ({
  decision: 'liveness evidence for the loop owner',
  version: '1.14.0',
  question: 'what should prove that the holder of the lock is still alive',
  options: [
    { id: 'process', summary: 'ask the kernel about a process number', impact: 3, confidence: 10, cost: 1,
      basis: 'measured: the hook pid is dead milliseconds after it is written',
      rejected_because: 'the Stop hook has no long-lived process number at all' },
    { id: 'ppid', summary: 'the parent process number', impact: 9, confidence: 4, cost: 2,
      basis: 'assumption: the parent might be the long-lived Claude Code process',
      rejected_because: 'measured, ppid 21200 was dead — the hook runs through a shell wrapper' },
    { id: 'transcript', summary: 'the session transcript file', impact: 8, confidence: 9, cost: 2,
      basis: 'measured: 10.9 MB, last written 0.4 seconds ago on a live session' },
  ],
  chosen: 'transcript',
  what_would_disprove: 'a session that goes long enough without writing to its transcript loses its own lock',
});

const withOptions = (opts) => ({ ...good(), options: opts, chosen: opts[0].id });

// --- the score is derived, never stored -------------------------------------------------------
//
// A written score is a copy of numbers that live elsewhere, and a copy with no invalidation drifts
// away from its source by construction. That is the exact defect v1.7.0 and v1.14.0 were spent on,
// so it is closed here before it can be introduced.
test('the score is computed from its parts, and there is nowhere to write one', () => {
  assert.equal(scoreOf({ impact: 8, confidence: 9, cost: 2 }), 36);
  assert.equal(scoreOf({ impact: 3, confidence: 10, cost: 1 }), 30);
  const record = good();
  // The ranking is arithmetic, and arithmetic is allowed to disagree with whoever wrote the test:
  // 8 x 9 / 2 = 36 beats 3 x 10 / 1 = 30. That disagreement is the whole point of computing it.
  const ranked = rankOptions(record);
  assert.deepEqual(ranked.map(o => o.id), ['transcript', 'process', 'ppid']);
  assert.equal(ranked[0].score, 36);
  assert.ok(ranked.every(o => !('score' in (record.options.find(x => x.id === o.id)))),
    'the record itself must never carry a score field');
});

test('a stored score is refused outright, not quietly ignored', () => {
  const r = good();
  r.options[0].score = 99;
  const v = validateDecision(r);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(' '), /score/i);
});

// --- what makes a record complete --------------------------------------------------------------

test('a complete record passes', () => {
  const v = validateDecision(good());
  assert.equal(v.ok, true, v.problems.join('; '));
});

// Two options is a fork, and flat thinking hides in forks: the second option is usually there to
// make the first look chosen.
test('fewer than three options is refused, naming how many are needed', () => {
  const r = withOptions(good().options.slice(0, 2));
  const v = validateDecision(r);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(' '), new RegExp(String(MIN_OPTIONS)));
});

test('a number without a basis is an opinion wearing a digit', () => {
  const r = good();
  delete r.options[1].basis;
  const v = validateDecision(r);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(' '), /basis|ppid/i);
});

test('scores outside 1..10 are refused', () => {
  for (const bad of [0, 11, -3, 'high', null]) {
    const r = good();
    r.options[1].impact = bad;
    assert.equal(validateDecision(r).ok, false, `impact ${JSON.stringify(bad)} must be refused`);
  }
});

test('an option that was not chosen must say why it lost', () => {
  const r = good();
  delete r.options[0].rejected_because;
  const v = validateDecision(r);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(' '), /rejected_because|process/i);
});

test('the chosen option must be one of the options, and must not reject itself', () => {
  const r1 = good(); r1.chosen = 'something-else';
  assert.equal(validateDecision(r1).ok, false);
  const r2 = good();
  r2.options.find(o => o.id === 'transcript').rejected_because = 'it lost';
  assert.equal(validateDecision(r2).ok, false, 'the winner cannot carry a reason for losing');
});

// The check for "is this a real reason or a brush-off" already exists in
// core/permission-decision.mjs. Writing a second one would be the drift class this project keeps
// closing, so this asserts the SHARED behaviour, thresholds included.
test('a brush-off instead of what_would_disprove does not pass', () => {
  for (const brushOff of ['', 'ok', 'nothing', 'fine', 'confirmed']) {
    const r = good(); r.what_would_disprove = brushOff;
    assert.equal(validateDecision(r).ok, false, `${JSON.stringify(brushOff)} must not pass`);
  }
  const r = good();
  r.what_would_disprove = 'the measurement would come back the other way round';
  assert.equal(validateDecision(r).ok, true);
});

test('duplicate option ids are refused — a ranking needs distinct things to rank', () => {
  const r = good();
  r.options[1].id = 'process';
  assert.equal(validateDecision(r).ok, false);
});

test('a malformed record is reported, never thrown', () => {
  for (const bad of [null, undefined, 'text', 42, {}, { options: 'no' }]) {
    const v = validateDecision(bad);
    assert.equal(v.ok, false);
    assert.ok(Array.isArray(v.problems) && v.problems.length > 0);
  }
});

// --- reading one off disk ----------------------------------------------------------------------

test('parseDecision reads the frontmatter of a decision file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dec-'));
  try {
    const file = join(dir, '1.14.0_liveness.md');
    const yaml = [
      '---',
      'decision: liveness evidence',
      'version: "1.14.0"',
      'question: what proves the owner alive',
      'options:',
      '  - id: process',
      '    summary: ask the kernel',
      '    impact: 3',
      '    confidence: 10',
      '    cost: 1',
      '    basis: measured on a live lock',
      '    rejected_because: the hook has no long-lived process',
      '  - id: ppid',
      '    summary: the parent process',
      '    impact: 9',
      '    confidence: 4',
      '    cost: 2',
      '    basis: assumption about the parent',
      '    rejected_because: measured, the parent was dead too',
      '  - id: transcript',
      '    summary: the session transcript',
      '    impact: 8',
      '    confidence: 9',
      '    cost: 2',
      '    basis: measured, written 0.4 seconds ago',
      'chosen: transcript',
      'what_would_disprove: a quiet session would lose its own lock',
      '---',
      '',
      '# Why this was decided this way',
    ].join('\n');
    writeFileSync(file, yaml, 'utf8');
    const rec = parseDecision(file);
    assert.equal(rec.chosen, 'transcript');
    assert.equal(rec.options.length, 3);
    assert.equal(validateDecision(rec).ok, true, 'a file written the documented way must validate');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a file that is not a decision record is reported rather than crashing the loop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dec-'));
  try {
    const file = join(dir, 'notes.md');
    writeFileSync(file, '# just some notes\n', 'utf8');
    assert.equal(parseDecision(file), null);
    assert.equal(parseDecision(join(dir, 'absent.md')), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// This is what makes the absence of a record visible: the driver asks, every turn, whether the
// version in flight has one. Until now a missing brainstorm was indistinguishable from a considered
// decision, which is how 85 % of the work came to name no alternative at all.
test('findDecisionFor answers whether the version in flight has a record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proj-'));
  try {
    const decisions = join(dir, 'docs', 'decisions');
    mkdirSync(decisions, { recursive: true });
    assert.equal(findDecisionFor(dir, '1.16.0'), null, 'no record is a plain answer, not an error');

    writeFileSync(join(decisions, '1.16.0_thresholds.md'), '---\ndecision: x\n---\n', 'utf8');
    const found = findDecisionFor(dir, '1.16.0');
    assert.ok(found, 'a record for this version must be found by its name');
    assert.match(found.file, /1\.16\.0_thresholds/);

    assert.equal(findDecisionFor(dir, '1.17.0'), null, 'and another version is not this one');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
