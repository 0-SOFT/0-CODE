import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageRows } from '../coverage-report.mjs';

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
