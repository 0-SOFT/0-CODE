import { test } from 'node:test';
import { cleanupTempDir } from '../helpers/index.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync,
  unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock, refreshLock, releaseLock, readLock, ownerState, lockPath, LOCK_TTL_MS,
  refreshLockEventually, acquireLockEventually, LOCK_BUSY,
} from '../../core/loop-lock.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'lock-'));
const MOMENT = Date.parse('2026-08-11T12:00:00Z');

// The lock came out of a real case: two supervisors wrote to the same docs/STATE.md and
// competed over the state. We test exactly the behaviour that was missing.

test('a free project: the lock is acquired', async () => {
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
  } finally { await cleanupTempDir(d); }
});

test('a live owner: the second launch gets an honest refusal with an explanation', async () => {
  const d = tmp();
  try {
    const first=await acquireLockEventually({ projectDir: d, pid: 111, host: 'host-A', engine: 'supervisor', now: MOMENT });
    assert.equal(first.acquired,true,JSON.stringify(first));
    const second = acquireLock({
      projectDir: d, pid: 222, host: 'host-A', now: MOMENT + 1000,
      pidAlive: (pid) => pid === 111,          // the first one is alive
    });
    assert.equal(second.acquired, false, 'the second launch must not take the lock');
    assert.equal(second.state, 'alive');
    assert.match(second.reason, /111/, 'the refusal must name the owner');
    assert.equal(readLock(d).pid, 111, 'somebody else lock was not overwritten');
  } finally { await cleanupTempDir(d); }
});

test('a dead owner: the loop is taken over — a crash does not block autonomy forever', async () => {
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
  } finally { await cleanupTempDir(d); }
});

test('a stale heartbeat: take-over even when the process is formally alive', async () => {
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
  } finally { await cleanupTempDir(d); }
});

test('another machine with a fresh heartbeat: no take-over — we cannot verify the process', async () => {
  const d = tmp();
  try {
    acquireLock({ projectDir: d, pid: 111, host: 'host-B', now: MOMENT });
    const second = acquireLock({
      projectDir: d, pid: 222, host: 'host-A', now: MOMENT + 1000, pidAlive: () => false,
    });
    assert.equal(second.acquired, false);
    assert.equal(second.state, 'foreign-unknown');
    assert.match(second.reason, /host-B/);
  } finally { await cleanupTempDir(d); }
});

test('heartbeat: refreshed by its owner and NOT by anyone else', async () => {
  const d = tmp();
  try {
    acquireLock({ projectDir: d, pid: 111, host: 'host-A', now: MOMENT });
    assert.equal(refreshLock({ projectDir: d, pid: 111, now: MOMENT + 5000 }), true);
    assert.equal(readLock(d).heartbeatAt, new Date(MOMENT + 5000).toISOString());
    assert.equal(refreshLock({ projectDir: d, pid: 999, now: MOMENT + 9000 }), false,
      'a foreign process must not refresh a lock it does not own');
  } finally { await cleanupTempDir(d); }
});

test('release: we only release our own lock', async () => {
  const d = tmp();
  try {
    acquireLock({ projectDir: d, pid: 111, host: 'host-A', now: MOMENT });
    assert.equal(releaseLock({ projectDir: d, pid: 222 }), false, 'a lock owned by somebody else must not be touched');
    assert.ok(existsSync(lockPath(d)));
    assert.equal(releaseLock({ projectDir: d, pid: 111 }), true);
    assert.equal(existsSync(lockPath(d)), false);
  } finally { await cleanupTempDir(d); }
});

test('a corrupt lock file does not break the loop — it counts as free', async () => {
  const d = tmp();
  try {
    mkdirSync(join(d, 'docs'), { recursive: true });
    writeFileSync(lockPath(d), '{this is not json', 'utf8');
    assert.equal(readLock(d), null);
    assert.equal(ownerState(readLock(d)), 'free');
    assert.equal(acquireLock({ projectDir: d, pid: 111, now: MOMENT }).acquired, true);
  } finally { await cleanupTempDir(d); }
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

test('the supervisor keeps being judged by its process, with no special case for engine names', async () => {
  const d = tmp();
  try {
    acquireLock({ projectDir: d, pid: 111, host: 'host-A', engine: 'supervisor', now: MOMENT });
    const lock = readLock(d);
    assert.equal(lock.liveness.kind, 'process', 'a process that outlives the turn proves itself');
    assert.equal(Number(lock.liveness.id), 111);
  } finally { await cleanupTempDir(d); }
});

test('two sessions: the live one keeps the loop, the second is refused and told who holds it', async () => {
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
  } finally { await cleanupTempDir(d); }
});

test('a session refreshes its own lock across invocations, though every process number differs', async () => {
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
  } finally { await cleanupTempDir(d); }
});

test('a session with no transcript path still holds the loop, on its heartbeat alone', async () => {
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
  } finally { await cleanupTempDir(d); }
});

function holdMutation(dir, { pid = process.pid, host = hostname(), bytes } = {}) {
  const guard = lockPath(dir) + '.guard';
  mkdirSync(guard);
  const marker = join(guard, 'owner-01234567-abcd-4567-890a-0123456789ab.json');
  writeFileSync(marker, bytes ?? JSON.stringify({ pid, host }));
  return () => { unlinkSync(marker); rmdirSync(guard); };
}

test('a brief live mutation is explicit busy rather than an ownership claim or loss', async () => {
  const dir = tmp();
  try {
    acquireLock({ projectDir: dir, now: MOMENT });
    const before = readFileSync(lockPath(dir));
    const leave = holdMutation(dir);
    assert.equal(refreshLock({ projectDir: dir, now: MOMENT + 1000 }), LOCK_BUSY);
    assert.deepEqual(readFileSync(lockPath(dir)), before, 'busy heartbeat must not overwrite the transaction');
    assert.equal(refreshLock({ projectDir: dir, pid: process.pid + 1 }), LOCK_BUSY);
    assert.equal(releaseLock({ projectDir: dir }), false);
    assert.equal(acquireLock({ projectDir: dir }).acquired, false);
    leave();
    assert.equal(refreshLock({ projectDir: dir, now: MOMENT + 2000 }), true);
    assert.equal(readLock(dir).heartbeatAt, new Date(MOMENT + 2000).toISOString());
    assert.equal(releaseLock({ projectDir: dir }), true);
    assert.deepEqual(readdirSync(join(dir, 'docs')), [], 'no live mutex or staging names remain');
  } finally { await cleanupTempDir(dir); }
});

test('a busy mutex cannot invent ownership when there is no lock snapshot', async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'docs')); const leave = holdMutation(dir);
    assert.equal(refreshLock({ projectDir: dir, liveness: { kind: 'process', id: '' } }), LOCK_BUSY);
    leave();
  } finally { await cleanupTempDir(dir); }
});

test('a dead local mutation holder is reclaimed without changing loop liveness rules', async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'docs')); holdMutation(dir, { pid: 999999999 });
    assert.equal(acquireLock({ projectDir: dir, now: MOMENT }).acquired, true);
    assert.equal(readLock(dir).pid, process.pid);
    assert.equal(existsSync(lockPath(dir) + '.guard'), false);
    assert.equal(releaseLock({ projectDir: dir }), true);
  } finally { await cleanupTempDir(dir); }
});

test('foreign and malformed mutation owners fail closed without removing their marker', async () => {
  for (const holder of [{ host: 'another-machine' }, { bytes: '{not-json' }]) {
    const dir = tmp();
    try {
      mkdirSync(join(dir, 'docs')); const leave = holdMutation(dir, holder);
      assert.equal(acquireLock({ projectDir: dir }).acquired, false);
      assert.equal(existsSync(lockPath(dir) + '.guard'), true);
      leave();
    } finally { await cleanupTempDir(dir); }
  }
});

test('an empty abandoned mutation directory is safely reclaimed', async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'docs')); mkdirSync(lockPath(dir) + '.guard');
    assert.equal(acquireLock({ projectDir: dir }).acquired, true);
    assert.equal(releaseLock({ projectDir: dir }), true);
  } finally { await cleanupTempDir(dir); }
});

test('failed lock publication frees its mutex and does not remove the obstructing path', async () => {
  const dir = tmp();
  try {
    mkdirSync(lockPath(dir), { recursive: true });
    assert.throws(() => acquireLock({ projectDir: dir }));
    assert.equal(existsSync(lockPath(dir)), true);
    assert.equal(existsSync(lockPath(dir) + '.guard'), false);
    assert.deepEqual(readdirSync(join(dir, 'docs')), ['.loop.lock']);
  } finally { await cleanupTempDir(dir); }
});

test('bounded async confirmation retries a brief busy mutation and really writes the heartbeat', async () => {
  const dir = tmp();
  try {
    acquireLock({ projectDir: dir, now: MOMENT }); const leave = holdMutation(dir);
    let pauses = 0;
    const result = await refreshLockEventually({ projectDir: dir, now: MOMENT + 1000 }, {
      attempts: 3, delayMs: 10, wait: async ms => { assert.equal(ms, 10); pauses++; leave(); },
    });
    assert.equal(result, true); assert.equal(pauses, 1);
    assert.equal(readLock(dir).heartbeatAt, new Date(MOMENT + 1000).toISOString());
  } finally { await cleanupTempDir(dir); }
});

test('bounded async confirmation preserves busy as a distinct unanswered result', async () => {
  const dir = tmp();
  try {
    acquireLock({ projectDir: dir, now: MOMENT }); const before = readFileSync(lockPath(dir));
    const leave = holdMutation(dir); let pauses = 0;
    const result = await refreshLockEventually({ projectDir: dir, now: MOMENT + 1000 }, {
      attempts: 3, delayMs: 0, wait: async () => { pauses++; },
    });
    assert.equal(result, LOCK_BUSY); assert.equal(pauses, 2);
    assert.deepEqual(readFileSync(lockPath(dir)), before);
    leave();
  } finally { await cleanupTempDir(dir); }
});

test('confirmation after a busy takeover finds the new owner and never refreshes the old one', async () => {
  const dir = tmp();
  try {
    acquireLock({ projectDir: dir, now: MOMENT }); const leave = holdMutation(dir);
    const result = await refreshLockEventually({ projectDir: dir }, { attempts: 3, wait: async () => {
      leave();
      assert.equal(acquireLock({ projectDir: dir, pid: 123456, now: MOMENT + LOCK_TTL_MS + 1 }).acquired, true);
    } });
    assert.equal(result, false);
    assert.equal(readLock(dir).pid, 123456);
    assert.equal(readLock(dir).heartbeatAt, new Date(MOMENT + LOCK_TTL_MS + 1).toISOString());
  } finally { await cleanupTempDir(dir); }
});

test('lock confirmation refuses invalid retry parameters', async () => {
  for (const options of [{ attempts: 0 }, { attempts: Infinity }, { delayMs: -1 }, { wait: null }]) {
    await assert.rejects(refreshLockEventually({}, options), /Invalid loop lock retry parameters/);
  }
});

test('bounded async acquisition lets an owning session continue after a brief mutation', async () => {
  const dir = tmp(), liveness = { kind: 'heartbeat', id: 'owning-session' };
  try {
    acquireLock({ projectDir: dir, liveness, sessionId: 'owning-session' });
    const startedAt = readLock(dir).startedAt, leave = holdMutation(dir); let pauses = 0;
    const result = await acquireLockEventually({ projectDir: dir, liveness, sessionId: 'owning-session' }, {
      attempts: 3, wait: async () => { pauses++; leave(); },
    });
    assert.equal(result.acquired, true); assert.equal(pauses, 1);
    assert.equal(readLock(dir).startedAt, startedAt);
  } finally { await cleanupTempDir(dir); }
});

test('bounded async acquisition does not invent a free owner when the mutex stays busy', async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'docs')); const leave = holdMutation(dir); let pauses = 0;
    const result = await acquireLockEventually({ projectDir: dir }, {
      attempts: 3, wait: async () => { pauses++; },
    });
    assert.equal(result.acquired, false); assert.equal(result.state, LOCK_BUSY); assert.equal(pauses, 2);
    assert.equal(readLock(dir), null); leave();
  } finally { await cleanupTempDir(dir); }
});
