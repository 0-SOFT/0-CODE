// tests/unit/secret-scan.test.mjs — the pure half of the sanitisation gate: which strings count as
// a credential, which lines are merely showing the shape of one, and how a finding is masked.
// Whether git would actually stage the file is asked in tests/integration/secret-scan.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECRET_PATTERNS, PLACEHOLDER, findSecrets, mask } from '../../lib/secret-scan.mjs';

// Assembled at runtime so this file never carries a literal any scanner would flag — including
// this project's own gate, which reads every tracked file.
const GH = 'ghp_' + 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8';
const ANTHROPIC = 'sk-ant-' + 'api03' + '-' + 'Zq7'.repeat(8);
const AWS = 'AKIA' + 'QWERTYUIOPASDFGH';

test('patterns: each shape is recognised', () => {
  for (const [label, sample] of [['GitHub', GH], ['Anthropic', ANTHROPIC], ['AWS', AWS]]) {
    assert.equal(findSecrets(`token=${sample}`).length, 1, `${label} not recognised`);
  }
});

test('patterns: a prefix without a payload is not a credential', () => {
  assert.deepEqual(findSecrets('ghp_short'), []);
  assert.deepEqual(findSecrets('AKIA123'), []);
  assert.deepEqual(findSecrets('nothing to see here'), []);
});

test('placeholder: documentation and templates do not raise an alarm', () => {
  for (const line of [
    `GITHUB_TOKEN=\${GITHUB_TOKEN}`,
    `token: your_token_here ${GH}`,
    `# example: ${GH}`,
    `masked in the report: ghp_A1B2***`,
    // Built at runtime, not written out: the release gate scans tracked files for credential
    // shapes and has no placeholder exemption, so even a masked literal would block the export.
    `GITHUB_TOKEN=ghp_${'x'.repeat(36)}`,
  ]) {
    assert.deepEqual(findSecrets(line), [], `should have been treated as a placeholder: ${line}`);
    assert.ok(PLACEHOLDER.test(line));
  }
});

test('findSecrets: reports the line number and the pattern name', () => {
  const found = findSecrets(`first\nsecond\nkey=${GH}\n`);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3);
  assert.equal(found[0].pattern, 'GitHub token');
  assert.equal(found[0].match, GH);
});

test('findSecrets: several credentials on separate lines are all reported', () => {
  const found = findSecrets(`a=${GH}\nb=${AWS}\n`);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map(f => f.line), [1, 2]);
});

test('findSecrets: CRLF does not hide a credential', () => {
  assert.equal(findSecrets(`x\r\nkey=${GH}\r\n`).length, 1);
});

test('mask: a finding never prints the live credential', () => {
  const masked = mask(GH);
  assert.ok(masked.startsWith('ghp_A1B2'));
  assert.ok(!masked.includes(GH.slice(12)), 'the tail must not survive masking');
  assert.equal(masked.length, GH.length);
  assert.equal(findSecrets(masked).length, 0, 'a masked value must not itself trip the scanner');
});

test('mask: a short value still gets padding rather than being echoed whole', () => {
  assert.equal(mask('abc'), 'abc***');
});

test('patterns: the table is non-empty and every entry is usable', () => {
  assert.ok(SECRET_PATTERNS.length >= 5);
  for (const p of SECRET_PATTERNS) {
    assert.equal(typeof p.name, 'string');
    assert.ok(p.re instanceof RegExp);
  }
});
