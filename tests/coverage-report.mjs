// tests/coverage-report.mjs — reading Node's coverage table.
//
// It lives apart from tests/run.mjs for one reason: run.mjs is a script, and importing it to reach
// this function would spawn the whole suite as a side effect. A parser that cannot be examined
// without running everything it measures does not get examined.
//
// Node prints the table in one of two shapes, depending on version and platform:
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
    const m = line.match(/^#(\s+)(\S+)\s+\|\s*([\d.]*)\s*\|/);
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
    rows.push({ file, line: parseFloat(pct) });
  }
  return rows;
}

// The modules the threshold applies to: the framework's own source, not the tests measuring it.
export function sourceRows(rows) {
  return rows.filter(r => /^(core|lib|hooks)\//.test(r.file) && !/test|helpers/.test(r.file));
}
