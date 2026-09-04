// core/roadmap-review.mjs — the plan gets re-examined, on a schedule the loop keeps (v1.16.0).
//
// THE DEFECT, measured across the whole project rather than suspected:
//
//     versions ever cancelled, dropped or reordered in docs/ROADMAP.md ...... 0
//     versions released .................................................... 25+
//
// Two explanations fit. Either the plan was right twenty-five times running, or it was never checked
// against what the work had since revealed. The second is not close to being the less likely one:
// within the single session that produced this module, the work twice produced knowledge that
// changes the plan — an incident that made live engine runs their own subject, and a finding that
// put every v1.8.0 watchdog back under suspicion — and neither reached the roadmap as a change of
// plan. Both reached the reports.
//
// WHY A SCHEDULE AND NOT A JUDGEMENT. "Re-examine the plan when it needs it" is what the framework
// already said, and its measured yield is zero. An agent deep in a version is the worst-placed
// reader of that version's premise, because the premise is what it is currently executing.
//
// WHY THE INSTRUCTION IS REPLACED, NOT APPENDED. Appended, the directive becomes one more paragraph
// at the end of a long text, and the agent goes on doing what it was doing. The escalation directive
// (core/progress.mjs) had the same problem and the same answer.
//
// WHAT THIS CANNOT DO, stated here so it is not discovered as a disappointment: it makes the agent
// LOOK. It cannot make it SEE. The only honest measure of this module is whether the roadmap starts
// changing — recorded as the falsifier of the decision that chose the threshold
// (docs/decisions/1.16.0_review-threshold.md).

// Ten turns is three to four finished versions at the measured rate of 2–3 turns per version. The
// alternatives, their scores and the reason arithmetic did not settle it are on disk in the decision
// record named above — this constant is the conclusion, not the argument.
export const DEFAULT_REVIEW_EVERY = 10;

function intOr(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// How far the loop has come since the plan was last examined, and whether that is far enough.
//
// A project that has never reviewed counts the whole distance it has travelled: never having looked
// is not the same as having looked recently, and treating it as the latter would let exactly the
// projects that need this most escape it.
export function reviewStatus(state) {
  const st = (state && typeof state === 'object') ? state : {};
  const iteration = Math.max(0, intOr(st.iteration, 0));
  const reviewedAt = Math.max(0, intOr(st.roadmap_reviewed_at_iteration, 0));
  const since = Math.max(0, iteration - reviewedAt);

  // WHAT AN EXPLICIT NULL MEANS, and why it is not the same as an absent field.
  //
  // Since v1.9.0 this framework treats `null`, `0` and a negative number identically for a LIMIT:
  // nobody asked for one, so none is invented. That contract is kept here — writing `null` switches
  // the review off — because an agent reading two fields in one file must not have to remember that
  // they disagree about their own null.
  //
  // An ABSENT field is a different thing, and the difference is the point. A limit that nobody set
  // must not be invented, because a wrong limit stops work that should continue. A practice that
  // nobody set has the opposite failure: its absence is the measured defect, twenty-five versions of
  // it. So absent means "on, at the default", and switching it off stays possible — deliberately,
  // in writing, by the owner.
  const raw = st.roadmap_review_every;
  if (raw === null) return { every: null, since, due: false };
  const every = raw === undefined ? DEFAULT_REVIEW_EVERY : intOr(raw, DEFAULT_REVIEW_EVERY);
  if (!Number.isFinite(every) || every <= 0) return { every: null, since, due: false };

  return { every, since, due: since >= every };
}

// The instruction the agent gets instead of the one it was going to get.
export function reviewDirective(instruction, status) {
  const since = status && Number.isFinite(status.since) ? status.since : 0;
  const every = status && status.every ? status.every : DEFAULT_REVIEW_EVERY;
  return [
    '[ROADMAP REVIEW — this turn, before anything else]',
    `${since} turns have passed since docs/ROADMAP.md was last checked against what has actually ` +
      `been built (the threshold is ${every}). Measured across this project's history: no version ` +
      'has EVER been cancelled, dropped or reordered in the roadmap. A plan that never changes ' +
      'across twenty-five releases was either perfect or unexamined.',
    '',
    'Read the remaining versions in docs/ROADMAP.md against what the finished work has since shown.',
    'For each one still ahead, answer: is it still the right thing, in the right order, for the ' +
      'right reason? Has anything learned since made a version unnecessary, or revealed one that is ' +
      'missing? Act on the answer — edit the roadmap.',
    '',
    'Then record the outcome in the same patch:',
    '  roadmap_reviewed_at_iteration: <the current iteration>',
    '  roadmap_review_note: "<what you changed, or — if nothing — WHY the plan still holds, ' +
      'naming what you checked>"',
    'A note that says the plan is fine without saying what was examined is refused on the way in: ' +
      'a review that cannot fail is not a review.',
    '',
    '[THE WORK THIS INTERRUPTS — return to it once the review is recorded]',
    String(instruction || ''),
  ].join('\n');
}

export default { DEFAULT_REVIEW_EVERY, reviewStatus, reviewDirective };
