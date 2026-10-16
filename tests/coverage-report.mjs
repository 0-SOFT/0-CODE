// tests/coverage-report.mjs — reading Node's coverage table.
//
// It lives apart from tests/run.mjs for one reason: run.mjs is a script, and importing it to reach
// this function would spawn the whole suite as a side effect. A parser that cannot be examined
// without running everything it measures does not get examined.
//
// Node prints the table in two shapes, depending on version and platform. TAP uses '#',
// while Node 24's default spec reporter uses the information symbol (U+2139):
//
//   flat   # core\gates.mjs        | 100.00 | ...     (full relative path, OS separators)
//   tree   # core                  |        | ...     (a directory row, no percentages)
//          #  gates.mjs            | 100.00 | ...     (indented, basename only)
//
// This function has broken twice, once for each shape, and both times the gate above it went on
// reporting success while measuring nothing — a green that meant "not looked at". So both shapes
// are handled here, and tests/unit/coverage-parser.test.mjs pins both down.

export function coverageRows(stdout) {
  const rows = [];
  const dirs = [];
  for (const line of (stdout || '').split('\n')) {
    // Both numbers, not just the first. Until v1.17.0 only the line percentage was read, so the
    // gate above could speak only about lines while sounding like it spoke about coverage.
    const m = line.match(/^(?:#|\u2139)(\s+)(\S+)\s+\|\s*([\d.]*)\s*\|\s*([\d.]*)\s*\|/);
    if (!m) continue;
    const depth = m[1].length - 1;
    const name = m[2];
    const pct = m[3];
    if (pct === '') {                       // a directory row carries no percentages
      dirs.length = depth;
      dirs[depth] = name;
      continue;
    }
    if (!name.endsWith('.mjs')) continue;   // the header and the summary row
    // A name that already carries a separator IS the path; otherwise rebuild it from indentation.
    const file = /[\\/]/.test(name)
      ? name.split(String.fromCharCode(92)).join('/')
      : [...dirs.slice(0, depth), name].join('/');
    const branchPct = parseFloat(m[4]);
    rows.push({ file, line: parseFloat(pct), branch: Number.isFinite(branchPct) ? branchPct : null });
  }
  return rows;
}

// The directories the gate must always see. A guard that only checks for "no rows at all" cannot
// notice that ONE of them stopped being recognised — and the two files that decide whether the loop
// continues and whether a dangerous command runs both live in hooks/.
export const EXPECTED_SOURCE_DIRS = ['core', 'lib', 'hooks'];

// The modules the threshold applies to: the framework's own source, not the tests measuring it.
export function sourceRows(rows) {
  return rows.filter(r => /^(core|lib|hooks)\//.test(r.file) && !/test|helpers/.test(r.file));
}

// Which of the expected directories produced no rows. Empty means the gate is looking at all of
// them; anything else means part of the source silently left the measurement.
export function missingSourceDirs(rows, expected = EXPECTED_SOURCE_DIRS) {
  const seen = new Set(rows.map((r) => String(r.file).split('/')[0]));
  return expected.filter((d) => !seen.has(d));
}

// The worst branch coverage among the given rows, or null when the table carried no branch column.
// Reported rather than gated: choosing a branch threshold is a decision with a cost, and it is not
// made by the same change that stops the report from overstating itself.
export function worstBranch(rows) {
  const withBranch = rows.filter((r) => Number.isFinite(r.branch));
  if (withBranch.length === 0) return null;
  return withBranch.reduce((worst, r) => (r.branch < worst.branch ? r : worst), withBranch[0]);
}
