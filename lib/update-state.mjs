#!/usr/bin/env node
// update-state.mjs — atomically deep-merge a JSON patch into the YAML
// frontmatter of a Markdown file (STATE.md).
//
// Usage:  echo '{"iteration":5}' | node update-state.mjs <path-to-STATE.md>
// Exit:   0 on success, non-zero on failure.
//
// Parser and serialiser live in the shared ./yaml-mini.mjs module; backup rotation lives in
// ./backup.mjs (single sources of truth).

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { argv, exit, stderr, stdin } from 'node:process';
import { resolve } from 'node:path';
import { parseYaml, serializeYaml } from './yaml-mini.mjs';
import { rotateBackups } from './backup.mjs';

if (argv.length < 3) {
  stderr.write('Usage: update-state.mjs <path>\n');
  exit(2);
}

const path = resolve(argv[2]);

// Read patch from stdin (one JSON object)
let patchText = '';
for await (const chunk of stdin) patchText += chunk;
patchText = patchText.trim();
if (!patchText) {
  stderr.write('update-state: empty patch on stdin\n');
  exit(1);
}

let patch;
try { patch = JSON.parse(patchText); }
catch (e) { stderr.write(`update-state: invalid patch JSON: ${e.message}\n`); exit(1); }
if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
  stderr.write('update-state: patch must be a JSON object\n');
  exit(1);
}

// Read existing file
let raw;
try { raw = readFileSync(path, 'utf8'); }
catch (e) { stderr.write(`update-state: cannot read ${path}: ${e.message}\n`); exit(1); }

const m = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/);
if (!m) {
  stderr.write('update-state: no YAML frontmatter found\n');
  exit(1);
}
const openMarker = m[1];
const yamlText = m[2];
const closeMarker = m[3];
const body = raw.slice(m[0].length);

// Parse YAML → JS object
let frontmatter;
try { frontmatter = parseYaml(yamlText); }
catch (e) { stderr.write(`update-state: parse error: ${e.message}\n`); exit(1); }

// Deep merge
const merged = deepMerge(frontmatter, patch);

// Serialize back
const newYaml = serializeYaml(merged);
const out = `${openMarker}${newYaml}${closeMarker}${body}`;

// Back up before writing — a ring buffer (see ./backup.mjs)
rotateBackups(path);

// Atomic write: temp file → rename
const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
try {
  writeFileSync(tmp, out, 'utf8');
  renameSync(tmp, path);
} catch (e) {
  stderr.write(`update-state: write failed: ${e.message}\n`);
  exit(1);
}

exit(0);

// --- helpers ---

function deepMerge(target, source) {
  if (typeof source !== 'object' || source === null) return source;
  if (Array.isArray(source)) return source; // arrays replace, not merge
  const out = { ...(target || {}) };
  for (const k of Object.keys(source)) {
    const sv = source[k];
    const tv = out[k];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) &&
        tv && typeof tv === 'object' && !Array.isArray(tv)) {
      out[k] = deepMerge(tv, sv);
    } else {
      out[k] = sv;
    }
  }
  return out;
}
