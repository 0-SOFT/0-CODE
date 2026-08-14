// core/preflight.mjs — engine self-check before entering the loop (v1.5.0).
//
// TWO REASONS, both from experience rather than caution.
//
// 1. The event-stream parser is verified against one specific engine version (opencode 1.18.16).
//    If the format changes, turns start returning nothing — and the loop spins uselessly, burning
//    money without understanding what broke. A silent failure is worse than a loud one.
//
// 2. Experience from Stage 1: the engine returns THE SAME vague text "UnknownError: Unexpected
//    server error" both for a server failure and for a NON-EXISTENT MODEL, and stays silent
//    altogether when the network is unreachable. These cases are indistinguishable by text, so a
//    misconfiguration masquerades as a transient failure and costs 75 seconds of useless retries
//    (measured). It must be caught BEFORE the loop.
//
// WHY WE PROBE WITH THE SAME MODEL THE LOOP USES. The temptation to probe with the cheapest model
// is understandable, but then the main purpose is lost: a wrong loop model would go unnoticed.
// What makes this cheap is not the model choice but the TINY prompt: a few words in, one word out
// — fractions of a cent.
//
// WHAT COUNTS AS A FAILURE VERSUS A NOTE (it is important not to overreach):
//   - failure — no usable answer: the turn failed or the text is empty. Without this the loop is
//     pointless.
//   - note    — no cost or no session id. The format may have changed in a detail; breaking the
//     run over that would be wrong, but the human should know.

export const PREFLIGHT_PROMPT = 'Reply with one word: OK';
export const PREFLIGHT_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Assessment of the probe turn. A pure function — the whole substance of the check lives here, so
 * it is covered by tests without launching a real engine.
 * @returns {{ok: boolean, problems: string[], notes: string[]}}
 */
export function assessProbe(turn) {
  const problems = [], notes = [];
  if (!turn || typeof turn !== 'object') {
    return { ok: false, problems: ['the engine returned no result at all'], notes };
  }
  if (turn.timedOut) problems.push('the engine did not answer within the allotted time (silent hang)');
  if (!turn.ok) {
    problems.push(`the probe turn failed: ${String(turn.error || 'no reason given').slice(0, 200)}`);
  }
  const text = typeof turn.output === 'string' ? turn.output.trim() : '';
  if (turn.ok && !text) {
    problems.push('the turn succeeded but the answer is EMPTY — the engine output format changed and the parser finds no text');
  }
  if (turn.ok && text) {
    if (turn.sessionId === undefined || turn.sessionId === null || turn.sessionId === '') {
      notes.push('the answer carries no session id — the format may have changed');
    }
    if (typeof turn.costUsd !== 'number') {
      notes.push('the answer carries no turn cost — spend tracking and the budget guard will not work');
    }
  }
  return { ok: problems.length === 0, problems, notes };
}

// Human-readable explanation of the refusal: what was checked, with what, and what did not match.
export function explainFailure({ problems, backendId, model, engineVersion }) {
  const lines = [
    'Engine self-check failed — the loop was NOT started (cheaper than spinning for nothing).',
    `  engine: ${backendId}${engineVersion ? ` (version ${engineVersion})` : ''}`,
    `  model:  ${model || '(not set)'}`,
  ];
  for (const p of problems) lines.push(`  x ${p}`);
  lines.push('  What to check: model name, access key, remaining credit, network availability.');
  lines.push('  To skip this check while debugging: --no-preflight.');
  return lines.join('\n');
}

/**
 * Live self-check: one tiny turn with the same backend and the same model.
 * @returns {Promise<{ok, problems, notes, turn, ms}>}
 */
export async function preflight({
  backend, model, cwd = process.cwd(), timeoutMs = PREFLIGHT_TIMEOUT_MS,
  prompt = PREFLIGHT_PROMPT, now = () => Date.now(),
} = {}) {
  const t0 = now();
  let turn = null;
  try {
    turn = await backend.runTurn({ prompt, cwd, model, timeoutMs });
  } catch (e) {
    turn = { ok: false, error: `exception while launching: ${e && e.message ? e.message : e}` };
  }
  const result = assessProbe(turn);
  return { ...result, turn, ms: now() - t0 };
}
