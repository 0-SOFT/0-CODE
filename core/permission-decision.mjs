// core/permission-decision.mjs — a pure decision about a tool call (no I/O).
//
// WHY (v1.2.0): the `safety-guard` hook used to do only two things — say "deny" or stay silent.
// Silence means "no decision", so the question fell through to the ordinary permission system,
// which is what produced the prompt. Research experiments showed the hook can decide by itself:
//
//   C1 — an explicit `allow` from the hook removes the prompt EVEN in normal mode (no bypass);
//   F1 — with matcher "*" this works for every tool, not just for shell commands;
//   F2 — it also removes the separate confirmation for output redirection;
//   H1 — a `deny` from the hook blocks destructive commands EVEN under bypassPermissions.
//
// Hence the "arbiter" mode: the hook decides on every call — allowing what is safe and denying
// what is destructive. No prompts appear in any environment, and protection no longer depends on
// which mode is selected in the user interface.
//
// The destructiveness rules come from core/safety.mjs (a single source shared by all backends).

import { destructiveReason } from './safety.mjs';

export const ARBITER = 'arbiter';        // we decide: allow / deny
export const GUARD_ONLY = 'guard-only';  // previous behaviour: deny only, otherwise stay silent

// Mode from the environment. Any unrecognised value falls back to the meaningfully safe default
// (arbiter): that is the mode which delivers the uninterrupted operation this version exists for.
export function resolveMode(env = process.env) {
  return env && env.SAFETY_GUARD_MODE === GUARD_ONLY ? GUARD_ONLY : ARBITER;
}

function output(decision, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

// Decision for a PreToolUse event. Returns an object for stdout, or null ("no decision").
// Never throws: the hook must not crash and block the agent's work.
export function decidePermission(event, { mode = ARBITER } = {}) {
  const ev = (event && typeof event === 'object') ? event : {};
  const tool = ev.tool_name || ev.toolName || '';
  const input = (ev.tool_input && typeof ev.tool_input === 'object') ? ev.tool_input : {};
  const command = typeof input.command === 'string' ? input.command
    : (typeof input.cmd === 'string' ? input.cmd : '');

  // Shell commands go through the detector; other tools carry no command, so no destruction.
  const reason = command ? destructiveReason(command) : null;

  if (reason) {
    return output('deny', `safety-guard blocked a dangerous operation: ${reason}. ` +
      'If this was intentional, run it manually or relax the rule deliberately.');
  }
  if (mode === GUARD_ONLY) return null;

  return output('allow', tool
    ? `safety-guard: ${tool} looks safe (no destructive markers found)`
    : 'safety-guard: no destructive markers found');
}
