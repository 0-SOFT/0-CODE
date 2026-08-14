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
import { acquireLock, refreshLock, ownerState, readLock } from '../core/loop-lock.mjs';

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

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_FILE = join(PROJECT_DIR, 'docs', 'STATE.md');

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

// Optional Telegram notification (best effort; alerts are optional).
function notify(subject, body) {
  const tns = join(LIB_DIR, 'telegram-notify.sh');
  if (existsSync(tns) && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    try { spawnSync('bash', [tns, subject, body], { stdio: 'ignore', timeout: 15000 }); }
    catch { /* alerts are not critical */ }
  }
}

// --- The loop lock (v1.5.0) ---
// Why it is needed here: a single project can have two Claude Code sessions open, and both would
// drive the loop, competing over docs/STATE.md. The hook is the second loop driver, so the check
// belongs here too. The difference from the supervisor: the hook does NOT refuse to let the
// session work, it merely stops that session from DRIVING THE LOOP — the session ends normally
// (fail-open) and the loop stays with its live owner.
const lock = readLock(PROJECT_DIR);
const ownerStatus = ownerState(lock);
if (ownerStatus === 'alive' || ownerStatus === 'foreign-unknown') {
  const isOurs = lock && String(lock.sessionId || '') === String(SESSION_ID);
  if (!isOurs) {
    process.stderr.write(
      `ralph-loop-stop: the loop is driven by another process (${lock.pid}, ${lock.engine || 'unknown engine'}) — this session is ending\n`);
    failOpen();
  }
  refreshLock({ projectDir: PROJECT_DIR, pid: lock.pid });
} else {
  // The lock is free, its owner is dead, or the heartbeat went stale — take the loop over.
  const taken = acquireLock({ projectDir: PROJECT_DIR, engine: 'stop-hook', sessionId: SESSION_ID });
  if (taken.takenOver) process.stderr.write(`ralph-loop-stop: ${taken.reason}\n`);
}

// --- The loop decision (gate logic lives in core/gates.mjs, shared by both drivers) ---
const decision = decideContinuation(st, { sessionId: SESSION_ID });

// Stop gates: send an alert (if any) and allow the stop.
if (decision.action === 'stop') {
  if (decision.notify) notify(decision.notify.subject, decision.notify.body);
  failOpen();
}

// --- Continuing the loop ---
// Atomic STATE update through the proven update-state.mjs (backup plus temp file and rename).
const patch = JSON.stringify({
  iteration: decision.next.iteration,
  last_session_id: decision.next.lastSessionId,
  session_count: decision.next.sessionCount,
});
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

// Emit decision:block so that Claude continues.
process.stdout.write(JSON.stringify({
  decision: 'block',
  reason: decision.reason,
  systemMessage: decision.systemMessage,
}));
process.exit(0);
