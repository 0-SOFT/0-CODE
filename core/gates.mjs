// core/gates.mjs — agent-independent logic that answers "should the Ralph Loop continue?".
//
// Extracted from hooks/ralph-loop-stop.mjs (v0.8.0, Phase 1). A pure function: it takes the
// parsed STATE object (frontmatter) plus the live session id and returns a decision. No I/O —
// reading STATE, sending Telegram messages and writing files is the caller's job (the Claude Code
// Stop hook OR the external supervisor for OpenCode). That is what lets EVERY backend decide by
// the same rules (DRY).
//
// Gates, in order (the order matters and matches the original implementation):
//   1) blockers present        → stop
//   2) released == current     → project finished, stop
//   3) iteration >= max        → limit reached, stop
//   4) budget cap exceeded     → stop
//   otherwise                  → continue (decision:block with a reason built from STATE)
//
// v1.7.0 — WHAT THE REASON IS MADE OF. It used to be the raw `next_step_prompt`, and that let a
// free-text field outrank the machine fields around it: a live project was handed an instruction
// from two versions back, announcing a blocker, while STATE.blockers was empty. Now the reason
// always opens with a block generated from STATE, and the recorded instruction is only appended
// after it has been checked for freshness (see lib/step-instruction.mjs).

import { checkFreshness } from '../lib/step-instruction.mjs';
import { exceedsBackstop } from './loop-limits.mjs';

// Loop "adoption" logic (v0.5.9 — the root fix for continuity):
// last_session_id in STATE records the last session that WROTE to it, not the live one. When a
// process dies and a new session starts, the two ids differ — but the loop must be PICKED UP by
// the new session instead of quietly dying. So when stateSession != sessionId we treat it as the
// new session adopting the loop.
// How long docs/STATE.md may stay untouched before the agent is told about it. Twenty minutes is a
// deliberate compromise: long enough that ordinary deep work never trips it, short enough that a
// wait for something that already finished does not consume an evening. Projects override it with
// stall_timeout_minutes in STATE.
export const DEFAULT_STALL_MINUTES = 20;

// Minutes since the last recorded action, or null when that cannot be known.
//
// lib/update-state.mjs has written last_action_at since the first version, and until v1.8.0 no line
// of core/, lib/ or hooks/ ever read it: the field was decoration. Reading it closes a case the
// turn-based progress detector cannot see — turns that DO happen, are long, and produce nothing.
//
// Null is returned for an absent or unparseable stamp, and null is never silence: a project created
// before v1.8.0, or the very first turn of any project, has nothing to be silent about. A clock
// that cannot read the time must not accuse anyone of being late.
export function minutesSinceAction(st, now = Date.now()) {
  const raw = st && st.last_action_at;
  if (!raw) return null;
  const t = Date.parse(String(raw));
  if (!Number.isFinite(t)) return null;
  const minutes = (now - t) / 60000;
  return minutes >= 0 ? minutes : null;      // a clock skew into the future is not silence either
}

export function decideContinuation(state, { sessionId = '', driver = '' } = {}) {
  const st = state && typeof state === 'object' ? state : {};

  const blockers = Array.isArray(st.blockers) ? st.blockers : [];
  const released = st.released_version ? String(st.released_version) : '';
  const current = st.current_version ? String(st.current_version) : '';
  let iteration = parseInt(st.iteration, 10); if (!Number.isFinite(iteration)) iteration = 0;
  // v1.9.0: a limit is opt-in. Absent, null, 0 or negative all mean the same thing — nobody
  // asked for a cap, so none is invented. Until now an absent field quietly became 1000.
  let maxIter = parseInt(st.max_iterations, 10);
  if (!Number.isFinite(maxIter) || maxIter <= 0) maxIter = null;
  const stateSession = st.last_session_id ? String(st.last_session_id) : '';
  let sessionCount = parseInt(st.session_count, 10); if (!Number.isFinite(sessionCount)) sessionCount = 0;
  const bm = (st.budget_metrics && typeof st.budget_metrics === 'object') ? st.budget_metrics : {};
  const versionCost = Number.parseFloat(bm.version_cost_usd) || 0;
  const budgetCap = Number.parseFloat(bm.cap_usd) || 0;

  const adopted = Boolean(stateSession) && stateSession !== sessionId;

  // 1. Blockers.
  if (blockers.length > 0) {
    return {
      action: 'stop', stopCause: 'blockers',
      notify: { subject: 'Ralph Loop: blocker detected',
        body: `Project ${current} has ${blockers.length} blocker(s). See docs/STATE.md.` },
    };
  }
  // 2. Released == current.
  if (released && released === current) {
    return {
      action: 'stop', stopCause: 'released',
      notify: { subject: 'Ralph Loop: project completed',
        body: `Version ${released} released. ROADMAP closed.` },
    };
  }
  // 3. Iteration limit.
  if (maxIter !== null && iteration >= maxIter) {
    return {
      action: 'stop', stopCause: 'iteration_cap',
      notify: { subject: 'Ralph Loop: iteration limit',
        body: `Reached ${maxIter} iterations on ${current}. Manual review required.` },
    };
  }
  // 4. Budget cap (optional).
  if (budgetCap !== 0 && versionCost >= budgetCap) {
    return {
      action: 'stop', stopCause: 'budget_cap',
      notify: { subject: 'Ralph Loop: budget exceeded',
        body: `Version ${current} cost $${versionCost} exceeds cap $${budgetCap}.` },
    };
  }

  // --- Continue the loop ---
  const nextIter = iteration + 1;
  // session_count only grows when the session changes, not on every iteration.
  const nextCount = (sessionId !== stateSession) ? sessionCount + 1 : sessionCount;
  // How the position is reported when there is no cap: saying "8 (no cap)" is the honest
  // form. Printing 8/1000 would put a number in front of the agent that nobody chose.
  const iterationLabel = maxIter === null ? `${nextIter} (no cap)` : `${nextIter}/${maxIter}`;

  // The recorded step instruction is used only if it still describes where the loop stands.
  const freshness = checkFreshness(st);
  const usable = freshness.status === 'fresh' || freshness.status === 'unverified';
  const staleNextPrompt = freshness.status === 'stale'
    ? { why: freshness.why, dropped: freshness.instruction }
    : null;

  const generic = `Continue work according to docs/STATE.md and docs/ROADMAP.md. Read STATE, decide the next step, execute it, update STATE.`;
  const stepInstruction = usable ? freshness.instruction : generic;

  // The machine truth goes FIRST and says so. This is what stops a free-text instruction from
  // being the only signal the agent has: whatever the text below claims about blockers or about
  // which version is in flight, the fields say otherwise right above it.
  const header = [
    '[LOOP STATE — machine truth from docs/STATE.md]',
    `version: ${current || 'unknown'} | stage: ${st.current_stage ?? 'unknown'} | ` +
      `iteration: ${iterationLabel} | blockers: none | ` +
      `prompt file: ${st.current_prompt_file || 'none'}`,
    'Generated from STATE fields. If the step instruction below contradicts this block, this block wins.',
  ];
  if (staleNextPrompt) {
    header.push(`WARNING: the recorded step instruction was dropped — ${freshness.why}. ` +
      'Rewrite next_step_prompt in the same patch that moves the loop.');
  } else if (freshness.status === 'unverified') {
    // freshness.why already opens with "no freshness stamp", so prefixing it said the phrase
    // twice in the text the agent reads every turn on a pre-v1.7.0 project.
    header.push(`NOTE: the step instruction is unverified — ${freshness.why}.`);
  }

  // Silence is a WARNING and never a stop. A false stop costs more than a false warning: the loop
  // exists to run without a human, and halting it on a suspicion hands the human back exactly the
  // job the framework was built to do. So this only ever speaks.
  //
  // Honest limit, recorded where it cannot be lost: this would NOT have prevented the six-hour idle
  // that prompted v1.8.0. There the Stop hook was never registered in the running process, so the
  // gates ran zero times and no check inside them could have fired. What it does close is the case
  // the turn detector cannot see — turns that happen, take a long time, and change nothing.
  let stallMinutes = parseFloat(st.stall_timeout_minutes);
  if (!Number.isFinite(stallMinutes) || stallMinutes <= 0) stallMinutes = DEFAULT_STALL_MINUTES;
  const quietFor = minutesSinceAction(st);
  if (quietFor !== null && quietFor > stallMinutes) {
    header.push(
      `WARNING: docs/STATE.md has not changed for ${Math.round(quietFor)} minutes ` +
      `(threshold ${stallMinutes}). If you are waiting on a background job, check its actual state ` +
      'directly rather than waiting for a notification — a wait that will never end looks exactly ' +
      'like work from here.');
  }

  // An explicit cap above the backstop is silently truncated by Claude Code, so it is named here
  // rather than left to be discovered by counting iterations that never arrive.
  const overBackstop = exceedsBackstop(maxIter);
  if (overBackstop) header.push(`WARNING: ${overBackstop.why}`);

  // A spending cap that nobody can enforce must say so rather than sit there looking like a guard.
  //
  // version_cost_usd is written by the supervisor alone: it gets the turn cost back from the
  // engine. The Stop hook never sees a cost — the Stop payload carries a transcript path, and the
  // transcript (1313 records, 12 record types, checked in v1.9.0) has no cost field at all, only
  // token counts. Deriving money from tokens would mean keeping a price table for every model,
  // tier, region and token kind: a copy of somebody else's data with no expiry date, which is the
  // defect class v1.7.0 exists to prevent. A budget guard reporting a wrong number is worse than
  // one reporting none, because a wrong number is believed.
  if (budgetCap > 0 && driver === 'stop-hook') {
    header.push(
      `NOTE: a spending cap of $${budgetCap} is set, but it cannot fire under the Stop hook — ` +
      'nothing fills version_cost_usd in this mode, so it stays at 0. The cap works under ' +
      'core/supervisor.mjs. See docs/failure-modes.md.');
  }

  const reason = `${header.join('\n')}\n\n[STEP INSTRUCTION]\n${stepInstruction}`;
  const systemMessage = `Ralph Loop: iter ${iterationLabel} (v${current})` +
    `${adopted ? ' [adopted loop from prior session]' : ''}` +
    `${staleNextPrompt ? ' [stale step instruction dropped]' : ''}`;

  return {
    action: 'continue', stopCause: null, notify: null,
    next: { iteration: nextIter, lastSessionId: sessionId, sessionCount: nextCount },
    reason, systemMessage, adopted, stepInstruction, staleNextPrompt,
  };
}
