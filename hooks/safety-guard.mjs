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
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { decidePermission, resolveMode, MODES, guardAuditRecord } from '../core/permission-decision.mjs';
import { findProjectRoot, loadProjectConfig } from '../core/project-config.mjs';

let input = '';
try { input = readFileSync(0, 'utf8'); } catch { /* no stdin — acceptable */ }

let ev = {};
try { ev = JSON.parse(input || '{}'); } catch { ev = {}; }

// v1.10.0: the acting mode is resolved once, and an unrecognised value is said out loud instead of
// being swallowed. Continuing on the safe default is the right trade — a typo in an environment
// variable must not halt the loop — but doing it silently is how somebody ends up believing the
// guard is off while it is fully on.
let project;
try { project = loadProjectConfig({ projectDir: process.env.CLAUDE_PROJECT_DIR || ev.cwd || findProjectRoot() }); }
catch (error) { process.stderr.write(`safety-guard: ${error.message}; using environment/default mode\n`); }
const modeReport = resolveMode(project?.guardEnvironment || process.env);
if (!modeReport.recognised) {
  process.stderr.write(
    `safety-guard: SAFETY_GUARD_MODE="${modeReport.requested}" is not a known mode ` +
    `(${MODES.join(', ')}) — continuing in ${modeReport.mode}\n`);
}

const decision = decidePermission(ev, { mode: modeReport.mode });

if (decision) {
  process.stdout.write(JSON.stringify(decision));
}

// A mode that never denies leaves no [blocked] lines, so without this the log would look exactly
// like a quiet day. The claim "the guard is off" has to be checkable by observation.
const entry = guardAuditRecord(ev, decision, modeReport);
if (entry) {
  try {
    const file = process.env.SAFETY_GUARD_LOG || (project?.installed ? project.runtimePath('guard.log')
      : join(homedir(), '.claude', 'safety-guard.log'));
    if (existsSync(dirname(file))) appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch { /* the log is not critical */ }
}

process.exit(0);
