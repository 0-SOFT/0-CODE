// core/loop-limits.mjs — the single source of truth for the loop's outer backstop (v1.9.0).
//
// WHAT THIS IS NOT. It is not a second iteration cap. `max_iterations` in docs/STATE.md is the
// loop's limit, it is opt-in, it accumulates across sessions and it belongs to whoever runs the
// project. CLAUDE_CODE_STOP_HOOK_BLOCK_CAP is something else entirely: Claude Code's own counter of
// consecutive `decision:block` replies WITHIN ONE SESSION, and it exists to survive a defect in
// OUR hook — if the hook ever blocks unconditionally while `iteration` stops growing, the session
// still ends.
//
// WHY IT CANNOT SIMPLY BE REMOVED. The native default is 8 (confirmed against the official
// documentation in docs/reports/0.0.2_skeleton-research.md). Deleting the variable does not mean
// "no limit"; it means a limit of eight consecutive continuations, which is the opposite of what
// removing a guard is meant to achieve. So "off" is expressed as a deliberately large number.
//
// WHY THE NUMBER IS STILL FINITE. A backstop that never fires protects nothing. The value is
// chosen so that it cannot be reached by real work — at any believable turn duration a session
// would have to run for weeks — while a hook stuck in a tight failure loop, where a "turn" costs
// milliseconds, still terminates in seconds.
//
// THE ORDERING RULE. The backstop must sit ABOVE the loop's own limit, or it silently becomes the
// primary limiter and truncates a cap somebody deliberately set. That happened: a project carried
// `max_iterations: 4444` against a backstop of 1000, and nothing said a word. `exceedsBackstop`
// exists so that it is said.

export const STOP_HOOK_BLOCK_CAP = 100000;

// Is an explicit iteration cap so high that the backstop would stop the session first? Returns
// null when there is nothing to warn about: no cap set, an invalid one, or one that fits.
export function exceedsBackstop(maxIterations, backstop = STOP_HOOK_BLOCK_CAP) {
  const cap = parseInt(maxIterations, 10);
  if (!Number.isFinite(cap) || cap <= 0) return null;     // opt-in limit that nobody opted into
  if (cap <= backstop) return null;
  return {
    cap,
    backstop,
    why: `max_iterations is ${cap}, above the CLAUDE_CODE_STOP_HOOK_BLOCK_CAP backstop of ${backstop}. ` +
      'A single session will be stopped by the backstop first, so the cap you set is not the one ' +
      'that applies. Raise the backstop in the settings, or lower the cap.',
  };
}
