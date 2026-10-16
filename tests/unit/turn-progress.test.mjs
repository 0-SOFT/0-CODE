import { cleanupTempDirSync } from '../helpers/index.mjs';
// tests/unit/turn-progress.test.mjs — the memory that lets a short-lived driver count turns.
//
// The module's whole job is to degrade gracefully: a missing file, a truncated one, a read-only
// directory must all mean "no baseline yet" and never "no progress" and never a broken turn. Those
// paths are the ones worth testing, because they are the ones that fire on a bad day.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEMORY_FILENAME, memoryPath, readMemory, writeMemory, stagnantAfterTurn, progressPolicy,
} from '../../core/turn-progress.mjs';

const SNAP_A = { gitHead: 'aaa111', treeHash: 'tree-1', stateHash: 'state-1' };
const SNAP_B = { gitHead: 'bbb222', treeHash: 'tree-1', stateHash: 'state-1' };

test('progress policy keeps the default, supports owner thresholds and disables escalation with zero', () => {
  for (const state of [{}, { no_progress_after: null }]) {
    assert.deepEqual(progressPolicy(state), { enabled: true, blockAfter: 3, escalateAfter: 2 });
  }
  assert.deepEqual(progressPolicy({ no_progress_after: 0 }), { enabled: false, blockAfter: Infinity, escalateAfter: Infinity });
  assert.deepEqual(progressPolicy({ no_progress_after: 1 }), { enabled: true, blockAfter: 1, escalateAfter: 1 });
  assert.deepEqual(progressPolicy({ no_progress_after: 5 }), { enabled: true, blockAfter: 5, escalateAfter: 4 });
  assert.equal(progressPolicy({ no_progress_after: '4' }).blockAfter, 4);
  for (const value of [-1, true, false, [], {}, NaN, Infinity, 1.5, 'wrong', Number.MAX_SAFE_INTEGER + 1]) {
    const result = progressPolicy({ no_progress_after: value });
    assert.equal(result.blockAfter, 3); assert.ok(result.warning);
  }
});

function mkDocs() {
  const dir = mkdtempSync(join(tmpdir(), 'turn-progress-'));
  return { dir, cleanup: () => { try { cleanupTempDirSync(dir); } catch {} } };
}

test('memory: the file sits beside the loop lock, not inside STATE', () => {
  // Not a naming preference. STATE's hash is one of the three progress signals, so keeping the
  // detector's memory there would make every write look like progress.
  assert.equal(MEMORY_FILENAME, '.loop-progress');
  assert.equal(memoryPath('/some/docs'), join('/some/docs', '.loop-progress'));
});

test('memory: a round trip returns what was stored', () => {
  const d = mkDocs();
  try {
    assert.equal(writeMemory(d.dir, SNAP_A, 2), true);
    assert.ok(existsSync(memoryPath(d.dir)));
    const m = readMemory(d.dir);
    assert.deepEqual(m.snapshot, SNAP_A);
    assert.equal(m.stagnant, 2);
  } finally { d.cleanup(); }
});

test('memory: absent, unreadable or corrupt all mean "no baseline", never "no progress"', () => {
  const d = mkDocs();
  try {
    assert.equal(readMemory(d.dir), null, 'absent');
    writeFileSync(memoryPath(d.dir), '{ not json', 'utf8');
    assert.equal(readMemory(d.dir), null, 'corrupt');
    writeFileSync(memoryPath(d.dir), '{"stagnant":5}', 'utf8');
    assert.equal(readMemory(d.dir), null, 'no snapshot in it');
    writeFileSync(memoryPath(d.dir), 'null', 'utf8');
    assert.equal(readMemory(d.dir), null, 'null');
  } finally { d.cleanup(); }
});

test('memory: a stagnant count that is not a number falls back to zero', () => {
  const d = mkDocs();
  try {
    writeFileSync(memoryPath(d.dir), JSON.stringify({ snapshot: SNAP_A, stagnant: 'lots' }), 'utf8');
    assert.equal(readMemory(d.dir).stagnant, 0);
  } finally { d.cleanup(); }
});

test('memory: failing to write is reported, not thrown', () => {
  // A directory that does not exist stands in for any unwritable location. An observer that can
  // throw is an observer that can stop the turn it was only supposed to watch.
  assert.equal(writeMemory(join(tmpdir(), 'definitely-not-here-1.8.0', 'docs'), SNAP_A, 1), false);
});

test('counting: no memory is a baseline, which is zero — not a stalled turn', () => {
  assert.equal(stagnantAfterTurn(null, SNAP_A), 0);
});

test('counting: an unchanged snapshot increments, a changed one resets', () => {
  assert.equal(stagnantAfterTurn({ snapshot: SNAP_A, stagnant: 0 }, SNAP_A), 1);
  assert.equal(stagnantAfterTurn({ snapshot: SNAP_A, stagnant: 1 }, SNAP_A), 2);
  assert.equal(stagnantAfterTurn({ snapshot: SNAP_A, stagnant: 2 }, SNAP_A), 3);
  assert.equal(stagnantAfterTurn({ snapshot: SNAP_A, stagnant: 2 }, SNAP_B), 0, 'a new commit is work');
});

test('counting: any one of the three signals is enough to reset', () => {
  for (const changed of [
    { ...SNAP_A, gitHead: 'ccc333' },
    { ...SNAP_A, treeHash: 'tree-2' },
    { ...SNAP_A, stateHash: 'state-2' },
  ]) {
    assert.equal(stagnantAfterTurn({ snapshot: SNAP_A, stagnant: 2 }, changed), 0);
  }
});
