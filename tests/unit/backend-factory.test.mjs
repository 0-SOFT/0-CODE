import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBackend, autodetectBackendId, SUPPORTED_BACKENDS } from '../../core/backend-factory.mjs';

test('getBackend: an explicit id', () => {
  assert.equal(getBackend('claude').id, 'claude');
  assert.equal(getBackend('opencode').id, 'opencode');
});

test('getBackend: an unknown id → throws', () => {
  assert.throws(() => getBackend('bogus', { env: {} }));
});

test('getBackend: without an id → from env (explicit AGENT_BACKEND)', () => {
  assert.equal(getBackend(undefined, { env: { AGENT_BACKEND: 'opencode' } }).id, 'opencode');
});

test('autodetectBackendId: an explicit flag outranks the markers', () => {
  assert.equal(autodetectBackendId({ AGENT_BACKEND: 'opencode', CLAUDECODE: '1' }), 'opencode');
  assert.equal(autodetectBackendId({ AGENT_BACKEND: 'claude' }), 'claude');
});

test('autodetectBackendId: environment markers', () => {
  assert.equal(autodetectBackendId({ CLAUDECODE: '1' }), 'claude');
  assert.equal(autodetectBackendId({ CLAUDE_PLUGIN_ROOT: '/x' }), 'claude');
  assert.equal(autodetectBackendId({ OPENCODE: '1' }), 'opencode');
  assert.equal(autodetectBackendId({ OPENCODE_SERVER_PASSWORD: 'x' }), 'opencode');
  assert.equal(autodetectBackendId({}), 'claude', 'a safe default');
});

test('autodetectBackendId: an empty env → the claude default', () => {
  assert.equal(autodetectBackendId({}), 'claude');
});

test('SUPPORTED_BACKENDS', () => {
  assert.deepEqual(SUPPORTED_BACKENDS, ['claude', 'opencode', 'codex']);
});

// v1.3.0: the second engine plugs into the same Backend port.
test('getBackend: opencode is selected by an explicit flag', () => {
  const b = getBackend('opencode');
  assert.equal(b.id, 'opencode');
  assert.equal(typeof b.runTurn, 'function');
  assert.equal(typeof b.guardCommand, 'function');
  assert.ok(SUPPORTED_BACKENDS.includes('opencode'));
});

test('autodetectBackendId: AGENT_BACKEND=opencode is respected', () => {
  assert.equal(autodetectBackendId({ AGENT_BACKEND: 'opencode' }), 'opencode');
});
