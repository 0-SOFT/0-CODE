#!/usr/bin/env node
// parse-state.mjs — parse YAML frontmatter of a Markdown file, print as JSON.
//
// Usage:  node parse-state.mjs <path-to-STATE.md>
// Output: JSON object on stdout (the frontmatter), or non-zero exit on failure.
//
// The parser lives in the shared ./yaml-mini.mjs module (a single source of truth).

import { readFileSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';
import { parseYaml } from './yaml-mini.mjs';

if (argv.length < 3) {
  stderr.write('Usage: parse-state.mjs <path>\n');
  exit(2);
}

const path = argv[2];
let raw;
try {
  raw = readFileSync(path, 'utf8');
} catch (e) {
  stderr.write(`parse-state: cannot read ${path}: ${e.message}\n`);
  exit(1);
}

// Extract frontmatter between leading --- ... ---
const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
if (!m) {
  stderr.write('parse-state: no YAML frontmatter found\n');
  exit(1);
}

try {
  const parsed = parseYaml(m[1]);
  stdout.write(JSON.stringify(parsed));
} catch (e) {
  stderr.write(`parse-state: YAML parse error: ${e.message}\n`);
  exit(1);
}
