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

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
const subdirs = [];
for (const a of process.argv.slice(2)) {
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
const res = spawnSync(process.execPath,
  ['--test', '--experimental-test-coverage', ...files],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);
if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);

// Coverage threshold over the source modules (core/ lib/ hooks/), excluding tests and helpers.
if (coverageMin !== null) {
  const rows = [];
  for (const line of (res.stdout || '').split('\n')) {
    const m = line.match(/^#\s+(\S+\.mjs)\s+\|\s+([\d.]+)\s+\|/);
    if (!m) continue;
    const file = m[1];
    if (/(^|[\\/])(core|lib|hooks)[\\/]/.test(file) && !/test|helpers/.test(file)) {
      rows.push({ file, line: parseFloat(m[2]) });
    }
  }
  const below = rows.filter(r => r.line < coverageMin);
  if (below.length) {
    console.error(`\nFAIL coverage is below the ${coverageMin}% threshold for these source modules:`);
    for (const r of below) console.error(`   ${r.file}: ${r.line}%`);
    process.exit(1);
  }
  console.log(`\nOK all source modules (${rows.length}) are at or above ${coverageMin}% of lines`);
}
process.exit(0);
