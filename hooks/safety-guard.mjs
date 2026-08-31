#!/usr/bin/env node
// safety-guard.mjs — the framework's PreToolUse hook: the permission arbiter.
//
// Why (v0.6.0): to widen permissions safely (git push and friends without prompts) you need REAL
// protection against destructive commands. This hook is that protection.
//
// What changed in v1.2.0: the hook no longer stays silent on safe operations — it returns an
// explicit "allow" decision. Silence used to mean "no decision", so the question fell through to
// the ordinary permission system, which then showed a prompt to the user even with
// bypassPermissions enabled. Now the decision is made here, so no prompt appears in the interface,
// in the terminal, or in unattended mode (research experiments C1/F1/F2). Protection did not
// weaken: a `deny` from the hook fires even under bypass (experiment H1).
//
// The previous behaviour is available via SAFETY_GUARD_MODE=guard-only.
//
// Stdin: the PreToolUse event as JSON (tool_name, tool_input.command, ...).
// Stdout: {"hookSpecificOutput":{...permissionDecision: "allow"|"deny"...}} or nothing.
// Exit: always 0 (the hook NEVER fails and never blocks the agent's work).
//
// Separation of concerns: destructiveness rules live in core/safety.mjs, the decision in
// core/permission-decision.mjs, and this file does nothing but input and output.

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { decidePermission, resolveMode, MODES, ALLOW_ALL } from '../core/permission-decision.mjs';

let input = '';
try { input = readFileSync(0, 'utf8'); } catch { /* no stdin — acceptable */ }

let ev = {};
try { ev = JSON.parse(input || '{}'); } catch { ev = {}; }

// v1.10.0: the acting mode is resolved once, and an unrecognised value is said out loud instead of
// being swallowed. Continuing on the safe default is the right trade — a typo in an environment
// variable must not halt the loop — but doing it silently is how somebody ends up believing the
// guard is off while it is fully on.
const modeReport = resolveMode(process.env);
if (!modeReport.recognised) {
  process.stderr.write(
    `safety-guard: SAFETY_GUARD_MODE="${modeReport.requested}" is not a known mode ` +
    `(${MODES.join(', ')}) — continuing in ${modeReport.mode}\n`);
}

const decision = decidePermission(ev, { mode: modeReport.mode });

if (decision) {
  // What goes into the log, and why two kinds of line.
  //
  // A refusal is recorded because it is evidence for analysis and for live acceptance. A CONFIRMED
  // operation is recorded for a different and more important reason: the confirm mode trades a hard
  // guarantee for the agent's judgement, and that trade is only honest if the judgement can be
  // reviewed afterwards. An allowed destructive command that left no trace would be strictly worse
  // than a refusal.
  const out = decision.hookSpecificOutput;
  const confirmed = out.permissionDecision === 'allow' && / rule confirmed by the agent /.test(out.permissionDecisionReason);
  if (out.permissionDecision === 'deny' || confirmed) {
    try {
      const dir = join(homedir(), '.claude');
      if (existsSync(dir)) {
        const cmd = (ev.tool_input && (ev.tool_input.command ?? ev.tool_input.cmd)) || '';
        const tag = confirmed ? '[confirmed]' : '[blocked]';
        appendFileSync(join(dir, 'safety-guard.log'),
          `${tag} [mode ${modeReport.mode}] ${out.permissionDecisionReason} :: ${cmd}\n`);
      }
    } catch { /* the log is not critical */ }
  }
  process.stdout.write(JSON.stringify(decision));
}

// A mode that never denies leaves no [blocked] lines, so without this the log would look exactly
// like a quiet day. The claim "the guard is off" has to be checkable by observation.
if (!modeReport.recognised || modeReport.mode === ALLOW_ALL) {
  try {
    const dir = join(homedir(), '.claude');
    if (existsSync(dir)) {
      appendFileSync(join(dir, 'safety-guard.log'),
        `[mode ${modeReport.mode}]${modeReport.recognised ? '' : ` (requested "${modeReport.requested}")`}`
        + ` ${new Date().toISOString()}\n`);
    }
  } catch { /* the log is not critical */ }
}

process.exit(0);
