import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, parseScalarOrInline, serializeYaml, serializeScalar } from '../../lib/yaml-mini.mjs';

test('parseScalarOrInline: scalars', () => {
  assert.equal(parseScalarOrInline('null'), null);
  assert.equal(parseScalarOrInline('~'), null);
  assert.equal(parseScalarOrInline(''), null);
  assert.equal(parseScalarOrInline('true'), true);
  assert.equal(parseScalarOrInline('false'), false);
  assert.equal(parseScalarOrInline('42'), 42);
  assert.equal(parseScalarOrInline('-3'), -3);
  assert.equal(parseScalarOrInline('1.5'), 1.5);
  assert.equal(parseScalarOrInline('plain text'), 'plain text');
});

test('parseScalarOrInline: quotes and inline JSON', () => {
  assert.equal(parseScalarOrInline('"a\\"b"'), 'a"b');         // double-quoted, escaping
  assert.equal(parseScalarOrInline("'it''s'"), "it's");         // single-quoted, '' → '
  assert.deepEqual(parseScalarOrInline('[1,2,3]'), [1, 2, 3]);
  assert.deepEqual(parseScalarOrInline('{"a":1}'), { a: 1 });
  assert.equal(parseScalarOrInline('[broken'), '[broken');      // broken JSON → treated as a string
});

test('serializeScalar: types and escaping', () => {
  assert.equal(serializeScalar('plain'), 'plain');
  assert.equal(serializeScalar(5), '5');
  assert.equal(serializeScalar(true), 'true');
  assert.equal(serializeScalar('true'), '"true"');             // a string that looks like a boolean → quoted
  assert.equal(serializeScalar('a: b'), '"a: b"');             // a special character → quoted
  assert.equal(serializeScalar('9lives'), '"9lives"');         // starts with a digit → quoted
});

test('serializeYaml: empty structures, null, a number', () => {
  assert.equal(serializeYaml({ a: null }), 'a: null');
  assert.equal(serializeYaml({ a: {} }), 'a: {}');
  assert.equal(serializeYaml({ a: [] }), 'a: []');
  assert.equal(serializeYaml({ iteration: 99 }), 'iteration: 99');
});

test('round-trip: serialize → parse preserves the values', () => {
  const obj = {
    iteration: 5, name: 'hello', flag: true, ratio: 1.25,
    blockers: [], tags: ['a', 'b'], nested: { count: 2, on: false },
  };
  const back = parseYaml(serializeYaml(obj));
  assert.deepEqual(back, obj);
});

test('parseYaml: a numeric key and null values', () => {
  const o = parseYaml('attempts:\n  0.0.1_skeleton:\n    count: 1\nempty: ~\nlist: []');
  assert.equal(o.attempts['0.0.1_skeleton'].count, 1);
  assert.equal(o.empty, null);
  assert.deepEqual(o.list, []);
});

test('round-trip: an array of objects (like blockers in STATE)', () => {
  const obj = { blockers: [{ type: 'manual_request', what: 'a key is required' }], iteration: 2 };
  const back = parseYaml(serializeYaml(obj));
  assert.deepEqual(back, obj);
});

test('parseYaml: a block list of scalars', () => {
  const o = parseYaml('items:\n  - one\n  - two\ncount: 2');
  assert.deepEqual(o.items, ['one', 'two']);
  assert.equal(o.count, 2);
});

test('parseYaml: a nested object introduced by a valueless key', () => {
  const o = parseYaml('budget_metrics:\n  version_cost_usd: 1.5\n  cap_usd: null');
  assert.equal(o.budget_metrics.version_cost_usd, 1.5);
  assert.equal(o.budget_metrics.cap_usd, null);
});

test('parseYaml: a malformed line throws', () => {
  assert.throws(() => parseYaml('this is not key-value'));
});
