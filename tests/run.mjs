#!/usr/bin/env node
// tests/run.mjs — a zero-dependency test runner for the framework (v0.9.0).
//
// It finds tests/**/*.test.mjs and runs them through the native `node --test` with coverage
// (`--experimental-test-coverage`). No external dependencies (jest/vitest/c8) — KISS:
// project itself is zero-dependency. smoke.sh remains a separate, fast smoke gate.
//
// Usage:
//   node tests/run.mjs                 — every test plus the coverage report
//   node tests/run.mjs unit            — only tests/unit
//   node tests/run.mjs integration e2e — several folders
//   node tests/run.mjs --test-concurrency=4 --coverage-min=80 — an explicit process limit

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { coverageRows, sourceRows, missingSourceDirs, worstBranch } from './coverage-report.mjs';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));

function findTests(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...findTests(p));
    else if (name.endsWith('.test.mjs')) out.push(p);
  }
  return out;
}

// Argument parsing: subfolders plus --coverage-min=N (a threshold over the SOURCE modules).
// Node 20.x does not support --test-coverage-lines, so we compute the threshold by parsing the report.
let coverageMin = null;
let concurrency = null;
const subdirs = [];
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--test-concurrency')) {
    const match = /^--test-concurrency=(\d+)$/.exec(a);
    const value = match ? Number(match[1]) : NaN;
    if (concurrency !== null || !Number.isSafeInteger(value) || value < 1) {
      console.error('tests/run.mjs: use --test-concurrency=N once, with a positive safe integer');
      process.exit(2);
    }
    concurrency = value;
    continue;
  }
  const m = a.match(/^--coverage-min=(\d+(?:\.\d+)?)$/);
  if (m) coverageMin = parseFloat(m[1]);
  else subdirs.push(a);
}
const roots = subdirs.length ? subdirs.map(d => join(TESTS_DIR, d)) : [TESTS_DIR];
const files = roots.flatMap(findTests).sort();

if (files.length === 0) {
  console.error('tests/run.mjs: no test files (*.test.mjs) found');
  process.exit(1);
}

console.log(`tests/run.mjs: running ${files.length} test files through node --test with coverage\n`);
if (concurrency !== null) console.log(`tests/run.mjs: explicit test concurrency ${concurrency}\n`);
const res = spawnSync(process.execPath,
  ['--test', '--experimental-test-coverage',
    ...(concurrency === null ? [] : [`--test-concurrency=${concurrency}`]), ...files],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);
if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);

// Coverage threshold over the source modules (core/ lib/ hooks/), excluding tests and helpers.
// The table parser lives in ./coverage-report.mjs so it can be examined without running the suite.
if (coverageMin !== null) {
  const all = coverageRows(res.stdout);
  const rows = sourceRows(all);
  if (rows.length === 0) {
    console.error('\nFAIL the coverage gate matched no source modules — it would pass vacuously.');
    console.error(`   parsed ${all.length} row(s) from the report; expected core/, lib/ and hooks/ among them.`);
    process.exit(1);
  }
  // P2-001 (v1.17.0): "no rows at all" was the only vacuity the guard could see. If one directory
  // out of three stopped being recognised, plenty of rows would remain and the gate would pass on a
  // measurement that had quietly lost hooks/ — the two files that decide whether the loop continues
  // and whether a dangerous command runs.
  const absent = missingSourceDirs(rows);
  if (absent.length) {
    console.error(`\nFAIL the coverage gate saw no modules at all from: ${absent.join(', ')}`);
    console.error('   part of the source left the measurement without the gate noticing.');
    process.exit(1);
  }

  const below = rows.filter(r => r.line < coverageMin);
  if (below.length) {
    console.error(`\nFAIL coverage is below the ${coverageMin}% threshold for these source modules:`);
    for (const r of below) console.error(`   ${r.file}: ${r.line}%`);
    process.exit(1);
  }
  // P1-001 (v1.17.0): this line used to be the whole report, and it says "of lines" — truthfully,
  // but next to nothing else. Measured at the time: two modules sat at 88 % and 84 % of lines while
  // both were at 12.50 % of BRANCHES, and those two are the Stop hook and the safety guard. A
  // reader took "all source modules are at or above 80 %" for a statement about coverage.
  //
  // Branch coverage is now reported beside it, and the worst module is named. It is NOT gated: a
  // branch threshold is a choice with a real cost, and the change that stops a report overstating
  // itself is not the change that should quietly impose one.
  //
  // Honest limitation, so the number is not over-read either: the hooks are exercised through
  // spawnSync (tests/integration/hooks.test.mjs), and a subprocess's branches are not attributed
  // here. A low number therefore means "not verified in this measurement", which is not the same as
  // "not tested" — and telling those apart is exactly what the old single line made impossible.
  console.log(`\nOK measured source modules (${rows.length}) are at or above ${coverageMin}% of lines`);
  const worst = worstBranch(rows);
  if (worst) {
    console.log(`   branches are NOT gated; the lowest is ${worst.file} at ${worst.branch}%`);
    console.log('   (a module run only as a subprocess reports low branches even when tested)');
  } else {
    console.log('   the coverage table carried no branch column, so nothing is known about branches');
  }
} else {
  // P2-003 (v1.17.0), found while fixing P1-001. The gate is opt-in through --coverage-min, and
  // without it the suite still PRINTS the entire coverage table — so a reader sees percentages, sees
  // a green run, and concludes the threshold held. It never ran. Measured on the author of this very
  // change: every coverage claim made during this session came from reading that table by eye while
  // the gate sat idle. Silence that looks like success is the defect class this project exists for.
  console.log('\nNOTE the table above was printed but NOT checked: no --coverage-min was given.');
  console.log('   CI runs: node tests/run.mjs --coverage-min=80 — do the same to have it enforced.');
}
process.exit(0);
