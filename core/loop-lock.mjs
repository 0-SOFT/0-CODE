// core/loop-lock.mjs — the autonomous loop lock (v1.5.0).
//
// WHY. While working on v1.4.0 we started TWO supervisors against the same `docs/STATE.md`: they
// competed for state writes, the iteration counter and the commits got mixed up, and the machine
// load tripled. Nothing prevented it — no warning, no check. For unattended operation that is a
// direct path to corrupted state, so a lock is mandatory.
//
// PRINCIPLE. The lock does not "forbid a second copy" — it determines whether a LIVE OWNER EXISTS:
//   - owner alive          → the second launch refuses honestly and explains who holds the loop;
//   - owner dead           → take over the loop (mirroring the "adoption" logic of the v0.5.9 Stop
//                            hook): a crashed process must not stop autonomy forever;
//   - heartbeat gone stale → the same, even if the process is formally still listed as running.
//
// The "is the process alive" check is `process.kill(pid, 0)`: no signal is sent, but the kernel
// answers whether the process exists. Works on both Windows and POSIX. For ANOTHER machine we
// cannot check the process, so there only the heartbeat decides.
//
// Every function takes time, host name and the liveness check as parameters — so behaviour can be
// tested without race conditions and without real processes.

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';

export const LOCK_FILE = join('docs', '.loop.lock');

// How long the lock is considered alive without a heartbeat update. An agent turn is capped at
// 15 minutes (OPENCODE_TURN_TIMEOUT_MS), so 30 minutes gives a twofold margin: a live loop never
// looks dead, and a dead one releases the project within a reasonable time.
export const LOCK_TTL_MS = 30 * 60 * 1000;

export function lockPath(projectDir = process.cwd()) {
  return join(projectDir, LOCK_FILE);
}

export function readLock(projectDir = process.cwd()) {
  const p = lockPath(projectDir);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// Is a process with this id alive on THIS machine?
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }   // EPERM — the process exists but is not ours
}

// State of the lock owner: 'free' | 'alive' | 'dead' | 'stale' | 'foreign-unknown'.
// Pure function: everything external arrives as a parameter.
export function ownerState(lock, {
  now = Date.now(), host = hostname(), ttlMs = LOCK_TTL_MS, pidAlive = isPidAlive,
} = {}) {
  if (!lock || typeof lock !== 'object') return 'free';
  // The timestamp in the lock is an ISO string, so we parse it with Date.parse rather than Number:
  // Number("2026-…") yields NaN, which would make a live lock look stale (caught by a test during
  // development).
  const beat = Date.parse(lock.heartbeatAt || lock.startedAt || '');
  const stale = !Number.isFinite(beat) || (now - beat) > ttlMs;
  if (lock.host && lock.host !== host) {
    // Another machine: we have no way to check the process, so we trust the heartbeat alone.
    return stale ? 'stale' : 'foreign-unknown';
  }
  if (!pidAlive(Number(lock.pid))) return 'dead';
  return stale ? 'stale' : 'alive';
}

// Attempt to take the lock.
// Returns { acquired, state, takenOver, previous, reason }.
export function acquireLock({
  projectDir = process.cwd(), pid = process.pid, host = hostname(), engine = 'supervisor',
  sessionId = null, now = Date.now(), ttlMs = LOCK_TTL_MS, pidAlive = isPidAlive,
} = {}) {
  const previous = readLock(projectDir);
  const state = ownerState(previous, { now, host, ttlMs, pidAlive });

  if (state === 'alive' || state === 'foreign-unknown') {
    return {
      acquired: false, state, takenOver: false, previous,
      reason: state === 'alive'
        ? `the loop is already running as process ${previous.pid} (${previous.engine || 'unknown engine'}), started ${previous.startedAt}`
        : `the loop is held by host "${previous.host}" (process ${previous.pid}) with a fresh heartbeat — it cannot be verified from here`,
    };
  }

  const lock = {
    pid, host, engine, sessionId,
    startedAt: new Date(now).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
  };
  const p = lockPath(projectDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(lock, null, 2), 'utf8');

  return {
    acquired: true, state, takenOver: state === 'dead' || state === 'stale', previous,
    reason: state === 'free' ? 'the lock was free'
      : state === 'dead' ? `the previous owner (process ${previous.pid}) is dead — loop taken over`
        : `the previous owner's heartbeat (process ${previous.pid}) went stale — loop taken over`,
  };
}

// Heartbeat update. Returns false if the lock is no longer ours (somebody took it over).
export function refreshLock({ projectDir = process.cwd(), pid = process.pid, now = Date.now() } = {}) {
  const lock = readLock(projectDir);
  if (!lock || Number(lock.pid) !== Number(pid)) return false;
  lock.heartbeatAt = new Date(now).toISOString();
  writeFileSync(lockPath(projectDir), JSON.stringify(lock, null, 2), 'utf8');
  return true;
}

// Release the lock. We only remove OUR OWN — touching someone else's would break take-over.
export function releaseLock({ projectDir = process.cwd(), pid = process.pid } = {}) {
  const lock = readLock(projectDir);
  if (!lock || Number(lock.pid) !== Number(pid)) return false;
  try { unlinkSync(lockPath(projectDir)); return true; } catch { return false; }
}
