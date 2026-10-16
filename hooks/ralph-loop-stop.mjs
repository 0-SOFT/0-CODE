#!/usr/bin/env node
// ralph-loop-stop.mjs — the autonomous framework's Stop hook (Node.js implementation).
//
// Implements the Ralph Loop pattern: it reads docs/STATE.md and decides whether to continue the
// loop (decision:block) or let the session stop.
//
// Why Node rather than bash (v0.5.0): it removes the logic's dependency on `jq` and `bc` (absent
// on typical machines) and on line endings (CRLF) — a root fix for two cross-cutting problems.
// STATE is parsed directly through lib/yaml-mini.mjs.
//
// Stdin: the Claude Code Stop event as JSON (session_id, stop_hook_active, ...).
// Stdout: JSON {decision:"block", reason, systemMessage} OR nothing.
// Exit: always 0 (fail-open — the hook NEVER blocks Claude with an error).

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseYaml } from '../lib/yaml-mini.mjs';
import { decideContinuation } from '../core/gates.mjs';
import { acquireLockEventually, LOCK_BUSY } from '../core/loop-lock.mjs';
import { inspectStateJobs } from '../core/long-jobs.mjs';
import { captureSnapshot } from '../core/progress.mjs';
import { escalationDirective } from '../core/progress.mjs';
import {
  readMemory, writeMemory, stagnantAfterTurn, progressPolicy, noProgressBlocker,
} from '../core/turn-progress.mjs';
import { noticeAfterTurn } from '../core/secret-notice.mjs';
import { findProjectRoot, loadProjectConfig } from '../core/project-config.mjs';

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(HOOK_DIR, '..', 'lib');

function failOpen() { process.exit(0); }

// --- Reading stdin ---
let input = '';
try { input = readFileSync(0, 'utf8'); } catch { /* no stdin — acceptable */ }

let hook = {};
try { hook = JSON.parse(input || '{}'); } catch { hook = {}; }

const SESSION_ID = hook.session_id ? String(hook.session_id) : '';

// v0.5.7 — THE ROOT FIX FOR A CONTINUOUS LOOP.
// PREVIOUSLY there was an `if (stop_hook_active) failOpen()` here — and it cut the loop after ONE
// iteration per session: Claude sets stop_hook_active=true on EVERY stop that resulted from a
// previous decision:block, and keeps it true until the session ends. The gate duplicated the
// native CLAUDE_CODE_STOP_HOOK_BLOCK_CAP but was incomparably more aggressive (1 continuation
// instead of 1000) — contradicting the promise of "no manual restarts".
// We no longer stop on stop_hook_active. Runaway protection is two-tier:
//   1) the `iteration >= max_iterations` gate below (persisted in STATE, survives sessions);
//   2) the native CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=1000 (.claude/settings.json) — Claude Code
//      force-stops by itself after N consecutive blocks.

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || findProjectRoot();
let project;
try { project = loadProjectConfig({ projectDir: PROJECT_DIR }); }
catch (error) { process.stderr.write(`ralph-loop-stop: ${error.message} — allowing stop\n`); failOpen(); }
const STATE_FILE = project.documentPath('state');

// No STATE.md means this is not a framework project — allow the stop.
if (!existsSync(STATE_FILE)) failOpen();

let raw;
try { raw = readFileSync(STATE_FILE, 'utf8'); }
catch { process.stderr.write('ralph-loop-stop: cannot read STATE.md — allowing stop\n'); failOpen(); }

const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
if (!m) { process.stderr.write('ralph-loop-stop: no frontmatter — allowing stop\n'); failOpen(); }

let st;
try { st = parseYaml(m[1]); }
catch { process.stderr.write('ralph-loop-stop: parse error — allowing stop\n'); failOpen(); }
if (!st || typeof st !== 'object') failOpen();
const progressLimits = progressPolicy(st);
if (progressLimits.warning) process.stderr.write(`ralph-loop-stop: ${progressLimits.warning}\n`);

// Optional Telegram notification (best effort; alerts are optional).
function notify(subject, body) {
  if (project.installed && !project.config.modules.telegram) return;
  const tns = join(LIB_DIR, 'telegram-notify.sh');
  if (existsSync(tns) && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    try { spawnSync('bash', [tns, subject, body], { stdio: 'ignore', timeout: 15000 }); }
    catch { /* alerts are not critical */ }
  }
}

// --- The loop lock (v1.5.0; liveness evidence v1.14.0) ---
// Why it is needed here: a single project can have two Claude Code sessions open, and both would
// drive the loop, competing over docs/STATE.md. The hook is the second loop driver, so the check
// belongs here too. The difference from the supervisor: the hook does NOT refuse to let the
// session work, it merely stops that session from DRIVING THE LOOP — the session ends normally
// (fail-open) and the loop stays with its live owner.
//
// v1.14.0 — WHY IT NEVER WORKED UNTIL NOW. The hook used to take the lock without saying what
// proved it alive, so the lock recorded THIS process's number — and a hook process lives for
// milliseconds. Measured on a lock written a moment before: `ownerState -> dead`. The branch below
// that compares session ids was therefore unreachable, and every extra session took the loop away
// from the previous one on every turn.
//
// What actually lives as long as this session is its TRANSCRIPT: the file Claude Code appends to
// with every message, whose path arrives in this very payload. So that is what we register. If the
// payload carries no path (an older Claude Code, a hand-made invocation) we fall back to the
// heartbeat under this session's id — degraded, but the loop still gets driven, which matters more
// than perfect evidence.
const TRANSCRIPT = hook.transcript_path ? String(hook.transcript_path) : '';
const LIVENESS = TRANSCRIPT
  ? { kind: 'file', id: TRANSCRIPT }
  : { kind: 'heartbeat', id: SESSION_ID || `pid-${process.pid}` };

// acquireLock now recognises a lock that is already ours and simply refreshes it, so one call
// covers all three cases: free, ours, somebody else's.
const claimed = await acquireLockEventually({
  projectDir: PROJECT_DIR, engine: 'stop-hook', sessionId: SESSION_ID, liveness: LIVENESS,
});
if (!claimed.acquired) {
  const conclusion = claimed.state === LOCK_BUSY
    ? 'Ownership could not be confirmed; this invocation ends without a continuation.'
    : 'This session is not driving the loop and ends normally.';
  process.stderr.write(
    `ralph-loop-stop: ${claimed.reason} ${conclusion}\n`);
  failOpen();
}
if (claimed.takenOver) process.stderr.write(`ralph-loop-stop: ${claimed.reason}\n`);

// --- The loop decision (gate logic lives in core/gates.mjs, shared by both drivers) ---
// v1.13.0: what long jobs are doing, gathered before the decision. A few system calls, never a wait.
const jobs = inspectStateJobs(st, { cwd: PROJECT_DIR });

const decision = decideContinuation(st,
  { sessionId: SESSION_ID, driver: 'stop-hook', jobs, projectDir: PROJECT_DIR, project });

// A job that died is the case a marker-only wait hangs on for ever, so it is said out loud as well
// as written into the continuation text.
for (const j of jobs) {
  if (j.state === 'died' || j.state === 'overdue') {
    process.stderr.write(`ralph-loop-stop: job ${j.id} is ${j.state} — ${j.why}\n`);
  }
  // v1.14.0: a record that contradicts itself — an unreadable deadline, a marker with nowhere to
  // look for it — used to be ignored in silence, which is how a guard stops guarding without
  // anybody noticing.
  for (const w of (j.warnings || [])) {
    process.stderr.write(`ralph-loop-stop: job ${j.id} — ${w}\n`);
  }
}

// v1.7.0: dropping a stale step instruction in silence would swap one quiet failure for another,
// so the reason it was dropped is said out loud. The loop still continues — it just continues on
// the generic "work it out from STATE" instruction instead of on an instruction for a position
// the loop left behind.
if (decision.staleNextPrompt) {
  process.stderr.write(
    `ralph-loop-stop: the recorded step instruction was dropped — ${decision.staleNextPrompt.why}\n`);
}

// Stop gates: send an alert (if any) and allow the stop.
if (decision.action === 'stop') {
  if (decision.notify) notify(decision.notify.subject, decision.notify.body);
  failOpen();
}

// --- Turn progress (v1.8.0) ---
// The documented promise — two empty turns escalate, three record a no_progress blocker — was
// implemented only in core/supervisor.mjs. On this driver, the default one, nothing measured
// anything: an agent waiting for an event that had already happened looked exactly like an agent
// at work. Reported from a live project after a six-hour idle.
//
// The snapshot is taken BEFORE this hook writes its own patch. Taken after, it would include our
// iteration counter and last_action_at, the driver would read its own bookkeeping as the agent's
// work, and the stall could never be detected. The supervisor guards the same way, for the same
// reason.
const DOCS_DIR = project.runtimeDir;
let stagnantTurns = 0;
let memory = null;
let snapshot = null;
try {
  memory = readMemory(DOCS_DIR);
  snapshot = captureSnapshot({ cwd: PROJECT_DIR, stateFile: STATE_FILE });
  stagnantTurns = stagnantAfterTurn(memory, snapshot);
} catch { stagnantTurns = 0; }   // an observer must never be able to break a turn

// The secrets notice, on this driver for the first time (v1.8.0). README, GUIDELINE and
// docs/failure-modes all promise it without naming an engine — "if a commit picks up a file that
// looks like key storage, you get a line in the log and a notification" — and it was wired only
// into core/supervisor.mjs. On the default engine nobody was watching, which is precisely where a
// live project committed a file of root passwords and only human eyes caught it.
//
// It BLOCKS NOTHING, by the same explicit decision as on the supervisor: the ability to commit a
// key is preserved deliberately. The job here is to inform, not to obstruct.
if (memory && snapshot) {
  try {
    const notice = noticeAfterTurn({ cwd: PROJECT_DIR, before: memory.snapshot, after: snapshot });
    if (notice) {
      process.stderr.write(`ralph-loop-stop: WARNING: ${notice.message}\n`);
      notify('Ralph Loop: secrets in a commit', notice.message);
    }
  } catch { /* an observer must never be able to break a turn */ }
}

// --- Continuing the loop ---
// Atomic STATE update through the proven update-state.mjs (backup plus temp file and rename).
const patchObj = {
  iteration: decision.next.iteration,
  last_session_id: decision.next.lastSessionId,
  session_count: decision.next.sessionCount,
};
// v1.15.0: the thresholds and the blocker itself live in core/turn-progress.mjs. They used to be
// the bare numbers 2 and 3, written out in this file AND in the supervisor — one rule in two
// places, which is the drift class v1.7.1 spent a version closing.
if (stagnantTurns >= progressLimits.blockAfter) patchObj.blockers = [noProgressBlocker(stagnantTurns)];
const patch = JSON.stringify(patchObj);
const res = spawnSync(process.execPath, [join(LIB_DIR, 'update-state.mjs'), STATE_FILE],
  { input: patch, encoding: 'utf8' });

// A failed STATE write is a blocker: continuing is pointless (iteration would not grow and the
// iteration cap would never be reached).
if (!res || res.status !== 0) {
  process.stderr.write('ralph-loop-stop: failed to update STATE.md — stopping loop to avoid spin\n');
  notify('Ralph Loop: STATE update failed',
    'Could not write STATE.md. Loop stopped to avoid runaway — manual review required.');
  failOpen();
}

// Remember the state AFTER our own write, so the next turn compares like with like: both snapshots
// are taken at the same point in the cycle and the only thing between them is the agent's turn.
try { writeMemory(DOCS_DIR, captureSnapshot({ cwd: PROJECT_DIR, stateFile: STATE_FILE }), stagnantTurns); }
catch { /* losing one observation is cheaper than losing the turn */ }

// Three empty turns in a row: the blocker is already written above, so the loop stops here the same
// way it stops for any other blocker. Escalation was tried and did not help.
if (stagnantTurns >= progressLimits.blockAfter) {
  process.stderr.write(`ralph-loop-stop: ${stagnantTurns} turns without measurable progress — no_progress blocker recorded\n`);
  notify('Ralph Loop: no progress',
    `${stagnantTurns} consecutive turns without progress — a no_progress blocker was written to the state role. See the failure-mode guide.`);
  failOpen();
}

// Two empty turns: tell the agent, in the instruction it is about to act on, that its last turns
// changed nothing. This is the case the loop exists for — an agent that believes it is waiting for
// something is unable to notice that nothing is coming.
const reason = stagnantTurns >= progressLimits.escalateAfter
  ? escalationDirective(decision.reason, stagnantTurns, project.documentRelative('state'))
  : decision.reason;

// Emit decision:block so that Claude continues.
process.stdout.write(JSON.stringify({
  decision: 'block',
  reason,
  systemMessage: decision.systemMessage,
}));
process.exit(0);
