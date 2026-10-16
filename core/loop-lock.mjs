// core/loop-lock.mjs — the autonomous loop lock (v1.5.0, liveness evidence added in v1.14.0).
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
// v1.14.0 — WHAT COUNTS AS EVIDENCE OF LIFE, and why the answer used to be wrong.
//
// Until now liveness meant one thing: `process.kill(pid, 0)` against the number stored in the lock.
// That is exact for the supervisor, whose process runs for the whole loop. It is meaningless for
// the Claude Code Stop hook, which is a program that lives for MILLISECONDS at the end of a turn —
// and the hook stored its own number. Measured on a lock written a moment earlier:
//
//     the lock was written by session A, heartbeat age 0 seconds
//       ownerState -> dead
//
// So the hook's own `isOurs` branch was unreachable, and a second, third, fourth Claude Code
// session in one project took the loop away from the previous one on every turn. No time-to-live
// could have helped: liveness is judged BEFORE staleness, so the deadline was never consulted.
//
// The fix is not a longer deadline but a better witness. Evidence is now an explicit part of the
// lock, and every kind of evidence answers the same question in the way its own physics allows:
//
//     { kind: 'process',   id: <pid>  }  the kernel is asked whether the process exists
//     { kind: 'file',      id: <path> }  the file's modification time tops up the heartbeat
//     { kind: 'heartbeat', id: <name> }  nothing external — the heartbeat speaks alone
//
// The Stop hook registers the SESSION TRANSCRIPT (`transcript_path`, delivered in the hook payload)
// as its evidence, because that file lives exactly as long as the session does — measured on a live
// session: 10.1 MB, last written 0.3 seconds ago, while the hook's own process was long gone.
//
// The obvious alternative was tried and MEASURED, not reasoned about: the hook's parent process. If
// the parent were the long-lived Claude Code process, that would be exact, kernel-checkable evidence
// that dies the instant the session does — strictly better than a file. A real Stop hook was made to
// record its parent, and on the next turn the parent was dead too (`ppid 21200 — alive: false`): the
// hook is launched through a shell wrapper that exits with it. So the file stands, and the idea is
// written down here rather than left to be re-derived and re-tried by the next reader.
//
// Deliberately NOT done: no `if (engine === 'stop-hook')`. Branching on a driver's NAME instead of
// on what it can actually prove is how one special case becomes three. A lock written before
// v1.14.0 carries no evidence field and is read as `{ kind: 'process', id: lock.pid }`, so old
// projects keep behaving exactly as they did.
//
// IDENTITY comes from the same field. Two invocations belong to the same owner when their evidence
// matches — which is what lets a session refresh its own lock across turns even though every hook
// process has a different number.
//
// Every function takes time, host name and the liveness checks as parameters — so behaviour can be
// tested without race conditions and without real processes.

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, statSync,
  readdirSync, renameSync, rmdirSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { DOCUMENT_DEFAULTS, loadProjectConfig } from './project-config.mjs';
import { replaceFileSync, retryWindowsFileOperation } from '../lib/replace-file.mjs';

export const LOCK_FILE = join(dirname(DOCUMENT_DEFAULTS.state.path), '.loop.lock');
export const LOCK_BUSY = 'busy';

// How long the lock is considered alive without a heartbeat update.
//
// v1.15.0 — A CORRECTION, because the justification that stood here was arithmetic on a number that
// was not the number. It read: "an agent turn is capped at 15 minutes (OPENCODE_TURN_TIMEOUT_MS),
// so 30 minutes gives a twofold margin". The constant is FOUR HOURS. Measured:
//
//     lock deadline 30 min | turn cap 240 min | the turn is 8x the deadline, not half of it
//
// So the margin ran the other way, and an ordinary long turn could have its lock taken from
// underneath a working process — the exact corruption the lock exists to prevent. The claim was
// carried forward unchecked in v1.14.0 while this file was being rewritten, which is how a false
// comment survives a rewrite: it reads like a conclusion somebody already verified.
//
// The deadline is no longer asked to outlast a turn, because a turn now proves it is alive WHILE it
// runs: the supervisor beats the heartbeat every minute (`heartbeatMs`), and the Stop hook's
// evidence is a transcript written on every message. Half an hour of true silence is what it now
// means — and that also gives "the process is alive but its heartbeat is old" its meaning back: it
// really does mean hung.
//
// Why not shorter. Taking the loop from a working owner produces two writers on one state; making a
// new owner wait costs half an hour and is named, with the immediate way out, in the refusal text.
// The asymmetry decides it.
export const LOCK_TTL_MS = 30 * 60 * 1000;

export const PROCESS_EVIDENCE = 'process';
export const FILE_EVIDENCE = 'file';
export const HEARTBEAT_EVIDENCE = 'heartbeat';

export function lockPath(projectDir = process.cwd()) {
  return loadProjectConfig({ projectDir }).runtimePath('.loop.lock');
}

export function readLock(projectDir = process.cwd()) {
  const p = lockPath(projectDir);
  let text;
  try {text=retryWindowsFileOperation(()=>readFileSync(p,'utf8'));}
  catch(error) {if(error.code==='ENOENT')return null;throw error;}
  // A denied read is not evidence of absence. Only malformed JSON retains the legacy recovery.
  try {return JSON.parse(text);} catch(error) {if(error instanceof SyntaxError)return null;throw error;}
}

// Is a process with this id alive on THIS machine?
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }   // EPERM — the process exists but is not ours
}

// When was this file last written? Null for a file that is missing or unreadable — never an
// exception: a witness that can crash the loop it observes is not a witness.
export function fileTouchedAt(path) {
  if (!path) return null;
  try { return statSync(path).mtimeMs; } catch { return null; }
}

// The evidence a lock carries, in normal form. A lock written before v1.14.0 has no such field, and
// its process number is exactly what it used to be judged by.
export function evidenceOf(lock) {
  const ev = lock && lock.liveness;
  if (ev && typeof ev === 'object' && ev.kind && ev.id !== undefined && ev.id !== null) {
    return { kind: String(ev.kind), id: String(ev.id) };
  }
  return { kind: PROCESS_EVIDENCE, id: String((lock && lock.pid) ?? '') };
}

// Do these two pieces of evidence name the same owner?
export function sameOwner(a, b) {
  if (!a || !b) return false;
  return a.kind === b.kind && String(a.id) === String(b.id);
}

// The evidence for a claim being made now. Callers pass `liveness` when they know what proves them
// alive; a caller that says nothing is a long-running process and is proved by its own number.
function claimEvidence({ liveness, pid }) {
  if (liveness && typeof liveness === 'object' && liveness.kind) {
    return { kind: String(liveness.kind), id: String(liveness.id ?? '') };
  }
  return { kind: PROCESS_EVIDENCE, id: String(pid) };
}

// State of the lock owner: 'free' | 'alive' | 'dead' | 'stale' | 'foreign-unknown'.
// Pure function: everything external arrives as a parameter.
export function ownerState(lock, {
  now = Date.now(), host = hostname(), ttlMs = LOCK_TTL_MS,
  pidAlive = isPidAlive, touchedAt = fileTouchedAt,
  // Older callers and tests name the file probe `fileTouchedAt`; both spellings are accepted so
  // that one module never has two names for the same idea in the same call.
  fileTouchedAt: touchedAtAlias = null,
} = {}) {
  if (!lock || typeof lock !== 'object') return 'free';
  const probeFile = touchedAtAlias || touchedAt;

  // The timestamp in the lock is an ISO string, so we parse it with Date.parse rather than Number:
  // Number("2026-…") yields NaN, which would make a live lock look stale (caught by a test during
  // development).
  const heartbeat = Date.parse(lock.heartbeatAt || lock.startedAt || '');
  const evidence = evidenceOf(lock);

  if (lock.host && lock.host !== host) {
    // Another machine: neither its processes nor its file paths mean anything here, so we trust the
    // heartbeat alone.
    return isStale(heartbeat, now, ttlMs) ? 'stale' : 'foreign-unknown';
  }

  if (evidence.kind === PROCESS_EVIDENCE) {
    // Exact evidence: the kernel answers. A process that is gone is gone, whatever the clock says.
    if (!pidAlive(Number(evidence.id))) return 'dead';
    return isStale(heartbeat, now, ttlMs) ? 'stale' : 'alive';
  }

  // Inferred evidence. There is no way to prove the owner is GONE — only that it has said nothing
  // for too long — so these kinds never answer 'dead'. Saying 'dead' on a guess would take the loop
  // away from a session that is merely thinking.
  let beat = heartbeat;
  if (evidence.kind === FILE_EVIDENCE) {
    const touched = probeFile(evidence.id);
    if (Number.isFinite(touched)) beat = Math.max(Number.isFinite(beat) ? beat : 0, touched);
  }
  return isStale(beat, now, ttlMs) ? 'stale' : 'alive';
}

function isStale(beat, now, ttlMs) {
  return !Number.isFinite(beat) || (now - beat) > ttlMs;
}

// How the refusal names the owner: whatever identifies it best to a human reading the log.
function describeOwner(lock) {
  const parts = [];
  if (lock.sessionId) parts.push(`session ${lock.sessionId}`);
  parts.push(`process ${lock.pid}`);
  if (lock.engine) parts.push(lock.engine);
  return parts.join(', ');
}

// All ownership changes share one filesystem mutex. Its staging directory already contains
// the complete owner marker before publication: rename cannot replace a nonempty directory on
// either POSIX or Windows. An empty mutex never names a live critical section.
//
// Reclamation only removes the observed UNIQUE marker of a dead local process. If somebody
// already removed it, we must not remove the directory: it may now belong to another process.
// rmdir refuses a newly published nonempty mutex even after the old marker was removed.
function removeMutationMarker(directory, marker) {
  try { unlinkSync(join(directory, marker)); }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  try { rmdirSync(directory); }
  catch (e) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e; }
  return true;
}

function reclaimMutation(directory) {
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const entries = readdirSync(directory);
    // Empty remnants are safe: published live mutexes always carry their marker.
    if (entries.length === 0) { rmdirSync(directory); return true; }
    if (entries.length !== 1 || !/^owner-[0-9a-f-]+\.json$/.test(entries[0])) return false;
    const file = join(directory, entries[0]), member = lstatSync(file);
    if (!member.isFile() || member.isSymbolicLink() || member.nlink !== 1) return false;
    const owner = JSON.parse(readFileSync(file, 'utf8'));
    if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1
        || isPidAlive(owner.pid)) return false;
    return removeMutationMarker(directory, entries[0]);
  } catch (e) {
    if (['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EPERM', 'EACCES'].includes(e.code)
        || e instanceof SyntaxError) return false;
    throw e;
  }
}

function enterMutation(projectDir) {
  const path = lockPath(projectDir), directory = path + '.guard';
  const staging = directory + '-' + randomUUID(), marker = 'owner-' + randomUUID() + '.json';
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(staging);
  try {
    writeFileSync(join(staging, marker), JSON.stringify({ pid: process.pid, host: hostname() }), { flag: 'wx' });
    // One bounded retry is enough after reclaiming a dead holder; contention never spins or sleeps.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        renameSync(staging, directory);
        return () => removeMutationMarker(directory, marker);
      } catch (e) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(e.code)) throw e;
        // The preceding holder may have left between rename's collision and this check.
        if (!existsSync(directory)) { if (attempt === 0) continue; return null; }
        if (attempt === 0 && reclaimMutation(directory)) continue;
        return null;
      }
    }
    return null;
  } finally {
    if (existsSync(staging)) removeMutationMarker(staging, marker);
  }
}

function writeLock(projectDir, lock) {
  const path = lockPath(projectDir), temporary = path + '.tmp-' + randomUUID();
  const before=existsSync(path)?readFileSync(path):null;
  try {
    writeFileSync(temporary, JSON.stringify(lock, null, 2), { encoding: 'utf8', flag: 'wx' });
    replaceFileSync(temporary,path,{validate(){
      if(lockPath(projectDir)!==path)throw new Error('Loop lock path changed during publication');
      const current=existsSync(path)?readFileSync(path):null;
      if(before===null?current!==null:current===null||!before.equals(current))throw new Error('Loop lock changed during publication');
    }});
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

// Attempt to take the lock.
// Returns { acquired, state, takenOver, previous, reason }.
export function acquireLock({
  projectDir = process.cwd(), pid = process.pid, host = hostname(), engine = 'supervisor',
  sessionId = null, liveness = null, now = Date.now(), ttlMs = LOCK_TTL_MS,
  pidAlive = isPidAlive, touchedAt = fileTouchedAt, fileTouchedAt: touchedAtAlias = null,
} = {}) {
  const leave = enterMutation(projectDir);
  // A busy claimant has no ownership decision to publish. Reading the JSON here would only
  // race the holder's publication, and on Windows an open reader can postpone replacement.
  if (!leave) return { acquired: false, state: 'busy', takenOver: false, previous: null,
    reason: 'the loop lock is being updated by another process; this invocation did not acquire it. Retry after that mutation finishes.' };
  try {
    const previous = readLock(projectDir);
    const state = ownerState(previous, {
      now, host, ttlMs, pidAlive, touchedAt: touchedAtAlias || touchedAt,
    });

    if (state === 'alive' || state === 'foreign-unknown') {
      const mine = claimEvidence({ liveness, pid });
      // Our own lock from a previous turn is not somebody else's: the same session must be able to go
      // on driving the loop it already owns.
      if (!sameOwner(evidenceOf(previous), mine)) {
        return {
          acquired: false, state, takenOver: false, previous,
          reason: state === 'alive'
            ? `the loop is already driven by ${describeOwner(previous)}, started ${previous.startedAt}. ` +
              `It will be released once that owner goes quiet, or immediately if you delete ${lockPath(projectDir)}.`
            : `the loop is held by host "${previous.host}" (${describeOwner(previous)}) with a fresh ` +
              'heartbeat — it cannot be verified from here.',
        };
      }
    }

    // Carrying on with a lock that is already ours keeps the moment we took it: "since when" is what
    // a human reads in the refusal handed to the next session, and restamping it every turn would
    // make a loop running since morning look like one that started a minute ago.
    const ours = previous && sameOwner(evidenceOf(previous), claimEvidence({ liveness, pid }));
    const lock = {
      pid, host, engine, sessionId,
      liveness: claimEvidence({ liveness, pid }),
      startedAt: ours && previous.startedAt ? previous.startedAt : new Date(now).toISOString(),
      heartbeatAt: new Date(now).toISOString(),
    };
    writeLock(projectDir, lock);

    return {
      acquired: true, state, takenOver: state === 'dead' || state === 'stale', previous,
      reason: state === 'free' ? 'the lock was free'
        : state === 'dead' ? `the previous owner (process ${previous.pid}) is dead — loop taken over`
          : state === 'stale' ? `the previous owner (${describeOwner(previous)}) went stale — loop taken over`
            : 'the loop was already ours — carrying on',
    };
  } finally { leave(); }
}

// Heartbeat update: true means ownership was checked and the heartbeat was written under the
// mutex; false means the serialized check found another owner; LOCK_BUSY makes no ownership
// claim. A pre-takeover snapshot cannot safely replace the actual serialized check.
//
// Ownership is decided by the evidence, not by the process number: a Stop hook is a different
// process on every turn, and judging by the number would mean a session could never keep its own
// lock alive.
export function refreshLock({
  projectDir = process.cwd(), pid = process.pid, liveness = null, now = Date.now(),
} = {}) {
  const leave = enterMutation(projectDir);
  if (!leave) return LOCK_BUSY;
  try {
    const lock = readLock(projectDir);
    if (!lock || !sameOwner(evidenceOf(lock), claimEvidence({ liveness, pid }))) return false;
    lock.heartbeatAt = new Date(now).toISOString();
    writeLock(projectDir, lock);
    return true;
  } finally { leave(); }
}

// Callers about to launch work or publish state require a definite serialized answer. A brief
// collision gets at most 20 checks and 19 scheduled 10 ms pauses; an unavailable mutex remains
// explicitly busy. Scheduling and filesystem latency are not claimed as a hard wall-clock cap.
// Heartbeat timers use the synchronous function and may simply try again on their next tick.
async function eventually(operation, options, {
  attempts = 20, delayMs = 10, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isFinite(delayMs) || delayMs < 0
      || typeof wait !== 'function') throw new Error('Invalid loop lock retry parameters');
  let result;
  for (let attempt = 0; attempt < attempts; attempt++) {
    result = operation(options);
    if (result !== LOCK_BUSY && result?.state !== LOCK_BUSY) return result;
    if (attempt + 1 < attempts) await wait(delayMs);
  }
  return result;
}

export function refreshLockEventually(options = {}, retry = {}) {
  return eventually(refreshLock, options, retry);
}

export function acquireLockEventually(options = {}, retry = {}) {
  return eventually(acquireLock, options, retry);
}

// Release the lock. We only remove OUR OWN — touching someone else's would break take-over.
function releaseLockAttempt({ projectDir = process.cwd(), pid = process.pid, liveness = null } = {}) {
  const leave = enterMutation(projectDir);
  if (!leave) return LOCK_BUSY;
  try {
    const lock = readLock(projectDir);
    if (!lock || !sameOwner(evidenceOf(lock), claimEvidence({ liveness, pid }))) return false;
    try { unlinkSync(lockPath(projectDir)); return true; }
    catch (e) { return ['EPERM', 'EACCES', 'EBUSY'].includes(e.code) ? LOCK_BUSY : false; }
  } finally { leave(); }
}

// Exit/signal handlers remain synchronous. Normal completion can wait for a brief
// filesystem collision, verifying ownership under the mutex on EVERY attempt.
export function releaseLock(options = {}) { return releaseLockAttempt(options) === true; }
export function releaseLockEventually(options = {}, retry = {}) {
  return eventually(releaseLockAttempt, options, retry);
}
