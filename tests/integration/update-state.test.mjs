import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkTempProject, readFrontmatter } from '../helpers/index.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const UPDATE = join(ROOT, 'lib', 'update-state.mjs');

function apply(stateFile, patch) {
  return spawnSync(process.execPath, [UPDATE, stateFile], { input: patch, encoding: 'utf8' });
}

test('update-state: applies the patch and creates a backup', () => {
  const p = mkTempProject({ iteration: 1 });
  try {
    const r = apply(p.stateFile, '{"iteration":7}');
    assert.equal(r.status, 0);
    assert.equal(readFrontmatter(p.stateFile).iteration, 7);
    assert.ok(existsSync(`${p.stateFile}.bak.1`));
  } finally { p.cleanup(); }
});

test('update-state: empty stdin → non-zero exit', () => {
  const p = mkTempProject();
  try {
    const r = apply(p.stateFile, '');
    assert.notEqual(r.status, 0);
  } finally { p.cleanup(); }
});

test('update-state: a non-JSON patch → non-zero exit', () => {
  const p = mkTempProject();
  try {
    const r = apply(p.stateFile, 'this is not json');
    assert.notEqual(r.status, 0);
  } finally { p.cleanup(); }
});

test('update-state: an array in the patch replaces rather than merges', () => {
  const p = mkTempProject({ blockers: [{ a: 1 }] });
  try {
    const r = apply(p.stateFile, '{"blockers":[]}');
    assert.equal(r.status, 0);
    assert.deepEqual(readFrontmatter(p.stateFile).blockers, []);
  } finally { p.cleanup(); }
});

test('update-state: leaves no .tmp.* file behind on success (atomicity)', () => {
  const p = mkTempProject({ iteration: 0 });
  try {
    const r = apply(p.stateFile, '{"iteration":3}');
    assert.equal(r.status, 0);
    // the real temp name is STATE.md.tmp.<pid>.<ts> — we scan the directory instead of guessing
    const leftovers = readdirSync(join(p.dir, 'docs')).filter(f => f.includes('STATE.md.tmp'));
    assert.deepEqual(leftovers, []);
  } finally { p.cleanup(); }
});
