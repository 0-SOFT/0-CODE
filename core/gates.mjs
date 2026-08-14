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
//   otherwise                  → continue (decision:block with reason = next_step_prompt)

// Loop "adoption" logic (v0.5.9 — the root fix for continuity):
// last_session_id in STATE records the last session that WROTE to it, not the live one. When a
// process dies and a new session starts, the two ids differ — but the loop must be PICKED UP by
// the new session instead of quietly dying. So when stateSession != sessionId we treat it as the
// new session adopting the loop.
export function decideContinuation(state, { sessionId = '' } = {}) {
  const st = state && typeof state === 'object' ? state : {};

  const blockers = Array.isArray(st.blockers) ? st.blockers : [];
  const released = st.released_version ? String(st.released_version) : '';
  const current = st.current_version ? String(st.current_version) : '';
  let iteration = parseInt(st.iteration, 10); if (!Number.isFinite(iteration)) iteration = 0;
  let maxIter = parseInt(st.max_iterations, 10); if (!Number.isFinite(maxIter)) maxIter = 1000;
  const stateSession = st.last_session_id ? String(st.last_session_id) : '';
  const nextPrompt = st.next_step_prompt ? String(st.next_step_prompt) : '';
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
  if (iteration >= maxIter) {
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
  const reason = nextPrompt ||
    `Continue work according to docs/STATE.md and docs/ROADMAP.md. Current iteration: ${nextIter}/${maxIter}. Read STATE, decide next step, execute, update STATE.`;
  const systemMessage = `Ralph Loop: iter ${nextIter}/${maxIter} (v${current})${adopted ? ' [adopted loop from prior session]' : ''}`;

  return {
    action: 'continue', stopCause: null, notify: null,
    next: { iteration: nextIter, lastSessionId: sessionId, sessionCount: nextCount },
    reason, systemMessage, adopted,
  };
}
