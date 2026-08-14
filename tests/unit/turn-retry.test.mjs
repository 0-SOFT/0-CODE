import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, decideRetry, backoffMs, maxRetries } from '../../core/turn-retry.mjs';

// The split came out of a real case: the v1.3.0 acceptance run died on a single
// "UnknownError: Unexpected server error", although a retry would have gone through.

test('transient failures: a retry has a chance', () => {
  const samples = [
    'UnknownError: Unexpected server error. Check server logs for details.',
    'socket hang up',
    'connect ECONNRESET 1.2.3.4:443',
    'HTTP 503 Service Unavailable',
    'HTTP 429 Too Many Requests',
    'rate limit exceeded, try again later',
    'The upstream provider is overloaded',
    'turn aborted by timeout (900000 ms): opencode did not answer',
    'fetch failed',
    'getaddrinfo EAI_AGAIN openrouter.ai',
  ];
  for (const e of samples) {
    assert.equal(classifyFailure(e), 'transient', `must be transient: ${e}`);
  }
});

test('real errors: retrying is pointless', () => {
  const samples = [
    'HTTP 401 Unauthorized',
    'Invalid API key provided',
    'no such model: moonshotai/kimi-k9',
    'insufficient credits — 402 Payment Required',
    'permission denied',
    'empty prompt',
    'ENOENT: opencode command not found',
  ];
  for (const e of samples) {
    assert.equal(classifyFailure(e), 'fatal', `must be a real error: ${e}`);
  }
});

// Check order matters: a single string may carry both markers at once.
test('a mixed case: a real error outranks a transient one', () => {
  assert.equal(classifyFailure('401 Unauthorized (rate limit info attached)'), 'fatal');
});

test('an unrecognised failure: we retry, but fewer times', () => {
  assert.equal(classifyFailure('something went wrong'), 'unknown');
  assert.ok(maxRetries('unknown') < maxRetries('transient'),
    'an unrecognised failure must have a lower retry limit — the cost of being wrong points the other way');
});

test('an empty error does not count as a real one', () => {
  assert.equal(classifyFailure(''), 'unknown');
  assert.equal(classifyFailure(null), 'unknown');
});

test('the pause doubles and then hits the ceiling', () => {
  const b = { baseMs: 1000, maxMs: 8000 };
  assert.equal(backoffMs(1, b), 1000);
  assert.equal(backoffMs(2, b), 2000);
  assert.equal(backoffMs(3, b), 4000);
  assert.equal(backoffMs(4, b), 8000);
  assert.equal(backoffMs(9, b), 8000, 'the ceiling must not be exceeded');
});

test('retry decision: a transient failure is retried up to the limit, then gives up', () => {
  const e = 'HTTP 503 Service Unavailable';
  const first = decideRetry({ error: e, attempt: 1 });
  assert.equal(first.retry, true);
  assert.equal(first.kind, 'transient');
  assert.ok(first.delayMs > 0);
  assert.match(first.reason, /attempt 1 of 4/);

  const last = decideRetry({ error: e, attempt: 5 });
  assert.equal(last.retry, false, 'once retries are exhausted the loop must stop');
  assert.match(last.reason, /did not clear within 4 retries/);
});

test('retry decision: a real error is never retried', () => {
  const r = decideRetry({ error: 'Invalid API key', attempt: 1 });
  assert.equal(r.retry, false);
  assert.equal(r.kind, 'fatal');
  assert.match(r.reason, /a retry will not help/);
});

// A LIVE OBSERVATION (v1.5.0, on opencode 1.18.16): the engine returns THE SAME vague text
// "UnknownError: Unexpected server error" both for a real error (a non-existent model) and for
// a server failure. And when the network is unreachable it writes nothing at all — zero bytes.
//
// The conclusion that follows: these cases are IN PRINCIPLE indistinguishable by text, so
//   1) "UnknownError" stays transient — otherwise we would cut the loop on every server hiccup;
//   2) the cost of being wrong this way is 75 seconds of retries (measured live);
//   3) the real cure is not here but in the STARTUP SELF-CHECK: a wrong model and a wrong key
//      must be caught before the loop rather than masquerading as a transient failure.
test('live observation: vague engine text is treated as a transient failure', () => {
  const real = 'UnknownError: Unexpected server error. Check server logs for details.';
  assert.equal(classifyFailure(real), 'transient');
  const r = decideRetry({ error: real, attempt: 1 });
  assert.equal(r.retry, true, 'we must not cut the loop on a vague error — more often than not it is transient');
});

test('live observation: a silent failure (empty output) is retried cautiously', () => {
  // with the network unreachable the engine prints zero bytes and only the exit code reaches us
  assert.equal(classifyFailure('opencode exited 1'), 'unknown');
  assert.equal(maxRetries('unknown'), 2, 'unrecognised failures are retried, but sparingly');
});
