// core/acceptance.mjs — an acceptance criterion that cannot quietly stay open (v1.18.0).
//
// THE DEFECT, found by the roadmap review shipped one version earlier, on its very first run:
//
//     open acceptance criteria across versions declared RELEASED ......... 46
//       saying out loud that they were not met ..........................  2
//       saying nothing .................................................. 44
//
// From the roadmap alone there is no way to tell a version that fell short of its own bar from one
// where somebody forgot a tick. Both look identical, and both look fine.
//
// THE PRICE OF THAT SILENCE, demonstrated the same day by a different mechanism. v0.9.0 has carried
// an open criterion — "the >=80 % threshold for lines AND branches is met" — since the day it was
// released. The first real audit run (v1.17.0, finding P1-001) rediscovered exactly that, four
// versions later: the coverage gate had never checked branches at all, and the two files that decide
// whether the loop continues and whether a dangerous command runs sat at 12.5 %. The roadmap knew.
// Nobody read it.
//
// WHY THE MARKER IS A SHAPE AND NOT A WORD. This module is published, the export guard refuses
// Cyrillic, and a target project's roadmap may be written in any language — so matching on "NOT
// DONE" or its translations would either break the export or quietly stop working outside English.
// The rule is therefore structural: an open criterion excuses itself by opening with a bold segment
// that ends in a colon and is followed by a reason. Measured against this project's real roadmap,
// that shape accepts exactly the two criteria deliberately left open and none of the forty-four
// silent ones — including one that is bold but makes a claim rather than an excuse.
//
// WHERE THE CHECK LIVES was decided in the open (docs/decisions/1.18.0_criteria-guard.md), and the
// arithmetic disagreed with the author's instinct: a barrier in lib/update-state.mjs scored 18
// against 28 for a smoke guard, because it would have coupled the state tool to the format of a
// document it has no other reason to know. This module is the shared part either would have used.

import { readFileSync, existsSync } from 'node:fs';
import { isSubstantiveReason } from './permission-decision.mjs';

// A version heading. Everything after the version number is prose and may be in any language, so
// nothing is read from it.
const HEADING = /^##\s+(v[\d.]+\S*)/;

// HOW "RELEASED" IS DECIDED, and why not from the heading. The obvious rule — look for the word
// "released" in the title — fails twice over: this module is published and the export guard refuses
// Cyrillic, so the Russian words this project's own headings use could not appear here; and a target
// project may write its headings in any language at all.
//
// What IS language-neutral is the status word. Measured across this project's 32 versions, every one
// carries a status line whose value is an English word in backticks: released 20, completed 10,
// withdrawn 1, planned 1. So the label may be written in any language and only the value is read.
const STATUS = /^\s*-\s+\*\*[^*]+:\*\*\s*`([a-z_]+)`/i;
export const RELEASED_STATUSES = ['released', 'completed', 'done', 'shipped'];

const CRITERION = /^\s*-\s\[([ xX])\]\s*(.*)$/;

// The excuse: a bold opening ending in a colon, then a reason. No language in it.
const EXCUSE = /^\s*-\s\[\s\]\s+\*\*([^*]+):\*\*\s*(\S.*)$/;

// Does this line excuse itself, and with what reason.
export function isExcused(line) {
  const m = EXCUSE.exec(String(line || ''));
  if (!m) return { ok: false, reason: null };
  const reason = m[2].trim();
  // A marker with a brush-off behind it is the same defect wearing a label, so the reason goes
  // through the same substance check the safety guard applies to its confirmations. One judgement,
  // one implementation.
  return { ok: isSubstantiveReason(reason), reason };
}

// Versions and their acceptance criteria. Line endings are normalised first: this project's roadmap
// is stored with CRLF, and a parser that only handled LF would report every Windows checkout as
// having no criteria at all — silence again, one layer down.
export function parseRoadmap(text) {
  const src = typeof text === 'string' ? text : '';
  if (!src.trim()) return [];
  const versions = [];
  let current = null;
  let last = null;                      // the criterion still being read, for wrapped lines
  for (const line of src.split(/\r?\n/)) {
    const h = HEADING.exec(line);
    if (h) {
      current = { name: h[1], released: false, status: null, criteria: [] };
      versions.push(current);
      last = null;
      continue;
    }
    if (!current) continue;
    // The FIRST status word wins: a body may mention other statuses in prose, and the version's own
    // claim is the one it opens with.
    if (current.status === null) {
      const s = STATUS.exec(line);
      if (s) {
        current.status = s[1].toLowerCase();
        current.released = RELEASED_STATUSES.includes(current.status);
      }
    }
    const c = CRITERION.exec(line);
    if (c) {
      const indent = line.length - line.trimStart().length;
      last = { done: c[1] !== ' ', text: c[2].trim(), line, indent };
      current.criteria.push(last);
      continue;
    }
    // A CRITERION THAT WRAPS IS STILL ONE CRITERION. Found on real data rather than imagined: the
    // roadmap wraps at about a hundred characters, so a reason routinely continues on the next
    // indented line. Judging only the first line, the guard called one of the two deliberately
    // excused criteria "silent" — because the words that made its reason substantial were on the
    // line below. A rule that only reads the first line is a rule about formatting, not about
    // meaning.
    if (last && line.trim() && !/^\s*[-*] /.test(line)) {
      const indent = line.length - line.trimStart().length;
      if (indent > last.indent) {
        last.text = `${last.text} ${line.trim()}`;
        last.line = `${last.line} ${line.trim()}`;
        continue;
      }
    }
    last = null;                        // anything else ends the criterion
  }
  return versions;
}

export function readRoadmap(file) {
  try {
    if (!existsSync(file)) return [];
    return parseRoadmap(readFileSync(file, 'utf8'));
  } catch { return []; }
}

// Every criterion that is open, belongs to a version claiming to be released, and says nothing about
// why. A planned version contributes nothing: an open criterion is what a plan is made of.
export function silentCriteria(versions) {
  if (!Array.isArray(versions)) return [];
  const out = [];
  for (const v of versions) {
    if (!v || !v.released || !Array.isArray(v.criteria)) continue;
    for (const c of v.criteria) {
      if (c.done) continue;
      if (isExcused(c.line).ok) continue;
      out.push({ version: v.name, text: c.text, line: c.line });
    }
  }
  return out;
}

// One line for a guard or a report. Null when there is nothing to say.
export function summariseSilent(silent) {
  if (!Array.isArray(silent) || silent.length === 0) return null;
  const byVersion = new Map();
  for (const s of silent) byVersion.set(s.version, (byVersion.get(s.version) || 0) + 1);
  const parts = Array.from(byVersion, ([v, n]) => `${v}: ${n}`).join(', ');
  return `${silent.length} acceptance criteria are open with no reason given, in versions declared `
    + `released (${parts}). Close each with evidence, or say in the criterion itself that it was not `
    + 'met and why.';
}

export default {
  RELEASED_STATUSES, parseRoadmap, readRoadmap, isExcused, silentCriteria, summariseSilent,
};
