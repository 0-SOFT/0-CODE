// tests/unit/ignore-policy.test.mjs — the pure half of the ignore policy: rendering, parsing and
// diffing. The behavioural half (does git actually refuse these paths) lives in
// tests/integration/ignore-policy.test.mjs, because only git can answer that question.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET_BEARING, SECTIONS, TREES, TREE_PARITY,
  isTree, policyEntries, renderIgnore, parseEntries, diffEntries,
} from '../../lib/ignore-policy.mjs';

test('policy: every secret-bearing entry is actually declared in the policy', () => {
  const declared = policyEntries();
  const orphans = SECRET_BEARING.filter(e => !declared.includes(e));
  assert.deepEqual(
    orphans, [],
    `named as secret-bearing but never rendered into any tree: ${orphans.join(', ')}. ` +
    'The guard would warn about a path the generator does not emit.',
  );
});

test('policy: no entry is declared twice', () => {
  const declared = policyEntries();
  const seen = new Set();
  const dupes = declared.filter(e => (seen.has(e) ? true : (seen.add(e), false)));
  assert.deepEqual(dupes, [], `duplicated entries: ${dupes.join(', ')}`);
});

test('policy: every section carries at least one entry', () => {
  const empty = SECTIONS.filter(s => !Array.isArray(s.entries) || s.entries.length === 0);
  assert.deepEqual(empty.map(s => s.title), []);
});

test('render: both trees receive the SAME entries — parity is the whole point', () => {
  assert.equal(TREE_PARITY, 'identical');
  const [a, b] = TREES.map(t => parseEntries(renderIgnore(t)));
  assert.deepEqual(a, b);
  assert.deepEqual(a, policyEntries());
});

test('render: the headers differ so a reader knows which file they hold', () => {
  const working = renderIgnore('working');
  const published = renderIgnore('public');
  assert.notEqual(working, published);
  assert.match(working, /templates\/gitignore\.public/);
  assert.match(published, /published tree/);
  for (const text of [working, published]) {
    assert.match(text, /do not edit by hand/);
    assert.ok(text.endsWith('\n'), 'a generated file ends with a newline');
  }
});

test('render: an unknown tree is refused rather than rendered as something plausible', () => {
  assert.throws(() => renderIgnore('staging'), /unknown tree/);
  assert.throws(() => diffEntries('', 'staging'), /unknown tree/);
  assert.equal(isTree('working'), true);
  assert.equal(isTree('staging'), false);
});

test('parse: comments, blank lines and CRLF carry no behaviour', () => {
  const text = '# a comment\r\n\r\n  .env  \r\n#another\nopencode.json\n\n';
  assert.deepEqual(parseEntries(text), ['.env', 'opencode.json']);
});

test('diff: a file rendered from the policy agrees with it', () => {
  for (const tree of TREES) {
    const d = diffEntries(renderIgnore(tree), tree);
    assert.deepEqual(d, { missing: [], unexpected: [], missingSecrets: [], ok: true });
  }
});

test('diff: a dropped secret entry is reported as missing AND flagged as a leak risk', () => {
  const text = renderIgnore('working').split('\n').filter(l => l !== 'opencode.json').join('\n');
  const d = diffEntries(text, 'working');
  assert.equal(d.ok, false);
  assert.deepEqual(d.missing, ['opencode.json']);
  assert.deepEqual(d.missingSecrets, ['opencode.json']);
});

test('diff: a dropped NON-secret entry is missing but not a leak risk', () => {
  const text = renderIgnore('working').split('\n').filter(l => l !== 'Thumbs.db').join('\n');
  const d = diffEntries(text, 'working');
  assert.equal(d.ok, false);
  assert.deepEqual(d.missing, ['Thumbs.db']);
  assert.deepEqual(d.missingSecrets, []);
});

test('diff: an entry added to one copy by hand is reported — that is how drift starts', () => {
  const d = diffEntries(renderIgnore('public') + 'secrets-of-mine/\n', 'public');
  assert.equal(d.ok, false);
  assert.deepEqual(d.missing, []);
  assert.deepEqual(d.unexpected, ['secrets-of-mine/']);
});
