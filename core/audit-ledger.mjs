// core/audit-ledger.mjs — findings an audit can be held to, instead of an audit's opinion (v1.17.0).
//
// THE ROOT DIFFICULTY, named before any code was written. `/productionauditloop` is supposed to run
// until P0 + P1 + P2 = 0. That condition cannot rest on the agent's word: an agent that can declare
// the loop finished will finish it by declaring, and the declaration will be sincere — it is very
// easy to believe you are done. So the findings have to be countable by something that is not the
// agent.
//
// WHERE THEY LIVE was chosen in the open (docs/decisions/1.17.0_ledger-format.md), and the
// measurement overturned the assumption it started from. Across the ten existing `docs/todo` files:
//
//     checklist lines .................................... 231
//     matching the tidy `- [ ] **P0-001**` shape .........  19
//     not matching ....................................... 212   (92 %)
//     findings carrying a file:line ......................  14
//
// The mismatches are meaningful rather than sloppy — `**P2-002 + P2-003**` is one fix closing two
// findings, `**P2-011/P3-011**` is a finding whose level depends on where you stand. The format was
// never meant for counting. A parser generous enough to read it would produce a number people
// believe, which is worse than no number.
//
// So the ledger is a machine-readable HEAD on the file the four audit templates already require,
// `docs/todo/<version>.md`, with the prose below it left to humans. One artefact, not a new one, and
// — the point of choosing this over a separate JSON file — one home for the state of a finding.
// Two homes drift; that is the class versions 1.7.0, 1.7.1 and 1.14.0 were each spent on.
//
// The state of a finding lives ONLY in the head. The prose below explains and argues, and asserts
// nothing about state, or the single home would have become two inside one file.
//
// WHY ONE CLEAN ROUND IS ENOUGH, decided here rather than left implicit. A clean round already runs
// AFTER the fixes it is verifying, so a second one with no fixes between them can only find what the
// first round missed. That is a question about coverage, not about repetition, and it is answered by
// requiring coverage — not by paying for another round of turns.

import { readFileSync, existsSync } from 'node:fs';
import { parseYaml } from '../lib/yaml-mini.mjs';
import { isSubstantiveReason } from './permission-decision.mjs';

// P3 is deliberately outside the exit condition: the project's owner said plainly that P3 findings
// are rarely worth spending turns on, and a loop that cannot end is worse than a P3 that survives.
export const BLOCKING_LEVELS = ['P0', 'P1', 'P2'];
export const LEVELS = [...BLOCKING_LEVELS, 'P3'];
export const STATES = ['open', 'fixed', 'rejected'];
export const CLOSED_STATES = ['fixed', 'rejected'];
export const AUDIT_KINDS = ['architecture', 'codebase', 'frontend', 'tests'];

const idLevel = (id) => {
  const m = /^(P[0-3])-/.exec(String(id || ''));
  return m ? m[1] : null;
};

// Check one ledger. Returns { ok, problems }; never throws.
export function validateLedger(ledger) {
  const problems = [];
  const l = (ledger && typeof ledger === 'object' && !Array.isArray(ledger)) ? ledger : null;
  if (!l) return { ok: false, problems: ['this is not an audit ledger — expected an object with findings'] };

  if (!AUDIT_KINDS.includes(String(l.audit || ''))) {
    problems.push(`audit must be one of ${AUDIT_KINDS.join(', ')}, got ${JSON.stringify(l.audit)}`);
  }
  if (!Array.isArray(l.findings)) problems.push('findings must be a list, even when it is empty');

  // COVERAGE IS REQUIRED OF EVERY LEDGER, not only of the clean ones. An audit that looked at
  // nothing finds nothing, and zero findings then reads exactly like a clean pass. Asking for
  // coverage only when the answer is zero would make it a line written in order to reach zero.
  if (!isSubstantiveReason(l.coverage)) {
    problems.push(
      'coverage is missing or is a brush-off: say what this audit actually examined. An audit that '
      + 'looked at nothing also finds nothing, and without coverage the two are indistinguishable');
  }

  const seen = new Set();
  for (const [i, raw] of (Array.isArray(l.findings) ? l.findings : []).entries()) {
    const f = (raw && typeof raw === 'object') ? raw : {};
    const id = String(f.id || '').trim() || `#${i + 1}`;
    if (seen.has(id)) problems.push(`finding ${id} appears twice — a count needs distinct things to count`);
    seen.add(id);

    if (!String(f.id || '').trim()) problems.push(`finding ${id} has no id`);
    if (!LEVELS.includes(String(f.level || ''))) {
      problems.push(`finding ${id}: level must be one of ${LEVELS.join(', ')}, got ${JSON.stringify(f.level)}`);
    }
    // `P2-011/P3-011` in the old files is exactly this: an id and a level that disagree about how
    // serious something is. Whatever the answer, it has to be one answer.
    const fromId = idLevel(f.id);
    if (fromId && f.level && fromId !== String(f.level)) {
      problems.push(`finding ${id}: the id says ${fromId} and the level says ${f.level} — pick one`);
    }
    if (!String(f.summary || '').trim()) problems.push(`finding ${id} has no summary`);
    // A finding with nowhere to look is not necessarily wrong — some are about an absence — but it
    // has to say so, or "no location" becomes the cheapest way to record a finding.
    if (!String(f.where || '').trim()) {
      problems.push(`finding ${id}: no place. Give file:line, or say why there is none`);
    }
    if (!STATES.includes(String(f.state || ''))) {
      problems.push(`finding ${id}: state must be one of ${STATES.join(', ')}, got ${JSON.stringify(f.state)}`);
    }
    // "Fixed" with nothing behind it is the agent's word again in a different hat, which is the very
    // thing the ledger replaces. Same substance check as everywhere else in this framework.
    if (CLOSED_STATES.includes(String(f.state || '')) && !isSubstantiveReason(f.evidence)) {
      problems.push(
        `finding ${id} is marked ${f.state} with no substantive evidence: say what shows it — a test `
        + 'that failed before and passes now, a measurement, the commit that removed the code');
    }
  }

  return { ok: problems.length === 0, problems };
}

// How many findings are open, by level, plus the number that block the loop.
export function countFindings(ledger) {
  const open = Object.fromEntries(LEVELS.map((lv) => [lv, 0]));
  const closed = Object.fromEntries(LEVELS.map((lv) => [lv, 0]));
  const findings = (ledger && Array.isArray(ledger.findings)) ? ledger.findings : [];
  for (const f of findings) {
    const level = LEVELS.includes(String(f && f.level)) ? String(f.level) : null;
    if (!level) continue;
    if (CLOSED_STATES.includes(String(f.state))) closed[level] += 1;
    else open[level] += 1;
  }
  const blocking = BLOCKING_LEVELS.reduce((n, lv) => n + open[lv], 0);
  return { open, closed, blocking, total: findings.length };
}

// Is this one audit a clean pass, and if not, why not. A ledger that does not validate is never
// clean: proving nothing is not the same as finding nothing.
export function isClean(ledger) {
  const check = validateLedger(ledger);
  if (!check.ok) return { clean: false, why: `the ledger is not valid: ${check.problems[0]}` };
  const { blocking, open } = countFindings(ledger);
  if (blocking > 0) {
    const parts = BLOCKING_LEVELS.filter((lv) => open[lv] > 0).map((lv) => `${lv}: ${open[lv]}`);
    return { clean: false, why: `${blocking} blocking findings still open (${parts.join(', ')})` };
  }
  return { clean: true, why: 'no P0, P1 or P2 findings are open, and the coverage says what was examined' };
}

// The loop's verdict across every kind of audit. Finished only when all four are clean in this
// round: a codebase audit cannot vouch for the tests, and an audit that never ran is not a clean one.
export function loopVerdict(ledgers) {
  const list = Array.isArray(ledgers) ? ledgers.filter(Boolean) : [];
  const byKind = new Map();
  for (const l of list) if (l && l.audit) byKind.set(String(l.audit), l);

  const missing = AUDIT_KINDS.filter((k) => !byKind.has(k));
  const unclean = [];
  let blocking = 0;

  for (const kind of AUDIT_KINDS) {
    const l = byKind.get(kind);
    if (!l) continue;
    const verdict = isClean(l);
    if (!verdict.clean) unclean.push(`${kind}: ${verdict.why}`);
    if (validateLedger(l).ok) blocking += countFindings(l).blocking;
  }

  if (missing.length) {
    return {
      done: false, blocking, missing, unclean,
      why: `these audits have no ledger for this round: ${missing.join(', ')}`,
    };
  }
  if (unclean.length) {
    return { done: false, blocking, missing, unclean, why: unclean.join(' | ') };
  }
  return {
    done: true, blocking: 0, missing: [], unclean: [],
    why: 'every audit is clean this round, and each says what it examined',
  };
}

// Read a ledger out of the head of a todo file. Null for a file that has none — and null must stay
// distinguishable from an empty ledger, because a todo file written before this version has no head
// at all, and reading it as "no findings" would end the loop on a document from years ago.
export function parseLedger(file) {
  try {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, 'utf8');
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return null;
    const led = parseYaml(m[1]);
    if (!led || typeof led !== 'object' || !('findings' in led)) return null;
    return { ...led, file };
  } catch { return null; }
}

export default {
  BLOCKING_LEVELS, LEVELS, STATES, CLOSED_STATES, AUDIT_KINDS,
  validateLedger, countFindings, isClean, loopVerdict, parseLedger,
};
