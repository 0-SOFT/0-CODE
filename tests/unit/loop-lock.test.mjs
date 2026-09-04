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

// --- v1.14.0: liveness evidence -------------------------------------------------------------
//
// THE DEFECT THESE EXIST FOR, measured before the fix. The Stop hook put its OWN process number
// into the lock, and a hook process lives for milliseconds. So ownerState answered "dead" on a lock
// written a moment ago, the `isOurs` branch inside the hook was unreachable, and every extra
// Claude Code session in the project took the loop away from the previous one each turn.
//
// The lengthening of a time-to-live cannot fix it: liveness is judged BEFORE staleness, so no
// deadline is ever consulted. What has to change is the evidence, not its deadline.

test('a session lock stays alive while its transcript is being written', () => {
  const lock = {
    pid: 999999, host: 'host-A', engine: 'stop-hook', sessionId: 'session-A',
    liveness: { kind: 'file', id: '/tmp/session-A.jsonl' },
    startedAt: new Date(MOMENT).toISOString(), heartbeatAt: new Date(MOMENT).toISOString(),
  };
  const state = ownerState(lock, {
    now: MOMENT + 40 * 60 * 1000,             // long past any heartbeat deadline
    host: 'host-A',
    pidAlive: () => false,                    // the hook process is long gone, as it always is
    fileTouchedAt: () => MOMENT + 39 * 60 * 1000,   // but the session is writing right now
  });
  assert.equal(state, 'alive', 'the transcript lives exactly as long as the session does');
});

test('a session lock goes stale when its transcript stops being written', () => {
  const lock = {
    pid: 999999, host: 'host-A', engine: 'stop-hook', sessionId: 'session-A',
    liveness: { kind: 'file', id: '/tmp/session-A.jsonl' },
    startedAt: new Date(MOMENT).toISOString(), heartbeatAt: new Date(MOMENT).toISOString(),
  };
  const state = ownerState(lock, {
    now: MOMENT + 40 * 60 * 1000, host: 'host-A',
    pidAlive: () => false,
    fileTouchedAt: () => MOMENT + 1000,       // nothing written since the session died
  });
  assert.equal(state, 'stale', 'a silent transcript is the only thing that can free the loop here');
});

test('a missing transcript is not an exception — it simply is not evidence of life', () => {
  const lock = {
    pid: 999999, host: 'host-A', engine: 'stop-hook', sessionId: 'session-A',
    liveness: { kind: 'file', id: '/tmp/gone.jsonl' },
    startedAt: new Date(MOMENT).toISOString(), heartbeatAt: new Date(MOMENT).toISOString(),
  };
  const state = ownerState(lock, {
    now: MOMENT + 60 * 1000, host: 'host-A',
    pidAlive: () => false, fileTouchedAt: () => null,
  });
  assert.equal(state, 'alive', 'the heartbeat is fresh, so the owner is alive on that alone');
});

test('a lock written before v1.14.0 is still judged by its process number', () => {
  const old = {
    pid: 111, host: 'host-A', engine: 'supervisor',
    startedAt: new Date(MOMENT).toISOString(), heartbeatAt: new Date(MOMENT).toISOString(),
  };
  assert.equal(ownerState(old, { now: MOMENT + 1000, host: 'host-A', pidAlive: p => p === 111 }),
    'alive', 'no evidence field means the process number, as it always did');
  assert.equal(ownerState(old, { now: MOMENT + 1000, host: 'host-A', pidAlive: () => false }),
    'dead');
});

test('the supervisor keeps being judged by its process, with no special case for engine names', () => {
  const d = tmp();
  try {
    acquireLock({ projectDir: d, pid: 111, host: 'host-A', engine: 'supervisor', now: MOMENT });
    const lock = readLock(d);
    assert.equal(lock.liveness.kind, 'process', 'a process that outlives the turn proves itself');
    assert.equal(Number(lock.liveness.id), 111);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('two sessions: the live one keeps the loop, the second is refused and told who holds it', () => {
  const d = tmp();
  try {
    acquireLock({
      projectDir: d, pid: 500, host: 'host-A', engine: 'stop-hook', sessionId: 'session-A',
      liveness: { kind: 'file', id: '/tmp/session-A.jsonl' }, now: MOMENT,
    });
    const second = acquireLock({
      projectDir: d, pid: 600, host: 'host-A', engine: 'stop-hook', sessionId: 'session-B',
      liveness: { kind: 'file', id: '/tmp/session-B.jsonl' },
      now: MOMENT + 5 * 60 * 1000,
      pidAlive: () => false,                              // both hook processes are dead, as always
      fileTouchedAt: (p) => p === '/tmp/session-A.jsonl' ? MOMENT + 4 * 60 * 1000 : null,
    });
    assert.equal(second.acquired, false, 'this is the whole point of the version');
    assert.match(second.reason, /session-A/, 'the refusal names the session that holds the loop');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a session refreshes its own lock across invocations, though every process number differs', () => {
  const d = tmp();
  const evidence = { kind: 'file', id: '/tmp/session-A.jsonl' };
  try {
    acquireLock({
      projectDir: d, pid: 500, host: 'host-A', engine: 'stop-hook', sessionId: 'session-A',
      liveness: evidence, now: MOMENT,
    });
    // The next turn is a different hook process entirely — identity comes from the evidence.
    assert.equal(refreshLock({ projectDir: d, pid: 501, liveness: evidence, now: MOMENT + 60000 }),
      true, 'the same session must be able to keep its own lock alive');
    assert.equal(readLock(d).heartbeatAt, new Date(MOMENT + 60000).toISOString());
    assert.equal(
      refreshLock({ projectDir: d, pid: 502, liveness: { kind: 'file', id: '/tmp/session-B.jsonl' }, now: MOMENT + 70000 }),
      false, 'another session must not be able to keep somebody else s lock alive');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a session with no transcript path still holds the loop, on its heartbeat alone', () => {
  const d = tmp();
  try {
    const r = acquireLock({
      projectDir: d, pid: 500, host: 'host-A', engine: 'stop-hook', sessionId: 'session-A',
      liveness: { kind: 'heartbeat', id: 'session-A' }, now: MOMENT,
    });
    assert.equal(r.acquired, true, 'a missing transcript must never stop the loop being driven');
    const second = acquireLock({
      projectDir: d, pid: 600, host: 'host-A', engine: 'stop-hook', sessionId: 'session-B',
      liveness: { kind: 'heartbeat', id: 'session-B' },
      now: MOMENT + 60 * 1000, pidAlive: () => false,
    });
    assert.equal(second.acquired, false, 'and it is still one owner at a time');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
