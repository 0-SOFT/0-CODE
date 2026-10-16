import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMcpInputs } from '../../core/backends/mcp-input.mjs';

test('required private references refuse missing values while explicit defaults remain usable', () => {
  const result = generateMcpInputs({ servers: [
    { name: 'required-env', command: 'node', env: { API_KEY: '${MISSING}' } },
    { name: 'required-header', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${MISSING}' } },
    { name: 'default', command: 'node', source: 'npm', env: { PORT: '${PORT:-50419}', EMPTY: '${EMPTY:-}' } },
  ] }, {});
  assert.deepEqual(result.registered, ['default']);
  assert.deepEqual(result.skipped, ['required-env', 'required-header']);
  for (const name of result.skipped) assert.match(result.reasons[name], /environment variable missing: MISSING/);
  assert.deepEqual(result.entries.default.env, { PORT: '50419', EMPTY: '' });
  const value = 'literal-${inside-the-credential}';
  const present = generateMcpInputs({ servers: [{ name: 'present', command: 'node', env: { API_KEY: '${KEY}' } }] }, { KEY: value });
  assert.equal(present.entries.present.env.API_KEY, value, 'parse templates once without reinterpreting credential bytes');
  for (const fields of [{ name: 123 }, { source: true }, { source: '' }, { type: null },
    { env: { VALUE: '${UNSUPPORTED.name}' } }, { env: { VALUE: '${NUL}' } }]) {
    assert.deepEqual(generateMcpInputs({ servers: [{ name: 'invalid', command: 'node', ...fields }] }, { NUL: '\0' }).registered, []);
  }
});

test('bad MCP inputs are explicitly skipped without credential values in diagnostics', () => {
  const credential = 'fixture-private-input';
  const invalid = [null, { name: 'bad name', command: 'node' },
    { type: 'stdio', command: '' }, { type: 'unsupported' }, { type: 'http', url: 'file:///bad' },
    { type: 'http', url: 'https://user:pass@example.test/mcp' },
    { type: 'http', url: 'https://example.test', headers: { bad: 'line\nbreak' } },
    { type: 'http', url: 'https://example.test', command: 'node' },
    { type: 'stdio', command: 'node', url: 'https://example.test' },
    { command: 'node', args: {} }, { command: 'node', args: [5] },
    { command: 'node', env: [] }, { command: 'node', env: { BAD: 5 } },
    { command: 'node', env: { 'BAD NAME': 'value' } }, { command: 'node', secrets: ['BAD NAME'] },
    { command: 'node', secrets: ['MISSING'] }, { command: '${MISSING}' }, { command: '${invalid.expression}' },
    { command: 'node', args: ['${ALIAS}'], secrets: ['PRIVATE'] },
    { command: 'node', portable: false }, { command: 'node', portable: 'yes' },
    { command: 'node', needs_setup: true }, { source: 'claude_ai' }, { command: 'nul\0command' }];
  for (const [i, fields] of invalid.entries()) {
    const server = fields === null ? null : { name: 'server' + i, ...fields };
    const result = generateMcpInputs({ servers: [server] }, { PRIVATE: credential, ALIAS: credential });
    assert.equal(result.registered.length, 0, 'invalid input ' + i);
    assert.equal(result.skipped.length, 1);
    assert.ok(Object.values(result.reasons)[0]);
    assert.ok(!JSON.stringify(result).includes(credential));
  }
  assert.throws(() => generateMcpInputs({}), /Invalid MCP manifest/);
  assert.throws(() => generateMcpInputs({ schema_version: 2, servers: [] }), /Invalid MCP manifest/);
  const duplicated = generateMcpInputs({ servers: [{ name: 'duplicate', command: 'node' }, { name: 'duplicate', command: 'node' }] });
  assert.deepEqual(duplicated.registered, []);
  assert.match(duplicated.reasons.duplicate, /duplicate/);
});

test('public defaults and private headers remain useful while cloud owner Telegram is excluded', () => {
  const result = generateMcpInputs({ servers: [
    { name: 'stdio', command: '${BIN:-node}', args: ['${LABEL}'], env: { VALUE: '${UNSET:-default}' } },
    { name: 'remote', type: 'sse', url: 'https://example.test', headers: { Authorization: 'Bearer ${TOKEN}' } },
  ] }, { LABEL: 'a"b', TOKEN: 'fixture-token' });
  assert.deepEqual(result.registered, ['stdio', 'remote']);
  assert.equal(result.entries.stdio.command, 'node');
  assert.deepEqual(result.entries.stdio.args, ['a"b']);
  assert.equal(result.entries.stdio.env.VALUE, 'default');
  assert.equal(result.entries.remote.headers.Authorization, 'Bearer fixture-token');
  const cloud = generateMcpInputs({ servers: [{ name: 'owner', command: 'node', env: { TELEGRAM_API_ID: '${TELEGRAM_API_ID}' } }] }, { FRAMEWORK_CLOUD_MODE: '1' });
  assert.deepEqual(cloud.skipped, ['owner']);
  assert.match(cloud.reasons.owner, /user-account Telegram/);
});
