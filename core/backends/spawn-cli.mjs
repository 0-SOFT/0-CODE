// core/backends/spawn-cli.mjs — cross-platform launcher for external CLIs (claude/opencode).
//
// WHY THIS MODULE EXISTS (v0.9.2, found by a live end-to-end run): on Windows, global npm CLIs are
// .cmd shims. Since the CVE-2024-27980 fix, Node REFUSES to launch .cmd/.bat directly (bare name →
// ENOENT, name.cmd → EINVAL). The correct way is shell:true, but then arguments are joined into a
// command line without automatic quoting → a prompt containing spaces breaks. So on Windows we do
// the quoting ourselves.
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
import { dirname } from 'node:path';

// Quoting a single argument for cmd.exe: wrap in quotes when it contains spaces or metacharacters.
export function quoteWin(a) {
  const s = String(a);
  return /[\s"&|<>^%()]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
}

// --- Tracking live children -----------------------------------------------------------------

const live = new Set();           // ids of processes launched by this module
let cleanupInstalled = false;
let registryFile = null;          // path to the on-disk registry (line of defence 2)

// Where to write live child ids so the next launch can finish off orphans after the parent was
// killed hard. The supervisor sets it once; without it only line 1 is active.
export function setChildRegistryFile(path) { registryFile = path || null; }

function writeRegistry() {
  if (!registryFile) return;
  try {
    mkdirSync(dirname(registryFile), { recursive: true });
    if (live.size === 0) { if (existsSync(registryFile)) unlinkSync(registryFile); return; }
    writeFileSync(registryFile, JSON.stringify({ pids: Array.from(live), at: new Date().toISOString() }), 'utf8');
  } catch { /* the registry is a backstop; its failure must not break a turn */ }
}

/**
 * Finish off processes left over from a previous (hard-killed) run.
 * Returns how many were killed. Called at loop start and on take-over.
 */
export function sweepStaleChildren(path = registryFile) {
  if (!path || !existsSync(path)) return 0;
  let list = [];
  try { list = JSON.parse(readFileSync(path, 'utf8')).pids || []; } catch { list = []; }
  let killed = 0;
  for (const pid of list) {
    if (live.has(pid)) continue;            // one of our own current children — leave it alone
    if (killTree(pid)) killed++;
  }
  try { unlinkSync(path); } catch { /* already gone — fine */ }
  return killed;
}

// Kill one child together with all of its descendants.
export function killTree(pid, signal = 'SIGKILL') {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (process.platform === 'win32') {
      // /T — together with the descendant tree, /F — forcefully.
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      process.kill(-pid, signal);   // the minus sign means the whole process group
    }
    return true;
  } catch { return false; }
}

// Kill every live child. Returns how many were killed.
export function killAllChildren() {
  let killed = 0;
  for (const pid of Array.from(live)) {
    if (killTree(pid)) killed++;
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
// On POSIX this is unnecessary: `kill(-pgid)` takes down the whole group even if its leader is
// already dead.
export function descendantsOf(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid)) return [];
  try {
    const r = spawnSync('wmic',
      ['process', 'where', `ParentProcessId=${pid}`, 'get', 'ProcessId', '/format:csv'],
      { encoding: 'utf8', timeout: 10000 });
    // Parsing without regular expressions: split on newlines; trim removes the carriage return.
    return String(r.stdout || '').split('\n')
      .map((l) => Number(l.trim().split(',').pop()))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== pid);
  } catch { return []; }
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
 *   { status, stdout, stderr, timedOut }
 * — so calling adapters do not need rewriting (contract preserved).
 */
export function runCliAsync(bin, args, opts = {}) {
  const {
    timeoutMs,                 // overall cap (a backstop against truly insane hangs)
    idleTimeoutMs,             // SILENCE cap — see the explanation below
    onChunk,                   // (chunk) => 'abort' | undefined — abort the turn on the fly
    input, encoding = 'utf8', maxBuffer = 64 * 1024 * 1024, ...rest
  } = opts;
  installCleanup();

  return new Promise((resolve) => {
    // IMPORTANT (verified by experiment): `detached:true` on Windows BREAKS output capture — the
    // process gets its own console and stdout never reaches us (measured: status 0, empty output).
    // Detaching is not needed there anyway: `taskkill /T` takes down the whole descendant tree by
    // id. On POSIX detaching is mandatory — it creates the group we later kill via kill(-pid).
    const win = process.platform === 'win32';
    const child = win
      ? spawn([bin, ...args].map(quoteWin).join(' '), { ...rest, shell: true })
      : spawn(bin, args, { ...rest, detached: true });

    if (child.pid) {
      live.add(child.pid);
      writeRegistry();
      // A moment later the intermediary has spawned the engine itself — record that one too.
      if (process.platform === 'win32') {
        const followUp = setTimeout(() => {
          if (!live.has(child.pid)) return;             // the turn already finished
          for (const grandchild of descendantsOf(child.pid)) live.add(grandchild);
          writeRegistry();
        }, 1500);
        followUp.unref?.();
      }
    }

    let out = '', err = '', truncated = false, timedOut = false, finished = false, aborted = null;
    const collect = (buffer, chunk) => {
      if (buffer.length + chunk.length > maxBuffer) { truncated = true; return buffer; }
      return buffer + chunk;
    };
    child.stdout?.setEncoding(encoding);
    child.stderr?.setEncoding(encoding);
    child.stdout?.on('data', (d) => {
      out = collect(out, d);
      extend();
      // Watching the turn ON THE FLY. This is what lets the spending guard act INSIDE a turn
      // rather than only between turns: a turn can run for half an hour, and during all that time
      // the cap used to be powerless (the limitation was named in the v1.5.0 report and is closed
      // here).
      if (onChunk) {
        try {
          if (onChunk(d) === 'abort') { aborted = 'abort'; killTree(child.pid); }
        } catch { /* an observer must never be able to break a turn */ }
      }
    });
    child.stderr?.on('data', (d) => { err = collect(err, d); extend(); });

    // WHY A SILENCE CAP RATHER THAN A TOTAL-DURATION CAP (v1.5.0, found by the final gate).
    // The very first turn on a REAL task hit the 15-minute total cap — while the agent was working
    // honestly and had already produced two commits. We were killing useful work and starting over.
    // The design error: the cap was meant to catch a HANG but measured DURATION. What distinguishes
    // a hung process from a working one is not how long it lives but the fact that it is SILENT.
    // So we count time since the last byte of output and keep the total cap only as a far backstop.
    let silenceTimer = null;
    const extend = () => {
      if (!idleTimeoutMs) return;
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, idleTimeoutMs);
    };
    extend();

    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs) : null;

    const finalize = (status) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (silenceTimer) clearTimeout(silenceTimer);
      if (child.pid) {
        live.delete(child.pid);
        // Grandchildren of a finished turn are no longer ours: drop the dead ones from the registry.
        for (const pid of Array.from(live)) {
          try { process.kill(pid, 0); } catch { live.delete(pid); }
        }
        writeRegistry();
      }
      resolve({
        status, stdout: out, stderr: err, timedOut, pid: child.pid,
        ...(aborted ? { aborted: true } : {}),
        ...(truncated ? { truncated: true } : {}),
      });
    };

    child.on('error', (e) => { err += String(e.message || e); finalize(null); });
    child.on('close', (code, signal) => finalize(code === null && signal ? null : code));

    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* a closed stdin is not our problem */ });
      child.stdin.end(input);
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
  const { timeoutMs, ...rest } = opts;
  const withTimeout = timeoutMs ? { ...rest, timeout: timeoutMs, killSignal: 'SIGKILL' } : rest;
  const res = process.platform === 'win32'
    ? spawnSync([bin, ...args].map(quoteWin).join(' '), { ...withTimeout, shell: true })
    : spawnSync(bin, args, withTimeout);
  if (timeoutMs && res && (res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGKILL')) {
    res.timedOut = true;
  }
  return res;
}
