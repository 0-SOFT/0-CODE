// Tests for core/translations.mjs — the guard that keeps translated READMEs from drifting silently.
//
// The interesting cases are not "does it hash". They are the three ways a translation can be wrong
// while still looking present in a directory listing: no marker at all, a marker pointing at the
// wrong source, and a marker made from an older README.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DIGEST_LENGTH,
  digestOf,
  readMarker,
  markerFor,
  reviewTranslations,
  staleOnes,
  summariseProblems,
} from '../../core/translations.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('digestOf is stable and the declared length', () => {
  const a = digestOf('hello');
  assert.equal(a.length, DIGEST_LENGTH);
  assert.equal(a, digestOf('hello'));
  assert.notEqual(a, digestOf('hello '));
});

test('digestOf ignores line-ending style', () => {
  // Without this the guard turns red on Windows for everyone who did nothing wrong.
  assert.equal(digestOf('a\r\nb\r\n'), digestOf('a\nb\n'));
});

test('digestOf ignores the release number in the Version header, and nothing else (v1.22.0)', () => {
  // A release changes one digit there; that alone must not make ten translations stale.
  const head = v => `# T\n\n> **Version:** ${v} · MIT licence · zero runtime dependencies\n\nBody.\n`;
  assert.equal(digestOf(head('v1.21.0')), digestOf(head('v1.22.0')));
  // The falsifier named in docs/decisions/1.22.0_version-line-digest.md: the other words of that
  // line still count, and so does a version mentioned anywhere else.
  assert.notEqual(digestOf(head('v1.22.0')), digestOf(head('v1.22.0').replace('MIT', 'GPL')));
  assert.notEqual(digestOf(head('v1.22.0') + 'since v1.9.0\n'), digestOf(head('v1.22.0') + 'since v1.8.0\n'));
});

test('readMarker finds the marker and returns null when there is none', () => {
  assert.deepEqual(readMarker(markerFor('README.md', 'abc123abc123')), {
    source: 'README.md',
    digest: 'abc123abc123',
  });
  assert.equal(readMarker('# just a heading\n'), null);
});

test('a translation made from the current README is current', () => {
  const english = '# title\n\nbody\n';
  const review = reviewTranslations(english, [
    { path: 'README.xx.md', text: markerFor('README.md', digestOf(english)) + '\ntranslated' },
  ]);
  assert.deepEqual(review.results, [{ path: 'README.xx.md', state: 'current' }]);
  assert.deepEqual(staleOnes(review), []);
});

test('the three ways a translation can be wrong are told apart', () => {
  const english = '# title\n';
  const review = reviewTranslations(english, [
    { path: 'a.md', text: 'no marker here' },
    { path: 'b.md', text: markerFor('GUIDELINE.md', digestOf(english)) },
    { path: 'c.md', text: markerFor('README.md', '000000000000') },
  ]);
  assert.deepEqual(
    review.results.map(r => r.state),
    ['no-marker', 'wrong-source', 'stale'],
  );
  const text = summariseProblems(review);
  assert.match(text, /a\.md/);
  assert.match(text, /b\.md/);
  assert.match(text, /c\.md/);
});

test('every translation gets a verdict, including the good ones', () => {
  // A report that only ever lists problems cannot distinguish "all fine" from "nothing was
  // examined" — this project has already shipped one gate that reported success over zero files.
  const english = '# t\n';
  const review = reviewTranslations(english, [
    { path: 'ok.md', text: markerFor('README.md', digestOf(english)) },
    { path: 'bad.md', text: 'nothing' },
  ]);
  assert.equal(review.results.length, 2);
  assert.equal(review.expected, digestOf(english));
});

test('the READMEs actually in this repository all track the current English one', () => {
  // The guard applied to itself. If this fails, a translation was left behind by a README edit —
  // which is exactly the thing the module exists to make impossible to miss.
  const english = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const translations = readdirSync(ROOT)
    .filter(f => /^README\..+\.md$/.test(f))
    .map(f => ({ path: f, text: readFileSync(join(ROOT, f), 'utf8') }));

  assert.ok(translations.length > 0, 'no translated READMEs were found at all');

  const review = reviewTranslations(english, translations);
  assert.equal(
    staleOnes(review).length,
    0,
    'translations out of date with README.md: ' + summariseProblems(review),
  );
});

test('every language advertised in README.md has a file, and every file is advertised', () => {
  // Two failures that look nothing alike from the outside: a link to a translation that does not
  // exist (a 404 for the reader) and a translation nobody links to (work nobody will find).
  const english = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const linked = new Set([...english.matchAll(/\(README\.([\w-]+)\.md\)/g)].map(m => m[1]));
  const present = new Set(
    readdirSync(ROOT)
      .map(f => /^README\.([\w-]+)\.md$/.exec(f))
      .filter(Boolean)
      .map(m => m[1]),
  );

  const missing = [...linked].filter(c => !present.has(c));
  const unlinked = [...present].filter(c => !linked.has(c));
  assert.deepEqual(missing, [], 'README.md links to translations that do not exist');
  assert.deepEqual(unlinked, [], 'translations exist that README.md never links to');
});
