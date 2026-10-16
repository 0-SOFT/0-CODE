// A genuine 0.161.0 recording, not a generated happy-path stream.
// The receipt records CLI version and requested model; JSONL does not name the internal model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseCodexEvents } from '../../core/backends/codex.mjs';

const recording = readFileSync(new URL('../fixtures/codex/0.161.0-repair.jsonl', import.meta.url), 'utf8');
const receipt = JSON.parse(readFileSync(new URL('../fixtures/codex/0.161.0-repair.provenance.json', import.meta.url), 'utf8'));
const events = recording.trimEnd().split(/\r?\n/).map(JSON.parse);
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('recorded Codex 0.161.0: provenance, raw usage and final output survive parsing', () => {
  assert.equal(receipt.cliVersion, '0.161.0');
  assert.equal(receipt.nodeVersion, 'v24.15.0');
  for (const field of ['rawSha256', 'initialSha256', 'launchSha256', 'selectedResultSha256', 'runnerSha256']) {
    assert.match(receipt.capture[field], /^[a-f0-9]{64}$/);
  }
  assert.match(receipt.capture.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(sha256(recording), receipt.fixture.sha256);
  assert.equal(receipt.fixture.eventsOtherwiseUnchanged, true);
  assert.doesNotMatch(recording, /F:[\\/]+Projects/);
  for (const event of events) {
    for (const match of JSON.stringify(event).matchAll(/C:(\\+|\/)Users\1([^\\/"'\s]+)/g)) {
      assert.equal(match[2], 'test-user');
    }
  }
  const args = receipt.request.command.args;
  assert.equal(args[args.indexOf('-m') + 1], receipt.request.model);
  assert.ok(args.includes(`model_reasoning_effort=${JSON.stringify(receipt.request.reasoningEffort)}`));
  assert.ok(args.includes('--json'));
  assert.equal(receipt.observation.actualLaunch, true);
  assert.equal(receipt.observation.launchStatus, 0);
  assert.equal(receipt.observation.fiveTurnAcceptance, false);

  const threads = events.filter(event => event.type === 'thread.started');
  const starts = events.filter(event => event.type === 'turn.started');
  const completed = events.filter(event => event.type === 'turn.completed');
  const messages = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message');
  assert.equal(threads.length, 1); assert.equal(starts.length, 1); assert.equal(completed.length, 1);
  assert.equal(messages.length, receipt.observation.completedAgentMessages);
  assert.ok(messages.length > 1, 'this recording must distinguish final output from progress');
  assert.ok(events.some(event => event.type === 'item.completed' && event.item?.type === 'command_execution'));
  const result = parseCodexEvents(recording, {exitCode: receipt.observation.launchStatus});
  assert.equal(result.ok, true); assert.equal(result.formatChanged, undefined);
  assert.equal(result.sessionId, threads[0].thread_id);
  assert.equal(result.sessionId, receipt.observation.sessionId);
  assert.deepEqual(result.usage, completed[0].usage);
  assert.deepEqual(result.usageTotal, completed[0].usage);
  assert.deepEqual(result.usage, receipt.observation.usage);
  assert.equal(result.output, messages.at(-1).item.text);
  assert.notEqual(result.output, messages[0].item.text);
  assert.equal(sha256(result.output), receipt.observation.outputSha256);
  assert.equal(Object.hasOwn(result, 'costUsd'), false);
  assert.ok(result.usage.cached_input_tokens <= result.usage.input_tokens);
  assert.ok(result.usage.reasoning_output_tokens <= result.usage.output_tokens);
});

test('recorded Codex 0.161.0: loss of a required token field refuses despite a final answer', () => {
  const damaged = events.map(event => {
    if (event.type !== 'turn.completed') return event;
    const {input_tokens, ...remaining} = event.usage;
    assert.ok(input_tokens > 0);
    return {...event, usage: remaining};
  }).map(JSON.stringify).join('\n') + '\n';
  const result = parseCodexEvents(damaged, {exitCode: 0});
  assert.equal(result.ok, false);
  assert.equal(result.formatChanged, true);
  assert.equal(result.usage, undefined);
  assert.match(result.error, /turn\.completed usage schema changed/);
});
