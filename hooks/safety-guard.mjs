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
import { decidePermission, resolveMode } from '../core/permission-decision.mjs';

let input = '';
try { input = readFileSync(0, 'utf8'); } catch { /* no stdin — acceptable */ }

let ev = {};
try { ev = JSON.parse(input || '{}'); } catch { ev = {}; }

const decision = decidePermission(ev, { mode: resolveMode(process.env) });

if (decision) {
  // Log what was blocked (best effort): a trace is needed for analysis and live acceptance.
  if (decision.hookSpecificOutput.permissionDecision === 'deny') {
    try {
      const dir = join(homedir(), '.claude');
      if (existsSync(dir)) {
        const cmd = (ev.tool_input && (ev.tool_input.command ?? ev.tool_input.cmd)) || '';
        appendFileSync(join(dir, 'safety-guard.log'),
          `[blocked] ${decision.hookSpecificOutput.permissionDecisionReason} :: ${cmd}\n`);
      }
    } catch { /* the log is not critical */ }
  }
  process.stdout.write(JSON.stringify(decision));
}

process.exit(0);
