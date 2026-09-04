import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRoadmap, readRoadmap, silentCriteria, isExcused,
} from '../../core/acceptance.mjs';

// v1.18.0. Found by the roadmap review shipped one version earlier, on its first run: across the
// versions this project declares RELEASED, 46 acceptance criteria are open, 2 of them say out loud
// that they were not met, and 44 say nothing. From the roadmap alone there is no way to tell a
// version that fell short of its own bar from one where somebody forgot a tick.
//
// The price of that silence was demonstrated the same day. v0.9.0 has carried an open criterion —
// "the >=80 % threshold for lines AND branches is met" — since it was released. The first real audit
// run rediscovered exactly that, four versions later: the coverage gate had never checked branches
// and two drivers sat at 12.5 %. The roadmap knew. Nobody read it.

const CRLF = (lines) => lines.join('\r\n');

const roadmap = () => CRLF([
  '# ROADMAP',
  '',
  '## v1.0.0 — Something — shipped in this project',
  '',
  '- **Status:** `released`',
  '- **Acceptance:**',
  '  - [x] this one was actually met',
  '  - [ ] this one says nothing at all',
  '  - [ ] **NOT DONE, and here is why:** the stand it needs does not exist in this project',
  '',
  '---',
  '',
  '## v2.0.0 — Something else — still ahead',
  '',
  '- **Status:** `planned`',
  '- **Acceptance:**',
  '  - [ ] a plan is allowed to have open criteria — that is what a plan is',
  '',
  '---',
]);

// The file in this repository is stored with CRLF, which is why the version that wrote this module
// could not search it with multi-line patterns. A parser that only handles LF would report every
// project on Windows as having no criteria at all — silence again, one layer down.
test('the roadmap parses with CRLF line endings', () => {
  const versions = parseRoadmap(roadmap());
  assert.equal(versions.length, 2);
  assert.equal(versions[0].name, 'v1.0.0');
  assert.equal(versions[0].released, true);
  assert.equal(versions[1].released, false);
  assert.equal(versions[0].criteria.length, 3);
});

test('LF-only roadmaps parse identically', () => {
  const lf = roadmap().split('\r\n').join('\n');
  assert.deepEqual(parseRoadmap(lf), parseRoadmap(roadmap()));
});

// The marker is deliberately NOT a word. core/ is published, the export guard refuses Cyrillic, and
// a target project's roadmap may be written in any language — so the rule is a SHAPE: a criterion
// excuses itself with a bold opening that ends in a colon and is followed by a reason. Measured
// against the real roadmap: exactly the 2 deliberate ones pass and all 44 silent ones do not,
// including one that is bold but carries no colon and no reason.
test('a criterion excuses itself by shape, not by a word in any one language', () => {
  assert.equal(isExcused('  - [ ] **NOT DONE, and here is why:** the stand does not exist').ok, true);
  assert.equal(isExcused('  - [ ] plain text with no declaration').ok, false);
  assert.equal(isExcused('  - [ ] **bold but making a claim, not an excuse**').ok, false);
  assert.equal(isExcused('  - [ ] **a colon but no reason:**').ok, false);
});

// A marker with a brush-off behind it would be the same defect wearing a label, so the reason goes
// through the same substance check the safety guard uses on its confirmations.
test('a brush-off behind the marker does not excuse anything', () => {
  for (const weak of ['ok', 'later', 'no', 'fine']) {
    assert.equal(isExcused(`  - [ ] **NOT DONE:** ${weak}`).ok, false, `${weak} must not excuse`);
  }
  assert.equal(isExcused('  - [ ] **NOT DONE:** the hardware it needs is not on this machine').ok, true);
});

test('an excused criterion reports the reason it gave', () => {
  const r = isExcused('  - [ ] **NOT DONE:** the hardware it needs is not on this machine');
  assert.match(r.reason, /hardware/);
});

// --- what the guard actually reports ------------------------------------------------------------

test('only RELEASED versions can have silent criteria — a plan is allowed to be open', () => {
  const silent = silentCriteria(parseRoadmap(roadmap()));
  assert.equal(silent.length, 1, 'the planned version contributes nothing');
  assert.equal(silent[0].version, 'v1.0.0');
  assert.match(silent[0].text, /says nothing at all/);
});

test('a released version whose criteria are all met or excused is clean', () => {
  const clean = CRLF([
    '## v1.0.0 — Something — shipped in this project',
    '- **Status:** `released`',
    '- **Acceptance:**',
    '  - [x] met',
    '  - [ ] **NOT DONE:** the stand it needs does not exist in this project',
    '',
    '---',
  ]);
  assert.deepEqual(silentCriteria(parseRoadmap(clean)), []);
});

// The guard must never be the reason a project cannot be built. A framework project that has no
// roadmap at all, or one shaped differently, has nothing to answer for.
test('no roadmap, or one with no criteria, produces no complaints', () => {
  assert.deepEqual(parseRoadmap(''), []);
  assert.deepEqual(parseRoadmap(null), []);
  assert.deepEqual(silentCriteria(parseRoadmap('# just a heading\n')), []);
  assert.deepEqual(silentCriteria(null), []);
});

test('readRoadmap returns an empty list for a file that is not there', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acc-'));
  try {
    assert.deepEqual(readRoadmap(join(dir, 'absent.md')), []);
    const file = join(dir, 'ROADMAP.md');
    writeFileSync(file, roadmap(), 'utf8');
    assert.equal(readRoadmap(file).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The measurement this version exists for, pinned so that it cannot quietly drift back.
//
// AND WHY IT IS WRITTEN THIS WAY. The first version of this test read docs/ROADMAP.md
// unconditionally — a file the manifest deliberately does NOT publish, because it is the plan for
// developing the framework itself and not part of the product. So it passed in the working tree and
// failed in the published one: the exact blind spot v1.12.0 recorded ('a guard hard-coded a
// development tool that is deliberately not published'), repeated one release later by the same
// author. A test that only holds in the tree it was written in is half a test.
//
// Both trees now assert something real: where the roadmap exists, its numbers are pinned; where it
// does not, the property that matters is that its absence produces no complaints at all.
test('the real roadmap of this project is measured where it exists, and silent where it does not', () => {
  const versions = readRoadmap('docs/ROADMAP.md');
  if (versions.length === 0) {
    assert.deepEqual(silentCriteria(versions), [],
      'a tree without a roadmap has nothing to answer for, and must not be accused of anything');
    return;
  }
  assert.ok(versions.length > 20, 'this project has more than twenty versions on record');
  const released = versions.filter(v => v.released);
  assert.ok(released.length > 15);
  const excused = versions.flatMap(v => v.criteria).filter(c => !c.done && isExcused(c.line).ok);
  assert.ok(excused.length >= 2, 'at least the two criteria left open on purpose must be recognised');
});

// FOUND ON REAL DATA, not imagined. The roadmap wraps at about a hundred characters, so a reason
// routinely continues on the next indented line. Reading only the first line, the guard called one
// of the two deliberately excused criteria "silent" — the words that made its reason substantial
// were on the line below. A rule that reads one line is a rule about formatting, not about meaning.
test("a reason that wraps onto the next line is still one reason", () => {
  const wrapped = CRLF([
    "## v1.0.0 — Something — shipped in this project",
    "- **Status:** `released`",
    "- **Acceptance:**",
    "  - [ ] **NOT DONE:** the live run",
    "    against a real engine, because the previous attempt destroyed an unrelated session",
    "",
    "---",
  ]);
  const [v] = parseRoadmap(wrapped);
  assert.equal(v.criteria.length, 1, "the continuation is part of the criterion, not a new one");
  assert.match(v.criteria[0].text, /destroyed an unrelated session/);
  assert.deepEqual(silentCriteria([v]), [], "and the wrapped reason excuses it");
});

test("a following list item is a new criterion, not a continuation", () => {
  const two = CRLF([
    "## v1.0.0 — Something — shipped in this project",
    "- **Status:** `released`",
    "- **Acceptance:**",
    "  - [ ] **NOT DONE:** the stand it needs does not exist here",
    "  - [ ] a second one that says nothing",
    "",
    "---",
  ]);
  const [v] = parseRoadmap(two);
  assert.equal(v.criteria.length, 2);
  assert.equal(silentCriteria([v]).length, 1);
});
