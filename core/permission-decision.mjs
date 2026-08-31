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

import { destructiveVerdict, confirmationOf, HARD, ADVISORY } from './safety.mjs';

export const ARBITER = 'arbiter';        // we decide: allow / deny
export const GUARD_ONLY = 'guard-only';  // deny only, otherwise stay silent (pre-v1.2.0 behaviour)
export const ALLOW_ALL = 'allow-all';    // v1.10.0: no denials at all, by explicit request
export const CONFIRM = 'confirm';        // v1.11.0: name the consequence, ask for a stated reason

export const MODES = [ARBITER, GUARD_ONLY, ALLOW_ALL, CONFIRM];

// How much of a reason counts as one. The point of the marker is that the agent reconsidered; an
// agent stuck in a retry loop would otherwise append "ok" and nothing would have been thought
// through. The bar is deliberately low — a strict judge of prose would become a new source of false
// refusals, which is the cost this whole mode exists to avoid.
const MIN_REASON_WORDS = 4;
const EMPTY_REASONS = /^(?:ok|yes|no|sure|fine|because|confirmed?|do it|please)\W*$/i;

export function isSubstantiveReason(text) {
  const t = String(text || '').trim();
  if (!t || EMPTY_REASONS.test(t)) return false;
  return t.split(/\s+/).filter(Boolean).length >= MIN_REASON_WORDS;
}

// Mode from the environment.
//
// WHY THIS RETURNS A REPORT RATHER THAN A STRING (v1.10.0). It used to return the mode alone, and
// an unrecognised value was swallowed: `SAFETY_GUARD_MODE=off` looked to its author like switching
// the guard off while the full guard kept running, and nothing anywhere said so. That is the
// project's most persistent defect class — what somebody wrote and what happens diverging in
// silence — and it had a copy right here.
//
// The default still applies on a bad value, deliberately: refusing outright would turn a typo in an
// environment variable into a halted loop, which is a worse trade than continuing safely. But the
// substitution is no longer invisible — the caller gets what was asked for and whether it was
// understood, and says so out loud.
export function resolveMode(env = process.env) {
  const requested = (env && typeof env.SAFETY_GUARD_MODE === 'string') ? env.SAFETY_GUARD_MODE : '';
  if (!requested) return { mode: ARBITER, requested: '', recognised: true };
  if (MODES.includes(requested)) return { mode: requested, requested, recognised: true };
  return { mode: ARBITER, requested, recognised: false };
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
  // The advisory rules are only ever consulted in the confirm mode — bringing them into the default
  // would restore exactly the false refusals v1.2.1 removed.
  const verdict = command ? destructiveVerdict(command, { advisory: mode === CONFIRM }) : null;

  // Switched off by explicit request. Checked BEFORE the destructiveness rules, because in this
  // mode their verdict changes nothing — and running them anyway would only invite the reader to
  // believe something is still being guarded.
  if (mode === ALLOW_ALL) {
    return output('allow',
      `safety-guard: mode ${ALLOW_ALL} — every operation is permitted, including destructive ones`);
  }

  // Ask rather than refuse (v1.11.0). The framework does not know the task; the agent does. So for
  // a rule with legitimate uses it names the consequence and asks for a reason, and a decision that
  // arrives with a stated reason can be reviewed afterwards — which a silent refusal cannot.
  if (verdict && mode === CONFIRM) {
    const stated = confirmationOf(command);

    // A hard rule is not open to argument. Asking the agent that proposed destroying the machine to
    // justify it could only ever produce a wrong answer, so the marker is ignored and said to be.
    if (verdict.level === HARD) {
      return output('deny', `safety-guard blocked a dangerous operation: ${verdict.reason}. ` +
        'This rule cannot be confirmed: there is no task context in which it is the right action. ' +
        'Run it yourself if you truly mean to.');
    }

    if (isSubstantiveReason(stated)) {
      return output('allow',
        `safety-guard: ${verdict.level} rule confirmed by the agent — ${verdict.reason}. ` +
        `Stated reason: ${stated}`);
    }

    const asked = verdict.level === ADVISORY ? 'worth a second thought' : 'refused unless argued for';
    return output('deny',
      `safety-guard: ${verdict.reason} — ${asked}. If, having considered that consequence in the ` +
      'context of this task, you still judge the command correct, re-issue it with a stated reason ' +
      'appended: `# safety-guard: confirmed <why this is right here>`. ' +
      `The reason must be specific (at least ${MIN_REASON_WORDS} words) and is written to the log.`);
  }

  if (verdict) {
    return output('deny', `safety-guard blocked a dangerous operation: ${verdict.reason}. ` +
      'If this was intentional, run it manually or relax the rule deliberately.');
  }
  if (mode === GUARD_ONLY) return null;

  return output('allow', tool
    ? `safety-guard: ${tool} looks safe (no destructive markers found)`
    : 'safety-guard: no destructive markers found');
}
