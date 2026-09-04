// core/decision-record.mjs — a decision that can be checked, not just admired (v1.16.0).
//
// THE DEFECT THIS EXISTS FOR, measured across the project rather than asserted:
//
//     version prompts carrying a brainstorm ......... 21 of 52  (40 %)
//     reports naming a rejected alternative ......... 11 of 72  (15 %)
//
// In 85 % of the work delivered, not one alternative was ever named. A reader — the next agent
// included — has no way to tell a decision chosen from several from one taken first.
//
// IT IS NOT LAZINESS, and saying so matters for the design. Where a prompt asked for a brainstorm,
// the brainstorm is there and it is substantial. The practice lives in a DOCUMENT rather than in a
// MECHANISM, so it switches on when instructed and off when not. Observed on the author inside one
// session: choosing the liveness evidence for the loop lock went through four options, one of them
// measured and rejected; choosing a process identity an hour later took the first thing that came to
// mind, with no alternative named at all. Same agent, same day, same care — different instruction.
//
// WHAT THIS DELIBERATELY IS NOT. Not a requirement to brainstorm every decision: a rite performed on
// the choice of a variable name is a rite that will be performed emptily on the choice that mattered.
// It is a shape for the decisions that change how something is built, plus one property that cannot
// be faked away — the ABSENCE of a record for the version in flight is visible on every turn, so a
// decision taken flat can no longer look exactly like a decision taken carefully.
//
// THE ONE RULE THAT IS ARCHITECTURAL, not stylistic: THE SCORE IS NEVER STORED. A written score is a
// copy of numbers that live three lines above it, and a copy with no invalidation drifts from its
// source by construction — the defect v1.7.0 and v1.14.0 were each spent on. It is computed on read,
// and a record that carries one is refused rather than tidied up, because a number somebody wrote by
// hand is exactly the thing that will later disagree with its own parts.
//
// No I/O in the validator: parsing a file is a separate function, so the rules can be tested without
// a filesystem and a driver decides when to look.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from '../lib/yaml-mini.mjs';
import { isSubstantiveReason } from './permission-decision.mjs';

// Two options is a fork, and flat thinking hides in forks: the second option is usually there to
// make the first one look chosen. Three is the smallest number that forces a comparison.
export const MIN_OPTIONS = 3;

const SCALE_MIN = 1;
const SCALE_MAX = 10;
const SCALES = ['impact', 'confidence', 'cost'];

// The priority score. Deliberately the simplest formula that expresses the trade-off: what it is
// worth, how sure we are, against what it takes. A more elaborate formula would manufacture an
// appearance of precision on top of inputs that are judgement.
export function scoreOf(option) {
  const o = option && typeof option === 'object' ? option : {};
  const impact = Number(o.impact);
  const confidence = Number(o.confidence);
  const cost = Number(o.cost);
  if (!Number.isFinite(impact) || !Number.isFinite(confidence) || !Number.isFinite(cost) || cost <= 0) {
    return null;
  }
  return Math.round((impact * confidence / cost) * 100) / 100;
}

// Options in descending order of score, each with the score attached to the RETURNED copy — never
// to the record itself.
export function rankOptions(record) {
  const options = (record && Array.isArray(record.options)) ? record.options : [];
  return options
    .map((o) => ({ id: o && o.id, summary: o && o.summary, score: scoreOf(o) }))
    .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
}

function inScale(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= SCALE_MIN && n <= SCALE_MAX;
}

// Check one record. Returns { ok, problems } and never throws: a malformed record must be reported
// to whoever wrote it, not turned into a crash in a loop driver.
export function validateDecision(record) {
  const problems = [];
  const r = (record && typeof record === 'object' && !Array.isArray(record)) ? record : null;
  if (!r) return { ok: false, problems: ['this is not a decision record — expected an object with options'] };
  if (r.parse_error) {
    return {
      ok: false,
      problems: [
        'the file exists but its frontmatter could not be read. lib/yaml-mini.mjs supports scalars, ' +
        'quoted strings, block lists and nested objects — but NOT folded or literal blocks (`>` and ' +
        '`|`). Keep every value on one line and put the reasoning in the body below the frontmatter.',
      ],
    };
  }

  for (const field of ['decision', 'question', 'chosen']) {
    if (!String(r[field] || '').trim()) problems.push(`${field} is missing`);
  }

  const options = Array.isArray(r.options) ? r.options : [];
  if (options.length < MIN_OPTIONS) {
    problems.push(
      `only ${options.length} option(s): at least ${MIN_OPTIONS} are required, because two options ` +
      'are a fork and the second one is usually there to make the first look chosen');
  }

  const seen = new Set();
  for (const [i, raw] of options.entries()) {
    const o = (raw && typeof raw === 'object') ? raw : {};
    const id = String(o.id || '').trim() || `#${i + 1}`;
    if (seen.has(id)) problems.push(`option ${id} appears twice — a ranking needs distinct things to rank`);
    seen.add(id);
    if (!String(o.id || '').trim()) problems.push(`option ${id} has no id`);
    if (!String(o.summary || '').trim()) problems.push(`option ${id} has no summary`);

    for (const scale of SCALES) {
      if (!inScale(o[scale])) {
        problems.push(`option ${id}: ${scale} must be a number from ${SCALE_MIN} to ${SCALE_MAX}, got ${JSON.stringify(o[scale])}`);
      }
    }
    // A number with nothing behind it is an opinion wearing a digit, and three of them multiplied
    // together look like arithmetic.
    if (!String(o.basis || '').trim()) {
      problems.push(`option ${id}: no basis — say what the numbers rest on, a measurement or a named assumption`);
    }
    if ('score' in o) {
      problems.push(
        `option ${id} carries a stored score: the score is computed from impact, confidence and cost ` +
        'and must never be written down, or it will one day disagree with them');
    }

    const isChosen = String(r.chosen || '') === String(o.id || '');
    if (!isChosen && !String(o.rejected_because || '').trim()) {
      problems.push(`option ${id} was not chosen but does not say why it lost`);
    }
    if (isChosen && String(o.rejected_because || '').trim()) {
      problems.push(`option ${id} was chosen and also carries a reason for losing — one of the two is wrong`);
    }
  }

  if (String(r.chosen || '').trim() && options.length && !seen.has(String(r.chosen).trim())) {
    problems.push(`chosen "${r.chosen}" is not one of the options`);
  }

  // The check for "a real reason or a brush-off" already exists for the safety guard's confirmations
  // (core/permission-decision.mjs). Writing a second one here would be the drift class this project
  // keeps closing: two implementations of one judgement, free to disagree.
  if (!isSubstantiveReason(r.what_would_disprove)) {
    problems.push(
      'what_would_disprove is missing or is a brush-off: name what would show the chosen option to ' +
      'be wrong, specifically enough to be checked');
  }

  return { ok: problems.length === 0, problems };
}

// Read a record off disk. Null for anything that is not one — an absent file, a file without
// frontmatter, unreadable YAML. An observer that can crash a turn is not an observer.
export function parseDecision(file) {
  try {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, 'utf8');
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return null;
    const record = parseYaml(m[1]);
    return (record && typeof record === 'object') ? { ...record, file } : null;
  } catch { return null; }
}

// Does the version in flight have a record? This is what makes the absence visible: a driver asks
// every turn, and prints the answer beside the rest of the machine truth. Until now a decision taken
// flat looked exactly like one taken carefully, which is how 85 % of the work came to name no
// alternative at all.
export function findDecisionFor(projectDir, version, { dir = join('docs', 'decisions') } = {}) {
  const v = String(version || '').trim();
  if (!v) return null;
  const root = join(projectDir, dir);
  let names = [];
  try { names = readdirSync(root); } catch { return null; }
  const match = names.find((n) => n.startsWith(`${v}_`) && n.endsWith('.md'));
  if (!match) return null;
  const file = join(root, match);
  const record = parseDecision(file);
  // A file that exists but cannot be read is NOT the same as no file, and must not be reported as
  // one. Found while writing the first record by hand: it used YAML folded scalars (`>-`), which
  // lib/yaml-mini.mjs deliberately does not support, and the record silently became "none" — a
  // written decision that looked exactly like a decision nobody took.
  return record || { file, decision: match, options: [], parse_error: true };
}

// One line for the continuation header. Says what is there, or that nothing is — silence would put
// us back where we started.
export function summariseDecision(found, version) {
  if (!found) {
    return `decision record: none for ${version || 'this version'} — if this version chooses between ` +
      'ways of building something, write one under docs/decisions/ before choosing';
  }
  const check = validateDecision(found);
  const ranked = rankOptions(found);
  const best = ranked.find((o) => o.score !== null);
  const head = `decision record: ${found.file} (${(found.options || []).length} options, chosen ${found.chosen || '?'}`;
  const top = best ? `, best by score ${best.id} at ${best.score}` : '';
  return check.ok
    ? `${head}${top})`
    : `${head}${top}) — INVALID: ${check.problems[0]}`;
}

export default {
  MIN_OPTIONS, scoreOf, rankOptions, validateDecision, parseDecision, findDecisionFor,
  summariseDecision,
};
