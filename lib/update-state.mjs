#!/usr/bin/env node
// update-state.mjs — atomically deep-merge a JSON patch into the YAML
// frontmatter of a Markdown file (STATE.md).
//
// Usage:  echo '{"iteration":5}' | node update-state.mjs <path-to-STATE.md>
// Exit:   0 on success, non-zero on failure.
//
// Parser and serialiser live in the shared ./yaml-mini.mjs module; backup rotation lives in
// ./backup.mjs (single sources of truth).

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { argv, exit, stderr, stdin } from 'node:process';
import { resolve } from 'node:path';
import { parseYaml, serializeYaml } from './yaml-mini.mjs';
import { rotateBackups } from './backup.mjs';
import { POSITION_FIELDS, isBlank, stampFor } from './step-instruction.mjs';
import { isSubstantiveReason } from '../core/permission-decision.mjs';

if (argv.length < 3) {
  stderr.write('Usage: update-state.mjs <path>\n');
  exit(2);
}

const path = resolve(argv[2]);

// Read patch from stdin (one JSON object)
let patchText = '';
for await (const chunk of stdin) patchText += chunk;
patchText = patchText.trim();
if (!patchText) {
  stderr.write('update-state: empty patch on stdin\n');
  exit(1);
}

let patch;
try { patch = JSON.parse(patchText); }
catch (e) { stderr.write(`update-state: invalid patch JSON: ${e.message}\n`); exit(1); }
if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
  stderr.write('update-state: patch must be a JSON object\n');
  exit(1);
}

// Read existing file
let raw;
try { raw = readFileSync(path, 'utf8'); }
catch (e) { stderr.write(`update-state: cannot read ${path}: ${e.message}\n`); exit(1); }

const m = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/);
if (!m) {
  stderr.write('update-state: no YAML frontmatter found\n');
  exit(1);
}
const openMarker = m[1];
const yamlText = m[2];
const closeMarker = m[3];
const body = raw.slice(m[0].length);

// Parse YAML → JS object
let frontmatter;
try { frontmatter = parseYaml(yamlText); }
catch (e) { stderr.write(`update-state: parse error: ${e.message}\n`); exit(1); }

// --- v1.7.0: the step instruction must not be able to go stale --------------------------------
//
// `next_step_prompt` is a CACHE of an instruction whose real source is where the loop actually
// stands: current_version + current_stage + current_prompt_file, read against the roadmap. A cache
// with no invalidation drifts away from its source by construction, not by accident — and here it
// drifted silently. A live project ran for dozens of iterations on an instruction written two
// versions earlier, one that announced a blocker while STATE.blockers was empty.
//
// Two guards live on the WRITE side, because this is the moment the drift is born:
//   1. the barrier — moving the loop without saying what to do next is refused;
//   2. the stamp   — the passport of the instruction is written by this tool and never by hand,
//                    because a field maintained by hand would just be a second cache to drift.

// Which fields count as "where the loop stands" is decided in ./step-instruction.mjs — the same
// module the freshness check reads, so the writer and the reader cannot disagree.
const moved = Object.keys(POSITION_FIELDS).filter(
  k => k in patch && String(patch[k] ?? '') !== String(frontmatter[k] ?? ''));

// Refusing rather than warning is deliberate: a warning in a log is read by nobody, while the price
// of this drift is dozens of wasted iterations. Clearing the instruction on purpose stays possible
// — pass "next_step_prompt": null, which means "work it out from STATE" (the contract pinned down
// in v1.3.0). There is no bypass flag on purpose: a bypass would recreate the defect.
//
// Neither loop driver is affected: the Stop hook writes iteration / last_session_id / session_count
// and the supervisor adds budget_metrics and blockers — none of them touch a position field. The
// barrier only ever sees a patch written by the orchestrating agent.
if (moved.length && !('next_step_prompt' in patch)) {
  stderr.write([
    `update-state: the patch moves ${moved.join(', ')} but carries no next_step_prompt.`,
    'The step instruction describes where the loop stands, so moving the loop without rewriting it',
    'leaves the next iteration running on an instruction for a position that no longer exists.',
    'Add "next_step_prompt": "<what to do now>" to the same patch, or "next_step_prompt": null to',
    'hand the decision back to STATE.',
    '',
  ].join('\n'));
  exit(3);
}

// --- v1.16.0: a review that cannot fail is not a review ---------------------------------------
//
// The roadmap review is enforced by the same barrier as the step instruction, and for the same
// reason: the moment the drift is born is the moment of the write. Measured across this project's
// history, no version has ever been cancelled, dropped or reordered in the roadmap across
// twenty-five-plus releases — so the failure mode to guard against is not "no review happened", it
// is "a review happened and concluded nothing, in one word".
//
// Marking the plan as reviewed therefore has to carry what was examined. The substance check is the
// SAME one the safety guard uses for confirmations (core/permission-decision.mjs): one judgement,
// one implementation, no room for two of them to disagree about what counts as an answer.
if ('roadmap_reviewed_at_iteration' in patch && !isSubstantiveReason(patch.roadmap_review_note)) {
  stderr.write([
    'update-state: the patch marks the roadmap as reviewed but carries no substantive',
    'roadmap_review_note.',
    'A review is only worth the turn it costs if it says what came of it: what you changed in',
    'docs/ROADMAP.md, or — if you changed nothing — WHY the plan still holds and what you checked',
    'to be sure. "All fine" is not an outcome; across this project 25+ versions were released and',
    'not one was ever cancelled, dropped or reordered, which is the state this guard exists to end.',
    '',
  ].join('\n'));
  exit(3);
}

// Deep merge
const merged = deepMerge(frontmatter, patch);

// --- v1.14.0: the clock the silence watchdog reads --------------------------------------------
//
// core/gates.mjs stated that this tool "has written last_action_at since the first version". No
// line of it ever did: the field was filled in by hand, in whatever patch an agent happened to
// remember it in. So the v1.8.0 silence watchdog — the thing that tells the loop "STATE has not
// changed for N minutes" — was reading a hand-maintained cache, which is the exact defect class
// v1.7.0 exists to prevent, reintroduced somewhere else.
//
// Measured on this repository while writing this: two patches were applied in a row and the field
// stayed six hours old, while the watchdog announced 355 minutes of silence on a project that had
// just changed twice. A watchdog that cannot be believed is worse than none, because it is.
//
// THE TRAP THIS AVOIDS, and why the rule is derived rather than declared. Both loop drivers write
// to STATE on EVERY turn. If their bookkeeping wound the clock, the watchdog could never fire — it
// would be barking at its own tail, the same way core/turn-progress.mjs explains for the progress
// detector. A flag would have left it to a driver to declare itself honestly; deriving the answer
// from what the patch actually touches leaves nothing to declare.
const BOOKKEEPING = new Set(['iteration', 'last_session_id', 'session_count', 'budget_metrics']);
const touchesWork = Object.keys(patch).some(k => !BOOKKEEPING.has(k));
if (touchesWork && !('last_action_at' in patch)) {
  merged.last_action_at = new Date().toISOString();
}

// The freshness stamp. Taken from the MERGED state rather than from the patch: the patch on its own
// describes only half of the new position. `at` is there for a human reading the file — the
// freshness check itself compares the position fields (see core/gates.mjs).
if ('next_step_prompt' in patch) {
  if (isBlank(merged.next_step_prompt)) {
    delete merged.next_step_prompt_meta;          // an empty instruction has nothing to validate
  } else {
    merged.next_step_prompt_meta = stampFor(merged, { at: new Date().toISOString() });
  }
}

// Serialize back
const newYaml = serializeYaml(merged);
const out = `${openMarker}${newYaml}${closeMarker}${body}`;

// Back up before writing — a ring buffer (see ./backup.mjs)
rotateBackups(path);

// Atomic write: temp file → rename
const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
try {
  writeFileSync(tmp, out, 'utf8');
  renameSync(tmp, path);
} catch (e) {
  stderr.write(`update-state: write failed: ${e.message}\n`);
  exit(1);
}

exit(0);

// --- helpers ---

function deepMerge(target, source) {
  if (typeof source !== 'object' || source === null) return source;
  if (Array.isArray(source)) return source; // arrays replace, not merge
  const out = { ...(target || {}) };
  for (const k of Object.keys(source)) {
    const sv = source[k];
    const tv = out[k];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) &&
        tv && typeof tv === 'object' && !Array.isArray(tv)) {
      out[k] = deepMerge(tv, sv);
    } else {
      out[k] = sv;
    }
  }
  return out;
}
