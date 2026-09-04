import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coverageRows, sourceRows, missingSourceDirs, worstBranch, EXPECTED_SOURCE_DIRS,
} from '../coverage-report.mjs';

// This parser has now broken twice, in opposite directions, and each time the coverage gate went on
// reporting success while measuring nothing. First it read only flat paths, then only the tree —
// a green that meant "not looked at". Both shapes are pinned down here so a third turn is not
// possible; the vacuity guard in the runner is the second line of defence, not the first.

const SEP = String.fromCharCode(92);   // a backslash, without writing one into a string literal

const FLAT = [
  '# file                        | line % | branch % | funcs % | uncovered',
  `# core${SEP}gates.mjs              | 100.00 |   94.03 |  100.00 | `,
  `# core${SEP}backends${SEP}claude.mjs   |  85.71 |   79.41 |   90.00 | 23-25`,
  `# lib${SEP}yaml-mini.mjs           | 100.00 |  100.00 |  100.00 | `,
  `# tests${SEP}unit${SEP}gates.test.mjs  | 100.00 |  100.00 |  100.00 | `,
  '# all files                    |  95.92 |   87.53 |   93.64 |',
].join('\n');

const TREE = [
  '# file                  | line % | branch % | funcs % | uncovered',
  '# core                  |        |          |         | ',
  '#  gates.mjs            | 100.00 |    94.03 |  100.00 | ',
  '#  backends             |        |          |         | ',
  '#   claude.mjs          |  85.71 |    79.41 |   90.00 | 23-25',
  '# lib                   |        |          |         | ',
  '#  yaml-mini.mjs        | 100.00 |   100.00 |  100.00 | ',
  '# all files             |  95.92 |    87.53 |   93.64 |',
].join('\n');

test('coverage parser: flat paths with backslashes are read as full paths', () => {
  const byFile = Object.fromEntries(coverageRows(FLAT).map(r => [r.file, r.line]));
  assert.equal(byFile['core/gates.mjs'], 100);
  assert.equal(byFile['core/backends/claude.mjs'], 85.71);
  assert.equal(byFile['lib/yaml-mini.mjs'], 100);
});

test('coverage parser: the tree shape is rebuilt from indentation', () => {
  const byFile = Object.fromEntries(coverageRows(TREE).map(r => [r.file, r.line]));
  assert.equal(byFile['core/gates.mjs'], 100);
  assert.equal(byFile['core/backends/claude.mjs'], 85.71);
  assert.equal(byFile['lib/yaml-mini.mjs'], 100);
});

test('coverage parser: either shape yields source modules for the gate to measure', () => {
  for (const [name, table] of [['flat', FLAT], ['tree', TREE]]) {
    const source = coverageRows(table).filter(r => /^(core|lib|hooks)\//.test(r.file));
    assert.ok(source.length >= 3, `${name}: the gate would have had nothing to measure`);
  }
});

test('coverage parser: header and summary rows are not mistaken for modules', () => {
  for (const table of [FLAT, TREE]) {
    assert.ok(!coverageRows(table).some(r => /all files/.test(r.file)));
  }
});

// --- v1.17.0: findings P1-001 and P2-001 of the tests audit ------------------------------------
//
// Both came out of the first real run of /productionaudit against this repository, and both are the
// same shape: a report that says more than it checked.

const TABLE = [
  '# file                    | line % | branch % | funcs % | uncovered',
  '# core\\gates.mjs          | 100.00 |    95.00 |  100.00 | ',
  '# lib\\yaml-mini.mjs       | 100.00 |   100.00 |  100.00 | ',
  '# hooks\\ralph-loop-stop.mjs |  88.43 |   12.50 |  100.00 | 63 70',
].join('\n');

test('the parser reads branch coverage, not only lines', () => {
  const rows = coverageRows(TABLE);
  const hook = rows.find(r => r.file.endsWith('ralph-loop-stop.mjs'));
  assert.equal(hook.line, 88.43);
  assert.equal(hook.branch, 12.5, 'until v1.17.0 this number was never read, so it could not be said');
});

// P1-001: two modules sat at 88 % and 84 % of LINES while both were at 12.50 % of branches, and
// those two are the Stop hook and the safety guard. The gate reported "all source modules are at or
// above 80 %" and a reader took it for a statement about coverage.
test('the worst branch coverage can be named, so it cannot hide behind a line percentage', () => {
  const worst = worstBranch(sourceRows(coverageRows(TABLE)));
  assert.ok(worst, 'a table with a branch column must yield an answer');
  assert.match(worst.file, /ralph-loop-stop/);
  assert.equal(worst.branch, 12.5);
});

test('a table with no branch column says so instead of inventing a number', () => {
  const rows = [{ file: 'core/gates.mjs', line: 100, branch: null }];
  assert.equal(worstBranch(rows), null);
});

// P2-001: the vacuity guard could only see "no rows at all". If ONE directory out of three stopped
// being recognised, plenty of rows remained and the gate passed on a measurement that had quietly
// lost hooks/ — the two files that decide whether the loop continues and whether a dangerous
// command runs.
test('a whole directory vanishing from the measurement is noticed', () => {
  const full = sourceRows(coverageRows(TABLE));
  assert.deepEqual(missingSourceDirs(full), [], 'all three directories are present here');

  const withoutHooks = full.filter(r => !r.file.startsWith('hooks/'));
  assert.ok(withoutHooks.length > 0, 'the point is that rows REMAIN, so a count cannot catch it');
  assert.deepEqual(missingSourceDirs(withoutHooks), ['hooks']);
});

test('the expected directories are named in one place, not spelled out per caller', () => {
  assert.deepEqual(EXPECTED_SOURCE_DIRS, ['core', 'lib', 'hooks']);
});
