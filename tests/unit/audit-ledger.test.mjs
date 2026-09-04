import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseLedger, validateLedger, countFindings, isClean, loopVerdict, BLOCKING_LEVELS, AUDIT_KINDS,
} from '../../core/audit-ledger.mjs';

// v1.17.0. THE ROOT DIFFICULTY, stated before any code: /productionauditloop exits when
// P0 + P1 + P2 = 0, and that condition cannot rest on the agent's word — an agent that can declare
// the loop finished will finish it by declaring. So the findings have to be countable.
//
// Where they live was chosen in the open (docs/decisions/1.17.0_ledger-format.md) on a measurement
// that overturned the starting assumption: of 231 checklist lines across the ten existing
// docs/todo files, only 19 match the tidy `- [ ] **P0-001**` shape and 212 do not. A parser
// generous enough to read the rest would produce a number people believe.

const finding = (over) => ({
  id: 'P1-001', level: 'P1', where: 'core/gates.mjs:75',
  summary: 'the stall watchdog reads a field nobody writes', state: 'open', ...over,
});

const ledger = (over) => ({
  audit: 'codebase',
  version: '1.17.0',
  round: 1,
  coverage: 'read all 17 modules under core/ and lib/, 24 test files and the four audit templates',
  findings: [finding()],
  ...over,
});

// --- counting ---------------------------------------------------------------------------------

test('open findings are counted per level, and P3 is not part of the exit condition', () => {
  const l = ledger({ findings: [
    finding({ id: 'P0-001', level: 'P0' }),
    finding({ id: 'P1-001', level: 'P1' }),
    finding({ id: 'P2-001', level: 'P2' }),
    finding({ id: 'P3-001', level: 'P3' }),
  ] });
  const c = countFindings(l);
  assert.equal(c.open.P0, 1);
  assert.equal(c.open.P3, 1);
  assert.equal(c.blocking, 3, 'P0 + P1 + P2, and P3 deliberately left out');
  assert.deepEqual(BLOCKING_LEVELS, ['P0', 'P1', 'P2']);
});

test('a finding that is fixed or rejected stops blocking', () => {
  const l = ledger({ findings: [
    finding({ id: 'P0-001', level: 'P0', state: 'fixed', evidence: 'test gates.test.mjs:120 failed before the change and passes after' }),
    finding({ id: 'P1-001', level: 'P1', state: 'rejected', evidence: 'the file is generated, the rule does not apply to generated output' }),
  ] });
  assert.equal(countFindings(l).blocking, 0);
});

// "Fixed" without evidence is the agent's word again, wearing a different hat — exactly what the
// ledger exists to replace.
test('claiming a finding fixed without evidence does not pass', () => {
  const l = ledger({ findings: [finding({ state: 'fixed' })] });
  const v = validateLedger(l);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(' '), /evidence/i);
});

test('a brush-off instead of evidence does not pass either', () => {
  const l = ledger({ findings: [finding({ state: 'fixed', evidence: 'done' })] });
  assert.equal(validateLedger(l).ok, false);
});

// --- what makes a ledger well-formed ------------------------------------------------------------

test('a complete ledger passes', () => {
  assert.equal(validateLedger(ledger()).ok, true, validateLedger(ledger()).problems.join('; '));
});

test('a level that contradicts the id is refused', () => {
  const v = validateLedger(ledger({ findings: [finding({ id: 'P0-001', level: 'P2' })] }));
  assert.equal(v.ok, false);
  assert.match(v.problems.join(' '), /P0-001/);
});

test('an unknown level or state is refused rather than silently ignored', () => {
  assert.equal(validateLedger(ledger({ findings: [finding({ level: 'P9' })] })).ok, false);
  assert.equal(validateLedger(ledger({ findings: [finding({ state: 'maybe' })] })).ok, false);
});

test('a finding with no place is refused, unless it says why it has none', () => {
  const nowhere = validateLedger(ledger({ findings: [finding({ where: '' })] }));
  assert.equal(nowhere.ok, false);
  const explained = validateLedger(ledger({ findings: [
    finding({ where: 'not tied to a line: the whole module lacks a test file' }),
  ] }));
  assert.equal(explained.ok, true);
});

test('duplicate finding ids are refused — a count needs distinct things to count', () => {
  const v = validateLedger(ledger({ findings: [finding(), finding()] }));
  assert.equal(v.ok, false);
});

test('a malformed ledger is reported, never thrown', () => {
  for (const bad of [null, undefined, 'text', 42, {}, { findings: 'no' }]) {
    const v = validateLedger(bad);
    assert.equal(v.ok, false);
    assert.ok(Array.isArray(v.problems) && v.problems.length > 0);
  }
});

// --- the exit condition -------------------------------------------------------------------------
//
// THE DEGENERATE EXIT this guards against: an audit that looked at nothing finds nothing, and zero
// findings then reads exactly like a clean pass. Coverage is what separates the two, and it is
// required of every ledger, not only of the clean ones — a coverage line written only when the
// answer is zero would be written to reach zero.

test('an empty ledger with real coverage is clean', () => {
  const l = ledger({ findings: [] });
  assert.equal(validateLedger(l).ok, true);
  assert.equal(isClean(l).clean, true);
});

test('an empty ledger with no coverage is not a clean pass', () => {
  for (const empty of ['', 'ok', 'everything']) {
    const l = ledger({ findings: [], coverage: empty });
    assert.equal(validateLedger(l).ok, false, `coverage ${JSON.stringify(empty)} must not pass`);
    assert.equal(isClean(l).clean, false);
  }
});

test('isClean says why it is not clean, so the loop can report a reason', () => {
  const r = isClean(ledger());
  assert.equal(r.clean, false);
  assert.match(r.why, /P1|blocking|1/);
});

// The loop's own verdict: every kind of audit must be clean in the same round. One clean round is
// enough, and deliberately so — it already runs AFTER the fixes it verifies, so a second one with no
// fixes between them could only find what the first one missed, which is a coverage question and is
// answered by the coverage requirement rather than by another paid round.
test('the loop finishes only when every audit is clean', () => {
  const clean = (kind) => ledger({ audit: kind, findings: [] });
  const dirty = (kind) => ledger({ audit: kind });

  const partial = loopVerdict(AUDIT_KINDS.map((k) => (k === 'tests' ? dirty(k) : clean(k))));
  assert.equal(partial.done, false);
  assert.equal(partial.blocking, 1);
  assert.match(partial.why, /tests/);

  const all = loopVerdict(AUDIT_KINDS.map(clean));
  assert.equal(all.done, true);
  assert.equal(all.blocking, 0);
});

test('a missing audit is not a clean audit', () => {
  const v = loopVerdict([ledger({ audit: 'codebase', findings: [] })]);
  assert.equal(v.done, false, 'three of the four kinds never ran');
  assert.match(v.why, /architecture|frontend|tests/);
});

test('an invalid ledger can never end the loop', () => {
  const broken = AUDIT_KINDS.map((k) => ledger({ audit: k, findings: [], coverage: 'ok' }));
  const v = loopVerdict(broken);
  assert.equal(v.done, false, 'a ledger that does not validate proves nothing');
});

// --- reading one off disk -----------------------------------------------------------------------

test('parseLedger reads the frontmatter of a todo file and ignores the prose below it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'led-'));
  try {
    mkdirSync(join(dir, 'docs', 'todo'), { recursive: true });
    const file = join(dir, 'docs', 'todo', '1.17.0.md');
    writeFileSync(file, [
      '---',
      'audit: tests',
      'version: "1.17.0"',
      'round: 2',
      'coverage: "every test file under tests/ was read, plus the coverage gate configuration"',
      'findings:',
      '  - id: "P2-001"',
      '    level: "P2"',
      '    where: "tests/unit/safety.test.mjs:40"',
      '    summary: "the case is asserted but never exercised"',
      '    state: "open"',
      '---',
      '',
      '# TODO — this prose explains, it does not decide',
      '',
      '- [ ] something a human wrote by hand',
    ].join('\n'), 'utf8');

    const l = parseLedger(file);
    assert.equal(l.audit, 'tests');
    assert.equal(l.round, 2);
    assert.equal(l.findings.length, 1);
    assert.equal(validateLedger(l).ok, true);
    assert.equal(countFindings(l).blocking, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A todo file from before this version has no frontmatter at all. It must read as "no ledger", and
// never as "a ledger with no findings" — the second would end the loop on a file written years ago.
test('a todo file without a ledger is not an empty ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'led-'));
  try {
    const file = join(dir, 'old.md');
    writeFileSync(file, '# TODO\n\n- [ ] **P0-001** something\n', 'utf8');
    assert.equal(parseLedger(file), null);
    assert.equal(loopVerdict([null]).done, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
