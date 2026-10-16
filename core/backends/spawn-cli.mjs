// core/backends/spawn-cli.mjs — cross-platform launcher for external CLIs (claude/opencode).
//
// WHY THIS MODULE EXISTS (v0.9.2, found by a live end-to-end run): on Windows, global npm CLIs are
// .cmd shims. Node refuses to launch .cmd/.bat directly. The old shell:true workaround corrupted
// quotes and expanded percent references, and a quoted argument executed an extra command in the
// 1.29.0 audit. Resolve standard npm shims to Node or a native executable instead; no cmd source.
//
// WHY A PROCESS GROUP (v1.5.0, found live during v1.4.0): turns used to run synchronously
// (`spawnSync`). If the supervisor itself was killed from the outside — `pkill`, a dropped ssh
// session, a terminal restart — the child `opencode` process STAYED ALIVE. During a single work
// stage several such orphans accumulated: they competed over the same `docs/STATE.md` and tripled
// the machine load.
//
// The cure is not "kill by name" (that would also take down the user's unrelated processes) but
// keeping our own registry: every launch goes into ITS OWN process group, live children are
// registered, and when the parent finishes — including via a signal — the WHOLE group is killed.
// POSIX: `detached:true` plus `kill(-pid)` by group id.
// Windows: `taskkill /T /F /PID` — by process tree (POSIX-style groups do not exist there).
//
// TWO LINES OF DEFENCE, AND HERE IS WHY. A live check revealed a fundamental limitation: when the
// parent is killed HARD (`kill -9`, `taskkill /F`), exit handlers do not run AT ALL — on any
// system. Cleaning up from inside a dying process is physically impossible in that case. Hence:
//   line 1 — signals and normal exit: kill the group immediately (SIGINT/SIGTERM/SIGHUP, exit);
//   line 2 — AN ON-DISK REGISTRY: live child ids are written to a file, and the next launch (as
//            well as a loop take-over) finishes off whatever the killed predecessor left behind.
// This way orphans live at most until the next start and DO NOT ACCUMULATE — and accumulation was
// the real problem back in v1.4.0.
//
// DRY: a single launch point for all adapters (claude.mjs, opencode.mjs) and the only place where
// cleanup lives. Every consumer gets it automatically, with nothing to configure.

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveCliLaunch } from './cli-launch.mjs';

// Node truncates an overflowing setTimeout to 1 ms. Keep the deadline on the clock and
// schedule representable portions; the owner's 9999-hour setting must remain 9999 hours.
function scheduleDeadline(delayMs, callback) {
  const deadline = Date.now() + delayMs;
  let timer, cancelled = false;
  const schedule = () => {
    if (cancelled) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) { callback(); return; }
    timer = setTimeout(schedule, Math.min(remaining, 2147483647));
  };
  schedule();
  return () => { cancelled = true; clearTimeout(timer); };
}

// --- Tracking live children -----------------------------------------------------------------
//
// v1.15.0 — A PROCESS NUMBER IS NOT AN IDENTITY, and this module was betting a force-kill on it.
//
// The header above is explicit that killing by NAME was rejected because it "would also take down
// the user's unrelated processes". The registry that replaced it could do the same thing by a
// different route: the operating system hands a process number out again once the process is gone,
// and `sweepStaleChildren` took every number out of a file written by an EARLIER run — minutes or
// hours old, which is exactly when reuse has had time to happen — and passed each one to
// `taskkill /T /F`. Nothing checked that the number still belonged to us. A stranger's whole
// process tree could be destroyed by a routine cleanup.
//
// This is the same defect the loop lock was rewritten for in v1.14.0 ("liveness must be proved by
// something that lives as long as the thing it represents"), and the same one `core/long-jobs.mjs`
// closed for job status. Here the consequence is not a wrong status line: it is a killed process
// somebody was using.
//
// THE FIX. A persisted child carries its creation identity, which must still match before killing
// a stale PID. Unknown identity refuses orphan cleanup. A current Windows launch is different:
// its own live child handle proves ownership until exit; neither pipes nor registry PIDs do.

const live = new Map();           // pid → exact launch record { identity, groupToken? }
// The handle belongs only to the current launch and is never persisted in the registry.
const currentHandles = new WeakMap();
let cleanupInstalled = false;
let registryFile = null;          // path to the on-disk registry (line of defence 2)

// ASKING THE SYSTEM ONCE INSTEAD OF ONCE PER PROCESS, and why that is not premature optimisation.
//
// The first implementation asked `wmic` about one process number at a time. Measured on the machine
// this was written on: 3569 ms for the first call, 2154 ms for the second. Registering a child and
// later verifying it are two calls, so every engine turn paid five seconds for bookkeeping, and the
// test suite — which starts many children in a row — stopped finishing at all.
//
// One snapshot of the whole process table costs the same as one lookup, so it is taken once and
// reused for a couple of seconds. The window is deliberately short: it is far longer than a burst of
// registrations and far shorter than the hours of staleness that make a recycled number dangerous.
// Signal delivery always asks afresh: even this short cache can retain an exited PID's old owner.
const TABLE_CACHE_MS = 2000;
let processTableCache = { at: 0, table: null };

export function readWindowsProcesses({ inspect = spawnSync, env = process.env } = {}) {
  const powershell = win32.join(env?.SystemRoot || env?.WINDIR || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Keep the date format compatible with previously recorded WMIC identities.
  const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | ForEach-Object { "
    + "[string]$_.ProcessId + ',' + [Management.ManagementDateTimeConverter]::ToDmtfDateTime($_.CreationDate)"
    + " + ',' + [string]$_.ParentProcessId }";
  try {
    const result = inspect(powershell, ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (result.status === 0 && !result.error) {
      const table = new Map();
      for (const line of String(result.stdout || '').split('\n')) {
        const [id, identity, parent] = line.trim().split(',');
        const pid = Number(id), parentPid = Number(parent);
        if (Number.isInteger(pid) && pid > 0 && /^\d{14}\.\d{6}[+-]\d{3}$/.test(identity || '')
          && Number.isInteger(parentPid) && parentPid >= 0) table.set(pid, { identity, parentPid });
      }
      if (table.size) return table;
    }
  } catch { /* WMIC remains a fallback for older systems. */ }
  const table = new Map();
  try {
    const result = inspect('wmic', ['process', 'get', 'ProcessId,CreationDate,ParentProcessId', '/format:csv'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (result.status !== 0 || result.error) return table;
    for (const line of String(result.stdout || '').split('\n')) {
      const parts = line.trim().split(',');
      if (parts.length < 3) continue;
      const identity = parts[1]?.trim(), pid = Number(parts.at(-1)?.trim());
      const parentPid = parts.length >= 4 ? Number(parts.at(-2)?.trim()) : null;
      if (Number.isInteger(pid) && pid > 0 && /^\d{14}/.test(identity || '')) {
        table.set(pid, { identity, parentPid });
      }
    }
  } catch { /* No identity means no permission to kill a stale registry entry. */ }
  return table;
}

function inspectProcessAsync(command,args,{timeout=20000,signal}={}) {
  if(signal?.aborted)return Promise.resolve({status:null,error:{code:'ABORT_ERR'}});
  return new Promise(resolve=>{
    let output='',done=false;
    const child=spawn(command,args,{stdio:['ignore','pipe','ignore'],windowsHide:true});
    const finish=(status,error)=>{
      if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      resolve({status,stdout:output,...(error?{error}: {})});
    };
    const timer=setTimeout(()=>{child.kill();finish(null,{code:'ETIMEDOUT'});},timeout);
    const abort=()=>{if(!done){child.kill();finish(null,{code:'ABORT_ERR'});}};
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    child.stdout.on('data',chunk=>{
      if(output.length+chunk.length>1024*1024){child.kill();finish(null,{code:'ENOBUFS'});}
      else output+=chunk.toString('utf8');
    });
    child.once('error',error=>finish(null,error));
    child.once('close',code=>finish(code));
  });
}

// Reuse the synchronous query builder and parsers; only the transport is asynchronous.
export async function readWindowsProcessesAsync({inspect=inspectProcessAsync,env=process.env,signal}={}) {
  let requests=[];
  readWindowsProcesses({env,inspect:(...args)=>{requests=[...requests,args];return {status:1};}});
  let answers=[];
  for(const request of requests) {
    if(signal?.aborted)break;
    let answer;
    try {answer=await inspect(request[0],request[1],{...request[2],signal});}
    catch(error) {answer={status:null,error};}
    answers=[...answers,answer];let at=0;
    const table=readWindowsProcesses({env,inspect:()=>answers[at++]||{status:1}});
    if(table.size)return table;
  }
  return new Map();
}

let pendingWindowsTable=null,windowsTableController=null,activeWindowsCaptures=0;
export function processIdentityAsync(pid) {
  if(!Number.isInteger(pid)||pid<=0)return Promise.resolve(null);
  const cached=processTableCache.table?.get(pid)?.identity;
  if(cached&&Date.now()-processTableCache.at<TABLE_CACHE_MS)return Promise.resolve(cached);
  if(!pendingWindowsTable||windowsTableController?.signal.aborted) {
    const controller=new AbortController();windowsTableController=controller;
    const pending=readWindowsProcessesAsync({signal:controller.signal}).then(table=>{
      if(!controller.signal.aborted)processTableCache={at:Date.now(),table};
      return table;
    }).finally(()=>{
      if(pendingWindowsTable===pending){pendingWindowsTable=null;windowsTableController=null;}
    });
    pendingWindowsTable=pending;
  }
  return pendingWindowsTable.then(table=>table.get(pid)?.identity||null);
}

function processTable({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && processTableCache.table && (now - processTableCache.at) < TABLE_CACHE_MS) {
    return processTableCache.table;
  }
  const table = readWindowsProcesses();
  processTableCache = { at: now, table };
  return table;
}

// When a process was created, as a string. Null means "cannot be established" — a process that is
// gone, or a system that will not tell us. Never throws: cleanup must not be able to crash a turn.
//
// If CIM and the WMIC fallback are unavailable, stale entries cannot authorize a kill.
// A current live Windows child is proved separately by its own handle.
export function processIdentity(pid, { fresh = false } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const cached = processTable({ fresh }).get(pid)?.identity;
      if (cached) return cached;
      // A MISS MEANS TWO DIFFERENT THINGS, and only one of them is "gone". The other is that our
      // snapshot was taken before this process started — which is exactly what happens at
      // registration, a few milliseconds after a spawn. Caught by the test that kills a running
      // child: the child was registered with a null identity from a stale snapshot, and a null
      // identity means "never kill", so cleanup silently stopped working. Refusing to kill is the
      // safe error only when the process really is not ours; here it was ours and we could not
      // prove it. So a miss is always worth one fresh look.
      return fresh ? null : processTable({ fresh: true }).get(pid)?.identity || null;
    }
    // Linux ticks restart at boot; a registry can survive a reboot and meet an unrelated PID
    // with identical ticks. Bind the identity to the boot UUID. Missing evidence refuses rather
    // than falling back to a weaker wall-clock birth. The comm field can contain spaces/brackets.
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const ticks = tail[19];                        // field 22 overall, 20th after the comm field
      if (!/^\d+$/.test(ticks || '')
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bootId)) return null;
      return `linux:${bootId}:${ticks}`;
    }
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 10000 });
    const s = String(r.stdout || '').trim();
    return s || null;
  } catch { return null; }
}

// Is this still the process we recorded? Unknown counts as NO: refusing to kill is the safe error.
export function stillOurs(pid, identity, { fresh = false } = {}) {
  if (!identity) return false;
  const now = processIdentity(pid, { fresh });
  return Boolean(now) && now === identity;
}

// Where to write live child ids so the next launch can finish off orphans after the parent was
// killed hard. The supervisor sets it once; without it only line 1 is active.
export function setChildRegistryFile(path) { registryFile = path || null; }

function writeRegistry() {
  if (!registryFile) return;
  try {
    mkdirSync(dirname(registryFile), { recursive: true });
    if (live.size === 0) { if (existsSync(registryFile)) unlinkSync(registryFile); return; }
    // `children` carries the identity; `pids` stays for a reader from an older version, which will
    // simply find no identities and — by the rule above — refuse to kill anything it cannot verify.
    const children = Array.from(live, ([pid, record]) => ({ pid, ...record }));
    writeFileSync(registryFile, JSON.stringify({
      children, pids: children.map((c) => c.pid), at: new Date().toISOString(),
    }), 'utf8');
  } catch { /* the registry is a backstop; its failure must not break a turn */ }
}

/**
 * Finish off processes left over from a previous (hard-killed) run.
 * Returns how many were killed. Called at loop start and on take-over.
 */
// These are the most dangerous kills in the framework: the numbers come from a file written by an
// EARLIER run, which is precisely how long a number needs to be stale before the system hands it to
// somebody else. Every one of them is therefore checked against the identity recorded beside it, and
// an entry that cannot be verified is left alone and reported.
export function sweepStaleChildren(path = registryFile) {
  if (!path || !existsSync(path)) return 0;
  let entries = [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    entries = Array.isArray(data.children)
      ? data.children
      // A registry written before v1.15.0 carries no identities. Such an entry is unverifiable, so
      // it is skipped rather than killed: one leaked orphan is cheaper than one stranger's process.
      : (data.pids || []).map((pid) => ({ pid, identity: null }));
  } catch { entries = []; }
  let killed = 0;
  for (const { pid, identity, groupToken } of entries) {
    if (live.has(pid)) continue;            // one of our own current children — leave it alone
    if (killTree(pid, { identity, groupToken })) killed++;
  }
  try { unlinkSync(path); } catch { /* already gone — fine */ }
  return killed;
}

// Kill one child together with all of its descendants.
//
// killTree accepts records without a live handle: a saved identity is mandatory.
// Open pipes after exit do not prove that the PID still belongs to our process.
// A missing group leader no longer proves that its group is gone. Each new POSIX launch passes
// a random marker to descendants. Verify one survivor's group AND exact inherited marker before
// using a leaderless pgid. Never log or persist any process environment, only the marker itself.
export function ownsSurvivingGroup(pgid, token, { platform = process.platform,
  read = readFileSync, inspect = spawnSync } = {}) {
  if (typeof token !== 'string' || !/^[0-9a-f-]{36}$/.test(token)) return false;
  try {
    const table = inspect('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8', timeout: 10000 });
    if (table.status !== 0) return false;
    for (const line of String(table.stdout || '').split('\n')) {
      const [pid, group] = line.trim().split(/\s+/).map(Number);
      if (!Number.isInteger(pid) || pid <= 0 || group !== pgid) continue;
      const marker = `ZERO_CODE_CHILD_GROUP=${token}`;
      if (platform === 'linux') {
        try {
          const fields = () => {
            const stat = read(`/proc/${pid}/stat`, 'utf8');
            return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          };
          const before = fields();
          if (Number(before[2]) !== pgid) continue;
          const matches = read(`/proc/${pid}/environ`, 'utf8').split('\0').includes(marker);
          const after = fields();
          if (matches && after[19] === before[19] && Number(after[2]) === pgid) return true;
        } catch { /* exited, changed or unreadable — never guess */ }
      } else if (platform === 'darwin') {
        const result = inspect('ps', ['-Eww', '-p', String(pid), '-o', 'pgid=,command='],
          { encoding: 'utf8', timeout: 10000 });
        const row = String(result.stdout || '').trim();
        if (result.status === 0 && Number(row.split(/\s+/)[0]) === pgid
          && row.split(/\s+/).includes(marker)) return true;
      }
    }
  } catch { /* absent ps/procfs or permission denied — refuse */ }
  return false;
}

export function killTree(pid, { identity = null, groupToken, signal = 'SIGKILL' } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!stillOurs(pid, identity, { fresh: true })) {
    // A recycled live leader is an unconditional refusal. A survivor can prove ownership only
    // when the original leader is absent, and old records without a marker retain the old guard.
    if (!identity || process.platform === 'win32' || processIdentity(pid)
      || !ownsSurvivingGroup(pid, groupToken)) return false;
  }
  return terminateTree(pid, signal);
}

function terminateTree(pid, signal = 'SIGKILL') {
  try {
    if (process.platform === 'win32') {
      // /T — together with the descendant tree, /F — forcefully.
      const result = spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)],
        { stdio: 'ignore', timeout: 20000 });
      if (result.status !== 0) return false;
    } else {
      process.kill(-pid, signal);   // the minus sign means the whole process group
    }
    return true;
  } catch { return false; }
}

function stopCurrent(pid, record) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const handle = currentHandles.get(record);
  if (process.platform === 'win32' && live.get(pid) === record && handle
    && handle.child.pid === pid && !handle.exited
    && handle.child.exitCode == null && handle.child.signalCode == null) {
    return terminateTree(pid);
  }
  return killTree(pid, record);
}

// Current handles and stale entries require different ownership evidence.
export function killAllChildren() {
  let killed = 0;
  for (const [pid, record] of Array.from(live)) {
    if (stopCurrent(pid, record)) killed++;
    live.delete(pid);
  }
  writeRegistry();
  return killed;
}

export function liveChildCount() { return live.size; }

// Descendants of a process on Windows. WHY (found by a live check): on Windows our DIRECT child is
// `cmd.exe` (needed for .cmd shims) while the engine itself runs in the GRANDCHILD. While the
// intermediary is alive, `taskkill /T` takes down the whole tree; but if the parent was killed
// hard and the intermediary died too, the grandchild is orphaned and we no longer hold a reference
// to it. So shortly after launch we record the descendants separately — otherwise line of defence
// 2 would fail exactly where it is needed most.
// POSIX uses a launch marker to verify a surviving group when its leader is already dead.
export function descendantsOf(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid)) return [];
  return Array.from(processTable({ fresh: true }), ([id, entry]) => ({ id, ...entry }))
    .filter(entry => entry.parentPid === pid && entry.id !== pid).map(entry => entry.id);
}

// Cleanup is installed once and covers every exit path: normal and signal-driven alike.
function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on('exit', () => { killAllChildren(); });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(signal, () => {
        killAllChildren();
        process.exit(130);
      });
    } catch { /* not every signal exists on every system */ }
  }
}

// --- Launching --------------------------------------------------------------------------------

/**
 * Asynchronous launch of an external CLI in ITS OWN process group.
 * Returns the same result shape as the previous synchronous launcher:
 *   { status, stdout, stderr, timedOut, cleanupRefused? }
 * — so calling adapters do not need rewriting (contract preserved).
 */
export function runCliAsync(bin, args, opts = {}) {
  const {
    timeoutMs,                 // overall cap (a backstop against truly insane hangs)
    idleTimeoutMs,             // SILENCE cap — see the explanation below
    onChunk,                   // (chunk) => 'abort' | undefined — abort the turn on the fly
    shell: _legacyShell,       // accepted for callers from older versions; never turns argv into code
    input, encoding = 'utf8', maxBuffer = 64 * 1024 * 1024, ...rest
  } = opts;
  let launch;
  try { launch = resolveCliLaunch(bin, args, rest); }
  catch (error) { return Promise.resolve({ status: null, stdout: '', stderr: error.message, timedOut: false }); }
  installCleanup();

  return new Promise((resolve) => {
    // IMPORTANT (verified by experiment): `detached:true` on Windows BREAKS output capture — the
    // process gets its own console and stdout never reaches us (measured: status 0, empty output).
    // Detaching is not needed there anyway: `taskkill /T` takes down the whole descendant tree by
    // id. On POSIX detaching is mandatory — it creates the group we later kill via kill(-pid).
    const win = process.platform === 'win32';
    const groupToken = win ? undefined : randomUUID();
    const launchOptions = win ? rest : { ...rest,
      env: { ...(rest.env || process.env), ZERO_CODE_CHILD_GROUP: groupToken } };
    const child = spawn(launch.command, launch.args, { ...launchOptions,
      shell: false, windowsVerbatimArguments: false, detached: !win, windowsHide: true });

    const handle = { child, exited: false };
    child.once('exit', () => { handle.exited = true; });
    const birth = child.pid ? (win?processIdentityAsync(child.pid):processIdentity(child.pid)) : null;
    let record = { identity: typeof birth==='string'?birth:null,
      ...(groupToken ? { groupToken } : {}) };
    currentHandles.set(record, handle);
    if(win)activeWindowsCaptures++;
    if(win&&birth&&typeof birth!=='string')Promise.resolve(birth).then(identity=>{
      // Bind delayed PID metadata only while the original OS child handle is still alive.
      // A recycled PID after a fast exit must never acquire the new process's birth identity.
      // Never signal a handle to probe it: kill(0) terminates Windows children on Node 22.15.0.
      if(identity&&!handle.exited&&child.exitCode==null&&child.signalCode==null
        &&live.get(child.pid)===record&&currentHandles.get(record)===handle) {
        record={...record,identity};currentHandles.set(record,handle);live.set(child.pid,record);writeRegistry();
      }
    }).catch(()=>{}); // Unknown birth evidence never authorizes stale cleanup.
    if (child.pid) {
      live.set(child.pid, record);
      writeRegistry();
      // A moment later the intermediary has spawned the engine itself — record that one too.
      if (process.platform === 'win32') {
        const followUp = setTimeout(() => {
          if (live.get(child.pid) !== record
            || !stillOurs(child.pid, record.identity, { fresh: true })) return;
          for (const grandchild of descendantsOf(child.pid)) {
            live.set(grandchild, { identity: processIdentity(grandchild) });
          }
          writeRegistry();
        }, 1500);
        followUp.unref?.();
      }
    }

    let out = '', err = '', truncated = false, timedOut = false, finished = false, aborted = null;
    let stopping = false, cleanupRefused = false;
    const collect = (buffer, chunk) => {
      if (buffer.length + chunk.length > maxBuffer) { truncated = true; return buffer; }
      return buffer + chunk;
    };
    child.stdout?.setEncoding(encoding);
    child.stderr?.setEncoding(encoding);
    child.stdout?.on('data', (d) => {
      if (finished) return;
      out = collect(out, d);
      extend();
      // Watching the turn ON THE FLY. This is what lets the spending guard act INSIDE a turn
      // rather than only between turns: a turn can run for half an hour, and during all that time
      // the cap used to be powerless (the limitation was named in the v1.5.0 report and is closed
      // here).
      if (onChunk) {
        try {
          if (onChunk(d) === 'abort') { aborted = 'abort'; stop(); }
        } catch { /* an observer must never be able to break a turn */ }
      }
    });
    child.stderr?.on('data', (d) => { if (!finished) { err = collect(err, d); extend(); } });

    // WHY A SILENCE CAP RATHER THAN A TOTAL-DURATION CAP (v1.5.0, found by the final gate).
    // The very first turn on a REAL task hit the 15-minute total cap — while the agent was working
    // honestly and had already produced two commits. We were killing useful work and starting over.
    // The design error: the cap was meant to catch a HANG but measured DURATION. What distinguishes
    // a hung process from a working one is not how long it lives but the fact that it is SILENT.
    // So we count time since the last byte of output and keep the total cap only as a far backstop.
    let silenceTimer = null;
    const extend = () => {
      if (!idleTimeoutMs) return;
      silenceTimer?.();
      silenceTimer = scheduleDeadline(idleTimeoutMs, () => {
        timedOut = true;
        stop();
      });
    };
    extend();

    const timer = timeoutMs ? scheduleDeadline(timeoutMs, () => {
      timedOut = true;
      stop();
    }) : null;

    const finalize = (status) => {
      if (finished) return;
      finished = true;
      if(win&&--activeWindowsCaptures===0)windowsTableController?.abort();
      timer?.();
      silenceTimer?.();
      if (child.pid && live.get(child.pid) === record) {
        // A failed leader may have survivors with redirected pipes, so close does not prove the
        // group is gone. Clean a verified POSIX group before dropping its record. Successful turns
        // may intentionally leave background jobs; an already-cleared record never permits a kill.
        if (!stopping && status !== 0 && record.groupToken) {
          killTree(child.pid, record);
        }
        live.delete(child.pid);
        // Drop dead Windows descendants. Another pending POSIX turn owns its record until its
        // own close handler runs: a dead leader may still have a live group holding the pipes.
        for (const [pid, tracked] of Array.from(live)) {
          if (!tracked.groupToken && !currentHandles.has(tracked)
            && !stillOurs(pid, tracked.identity)) live.delete(pid);
        }
        writeRegistry();
      }
      resolve({
        status, stdout: out, stderr: err, timedOut, pid: child.pid,
        ...(aborted ? { aborted: true } : {}),
        ...(truncated ? { truncated: true } : {}),
        ...(cleanupRefused ? { cleanupRefused: true } : {}),
      });
    };

    // Open pipes may outlive the leader. Stop only our recorded launch;
    // refusing an unverified kill must still end this capture, not wait for somebody else's pipe.
    const stop = () => {
      if (finished) return;
      stopping = true;
      if (live.get(child.pid) !== record || !stopCurrent(child.pid, record)) {
        cleanupRefused = true;
        err += '\nChild cleanup refused: ownership could not be proved or termination failed';
      }
      finalize(null);
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy?.();
      child.unref?.();
    };

    child.on('error', (e) => { if (!finished) { err += String(e.message || e); finalize(null); } });
    child.on('close', (code, signal) => finalize(code === null && signal ? null : code));

    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* a closed stdin is not our problem */ });
      if (typeof input === 'function') {
        // Trusted host-side protocols may need a handshake before sending the next message.
        // Model turns still pass a string and close stdin immediately.
        try { input({ write: value => child.stdin.write(value), end: () => child.stdin.end() }); }
        catch { err += '\nCLI input handler failed'; stop(); }
      } else child.stdin.end(input);
    } else {
      child.stdin?.end();
    }
  });
}

/**
 * The previous SYNCHRONOUS launcher. Kept for short service calls (for example
 * `claude mcp add-json`), where there is no long wait and no orphans appear.
 * Agent turns use `runCliAsync` — only that one provides a process group.
 */
export function runCli(bin, args, opts = {}) {
  const { timeoutMs, shell: _legacyShell, ...rest } = opts;
  const withTimeout = timeoutMs ? { ...rest, timeout: timeoutMs, killSignal: 'SIGKILL' } : rest;
  let launch;
  try { launch = resolveCliLaunch(bin, args, rest); }
  catch (error) { return { status: null, stdout: '', stderr: error.message, error }; }
  const res = spawnSync(launch.command, launch.args, { ...withTimeout,
    shell: false, windowsVerbatimArguments: false, windowsHide: true });
  if (timeoutMs && res && (res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGKILL')) {
    res.timedOut = true;
  }
  return res;
}
