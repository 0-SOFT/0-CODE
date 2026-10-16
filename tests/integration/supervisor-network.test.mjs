import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { Backend } from '../../core/backends/Backend.mjs';
import { runLoop } from '../../core/supervisor.mjs';
import { PREFLIGHT_PROMPT } from '../../core/preflight.mjs';
import { classifyFailure } from '../../core/turn-retry.mjs';
import { readLock } from '../../core/loop-lock.mjs';
import { mkTempProject, readFrontmatter, cleanupTempDir } from '../helpers/index.mjs';

// Real HTTP transport and fault injection at the server boundary; no replacement of
// retry, preflight, timers, lock, STATE writes or supervisor functions.
class HttpTransport extends Backend {
  constructor(url, env = {}) { super(); this.url = url; this.env = env; }
  get id() { return 'http-transport'; }
  async runTurn({ prompt }) {
    try {
      const path = prompt === PREFLIGHT_PROMPT ? '/probe' : '/turn';
      const response = await fetch(this.url + path, { method: 'POST', body: prompt });
      const text = await response.text();
      return response.ok ? { ok: true, output: text, sessionId: 'local-http', costUsd: 0 }
        : { ok: false, output: '', error: `HTTP ${response.status}: ${text}` };
    } catch (error) { return { ok: false, output: '', error: error.cause?.code || error.message }; }
  }
}

async function fixture(t, { failures = {}, status = 503, body = 'Service unavailable', env, onRequest } = {}) {
  const counts = { '/probe': 0, '/turn': 0 };
  const server = createServer((request, response) => {
    request.resume();
    const count = ++counts[request.url];
    onRequest?.(request.url, count);
    if (count <= (failures[request.url] || 0)) {
      response.writeHead(status, { 'Content-Type': body.includes('<html') ? 'text/html' : 'text/plain' }); response.end(body);
    } else { response.writeHead(200); response.end('OK'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const project = mkTempProject({ no_progress_after: 0, next_step_prompt: 'Perform the network acceptance task' },
    { baseDir: process.env.FRAMEWORK_TEST_TMPDIR || tmpdir() });
  t.after(() => cleanupTempDir(project.dir));
  const backend = new HttpTransport(`http://127.0.0.1:${server.address().port}`, env);
  return { ...project, backend, counts };
}

test('real 503 responses outlive the old limit in startup and work, then both recover', async t => {
  const f = await fixture(t, { failures: { '/probe': 6, '/turn': 7 } });
  const result = await runLoop({ stateFile: f.stateFile, backend: f.backend, maxLoops: 1,
    retryBackoff: { baseMs: 1, maxMs: 2 } });
  assert.equal(result.stopped, 'max_loops');
  assert.deepEqual(f.counts, { '/probe': 7, '/turn': 8 });
  assert.equal(readFrontmatter(f.stateFile).iteration, 1);
  assert.equal(readLock(f.dir), null);
});

test('owner stop gates interrupt an unlimited outage in startup and work without another request', async t => {
  for (const usePreflight of [true, false]) for (const stop of ['blockers', 'released', 'iteration_cap']) {
    let f;
    f = await fixture(t, { failures: { '/probe': Infinity, '/turn': Infinity }, onRequest: (_path, count) => {
      if (count !== 1) return;
      const patch = stop === 'blockers' ? { blockers: [{ type: 'manual', what: 'Owner stopped the network acceptance task' }] }
        : stop === 'released' ? { released_version: '0.0.1' } : { max_iterations: 1, iteration: 1 };
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../lib/update-state.mjs', import.meta.url)), f.stateFile],
        { input: JSON.stringify(patch), encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
    } });
    const result = await runLoop({ stateFile: f.stateFile, backend: f.backend, usePreflight,
      retryBackoff: { baseMs: 1, maxMs: 2 } });
    assert.equal(result.stopped, stop);
    assert.equal(f.counts[usePreflight ? '/probe' : '/turn'], 1);
    assert.equal(result.loops, 0); assert.equal(readLock(f.dir), null);
  }
});

test('a real proxy HTML 403 is retried and a genuine 401 fails the startup immediately', async t => {
  const proxy = await fixture(t, { failures: { '/probe': 5 }, status: 403,
    body: '<!doctype html><html><title>Proxy temporarily blocked</title></html>' });
  const recovered = await runLoop({ stateFile: proxy.stateFile, backend: proxy.backend, maxLoops: 1,
    retryBackoff: { baseMs: 1, maxMs: 2 } });
  assert.equal(recovered.stopped, 'max_loops'); assert.equal(proxy.counts['/probe'], 6);
  const auth = await fixture(t, { failures: { '/probe': Infinity }, status: 401, body: 'Invalid API key' });
  const refused = await runLoop({ stateFile: auth.stateFile, backend: auth.backend, maxLoops: 1 });
  assert.equal(refused.stopped, 'preflight_failed');
  assert.deepEqual(auth.counts, { '/probe': 1, '/turn': 0 });
  assert.equal(readFrontmatter(auth.stateFile).iteration, 0);
});

test('environment and explicit retry caps apply equally to startup and work', async t => {
  for (const usePreflight of [true, false]) {
    const f = await fixture(t, { failures: { '/probe': Infinity, '/turn': Infinity }, env: { AGENT_NETWORK_RETRIES: '8' } });
    const result = await runLoop({ stateFile: f.stateFile, backend: f.backend, usePreflight,
      networkRetries: 2, retryBackoff: { baseMs: 1, maxMs: 2 } });
    assert.equal(result.stopped, usePreflight ? 'preflight_failed' : 'turn_failed');
    assert.deepEqual(f.counts, usePreflight ? { '/probe': 3, '/turn': 0 } : { '/probe': 0, '/turn': 3 });
    assert.equal(readFrontmatter(f.stateFile).iteration, 0); assert.equal(readLock(f.dir), null);
  }
});

test('an actual DNS lookup failure is temporary and model-not-found HTTP stops immediately', async t => {
  await assert.rejects(lookup('restrictions-130.invalid'), error => {
    assert.equal(classifyFailure(error.message), 'transient'); return true;
  });
  const f = await fixture(t, { failures: { '/turn': Infinity }, status: 404, body: 'model not found' });
  const result = await runLoop({ stateFile: f.stateFile, backend: f.backend, usePreflight: false });
  assert.equal(result.stopped, 'turn_failed'); assert.equal(result.failureKind, 'fatal');
  assert.equal(f.counts['/turn'], 1); assert.equal(readFrontmatter(f.stateFile).iteration, 0);
});
