import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock, refreshLock, releaseLock, readLock, ownerState, lockPath, LOCK_TTL_MS,
} from '../../core/loop-lock.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'lock-'));
const MOMENT = Date.parse('2026-08-11T12:00:00Z');

// The lock came out of a real case: two supervisors wrote to the same docs/STATE.md and
// competed over the state. We test exactly the behaviour that was missing.

test('a free project: the lock is acquired', () => {
  const d = tmp();
  try {
    const r = acquireLock({ projectDir: d, pid: 111, host: 'host-A', now: MOMENT });
    assert.equal(r.acquired, true);
    assert.equal(r.state, 'free');
    assert.equal(r.takenOver, false);
    const l = readLock(d);
    assert.equal(l.pid, 111);
    assert.equal(l.host, 'host-A');
    assert.ok(l.startedAt && l.heartbeatAt);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a live owner: the second launch gets an honest refusal with an explanation', () => {
  const d = tmp();
  try {
    acquireLock({ projectDir: d, pid: 111, host: 'host-A', engine: 'supervisor', now: MOMENT });
    const second = acquireLock({
      projectDir: d, pid: 222, host: 'host-A', now: MOMENT + 1000,
      pidAlive: (pid) => pid === 111,          // the first one is alive
    });
    assert.equal(second.acquired, false, 'the second launch must not take the lock');
    assert.equal(second.state, 'alive');
    assert.match(second.reason, /111/, 'the refusal must name the owner');
    assert.equal(readLock(d).pid, 111, 'somebody else lock was not overwritten');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a dead owner: the loop is taken over — a crash does not block autonomy forever', () => {
  const d = tmp();
  try {
    acquireLock({ projectDir: d, pid: 111, host: 'host-A', now: MOMENT });
    const second = acquireLock({
      projectDir: d, pid: 222, host: 'host-A', now: MOMENT + 1000,
      pidAlive: () => false,                    // the process died
    });
    assert.equal(second.acquired, true);
    assert.equal(second.takenOver, true);
    assert.match(second.reason, /is dead/);
    assert.equal(readLock(d).pid, 222);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a stale heartbeat: take-over even when the process is formally alive', () => {
  const d = tmp();
  try {
    acquireLock({ projectDir: d, pid: 111, host: 'host-A', now: MOMENT });
    const second = acquireLock({
      projectDir: d, pid: 222, host: 'host-A',
      now: MOMENT + LOCK_TTL_MS + 1,
      pidAlive: () => true,                     // it hangs without showing any sign of life
    });
    assert.equal(second.acquired, true);
    assert.equal(second.state, 'stale');
    assert.match(second.reason, /went stale/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('another machine with a fresh heartbeat: no take-over — we cannot verify the process', () => {
  const d = tmp();
  try {
    acquireLock({ projectDir: d, pid: 111, host: 'host-B', now: MOMENT });
    const second = acquireLock({
      projectDir: d, pid: 222, host: 'host-A', now: MOMENT + 1000, pidAlive: () => false,
    });
    assert.equal(second.acquired, false);
    assert.equal(second.state, 'foreign-unknown');
    assert.match(second.reason, /host-B/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('heartbeat: refreshed by its owner and NOT by anyone else', () => {
  const d = tmp();
  try {
    acquireLock({ projectDir: d, pid: 111, host: 'host-A', now: MOMENT });
    assert.equal(refreshLock({ projectDir: d, pid: 111, now: MOMENT + 5000 }), true);
    assert.equal(readLock(d).heartbeatAt, new Date(MOMENT + 5000).toISOString());
    assert.equal(refreshLock({ projectDir: d, pid: 999, now: MOMENT + 9000 }), false,
      'a foreign process must not refresh a lock it does not own');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('release: we only release our own lock', () => {
  const d = tmp();
  try {
    acquireLock({ projectDir: d, pid: 111, host: 'host-A', now: MOMENT });
    assert.equal(releaseLock({ projectDir: d, pid: 222 }), false, 'a lock owned by somebody else must not be touched');
    assert.ok(existsSync(lockPath(d)));
    assert.equal(releaseLock({ projectDir: d, pid: 111 }), true);
    assert.equal(existsSync(lockPath(d)), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a corrupt lock file does not break the loop — it counts as free', () => {
  const d = tmp();
  try {
    mkdirSync(join(d, 'docs'), { recursive: true });
    writeFileSync(lockPath(d), '{this is not json', 'utf8');
    assert.equal(readLock(d), null);
    assert.equal(ownerState(readLock(d)), 'free');
    assert.equal(acquireLock({ projectDir: d, pid: 111, now: MOMENT }).acquired, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
