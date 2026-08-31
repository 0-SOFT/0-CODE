// lib/step-instruction.mjs — the single source of truth about the step instruction and its
// freshness (v1.7.0).
//
// `next_step_prompt` in docs/STATE.md is a CACHE of an instruction. Its real source is where the
// loop actually stands: which version, which stage, which prompt file — read against the roadmap.
// A cache with no invalidation drifts away from its source by construction, and this one drifted
// silently: a live project spent dozens of iterations running an instruction written two versions
// earlier, one that announced a blocker while STATE.blockers was empty.
//
// Both halves of the invariant live here so they cannot disagree with each other:
//   - what "where the loop stands" means            → POSITION_FIELDS
//   - how the passport is minted when writing STATE → stampFor()   (lib/update-state.mjs)
//   - how it is checked when reading STATE          → checkFreshness() (core/gates.mjs)
//
// Why lib/ and not core/: the dependency direction in this project is core → lib. The writer
// (lib/update-state.mjs) must not reach up into core, so the shared concept lives down here.

// The fields that say where the loop stands, mapped to their names inside the passport.
// Change any of them and the previous instruction describes a position that no longer exists.
export const POSITION_FIELDS = {
  current_version: 'version',
  current_stage: 'stage',
  current_prompt_file: 'prompt_file',
};

// A semantic version anywhere in free text. Used only for instructions with no passport — that is,
// ones written before v1.7.0 or edited by hand.
const SEMVER = /\d+\.\d+\.\d+/g;

export function isBlank(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

function same(a, b) {
  return String(a ?? '') === String(b ?? '');
}

// The passport of an instruction, minted from the state it was written into. Callers pass `at`
// rather than reading the clock here, so the module stays pure and testable.
export function stampFor(state, { at } = {}) {
  const st = state && typeof state === 'object' ? state : {};
  const stamp = {};
  for (const [field, metaKey] of Object.entries(POSITION_FIELDS)) {
    stamp[metaKey] = st[field] ?? null;
  }
  stamp.at = at ?? null;
  return stamp;
}

// Is the recorded instruction still describing the position the loop is in?
//
// Returns one of four verdicts:
//   empty      — there is no instruction; the caller substitutes a generic one
//   fresh      — a passport is present and matches the live position
//   stale      — the instruction was written for a different position; it must not be handed out
//   unverified — no passport and nothing to check against (an old project, or a hand edit)
//
// The heuristic for passport-less instructions is deliberately conservative: it only calls an
// instruction stale when the text names versions AND the live version is not among them. Naming a
// neighbouring version ("compare with how 1.5.0 behaved") is not drift.
export function checkFreshness(state) {
  const st = state && typeof state === 'object' ? state : {};
  const text = isBlank(st.next_step_prompt) ? '' : String(st.next_step_prompt);
  if (!text) return { status: 'empty', instruction: '' };

  const meta = (st.next_step_prompt_meta && typeof st.next_step_prompt_meta === 'object' &&
    !Array.isArray(st.next_step_prompt_meta)) ? st.next_step_prompt_meta : null;

  if (meta) {
    const drifted = Object.entries(POSITION_FIELDS)
      .filter(([field, metaKey]) => !same(meta[metaKey], st[field]))
      .map(([field, metaKey]) => `${field}: written for ${format(meta[metaKey])}, now ${format(st[field])}`);
    if (drifted.length) {
      return { status: 'stale', instruction: text, why: `the instruction was written for a different position (${drifted.join('; ')})` };
    }
    return { status: 'fresh', instruction: text };
  }

  const current = st.current_version ? String(st.current_version) : '';
  const mentioned = text.match(SEMVER) || [];
  if (current && mentioned.length && !mentioned.includes(current)) {
    return {
      status: 'stale',
      instruction: text,
      why: `no freshness stamp, and the text speaks of ${[...new Set(mentioned)].join(', ')} while the loop is on ${current}`,
    };
  }
  return { status: 'unverified', instruction: text, why: 'no freshness stamp — written before v1.7.0 or edited by hand' };
}

function format(v) {
  return isBlank(v) ? 'none' : String(v);
}
