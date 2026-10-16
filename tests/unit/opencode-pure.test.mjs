import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOpenCodeEvents, buildOpenCodeArgs, toOpenCodePermissions,
  buildOpenCodePluginScript, OPENCODE_PROVIDER,
} from '../../core/backends/opencode.mjs';

// The event format was taken from REAL opencode 1.18.16 output:
// line-delimited JSON {type, timestamp, sessionID, part}.
const event = (type, part, extra = {}) =>
  JSON.stringify({ type, timestamp: 1786375373262, sessionID: 'ses_013bb2af6ffeRYECFtzivXZMHR', part, ...extra });

const stream = [
  event('step_start', { id: 'prt_1', type: 'step-start' }),
  event('text', { id: 'prt_2', type: 'text', text: 'DONE' }),
  event('step_finish', {
    id: 'prt_3', type: 'step-finish', reason: 'stop',
    tokens: { total: 23174, input: 23092, output: 40, reasoning: 91, cache: { write: 0, read: 0 } },
    cost: 0.0123,
  }),
].join('\n');

test('parseOpenCodeEvents: text, cost, tokens, session', () => {
  const r = parseOpenCodeEvents(stream);
  assert.equal(r.ok, true);
  assert.equal(r.output, 'DONE');
  assert.equal(r.costUsd, 0.0123);
  assert.equal(r.sessionId, 'ses_013bb2af6ffeRYECFtzivXZMHR');
  assert.equal(r.finishReason, 'stop');
  assert.deepEqual(r.tokens, { input: 23092, output: 40 });
});

test('parseOpenCodeEvents: several steps — text is concatenated and cost is summed', () => {
  const multiStep = [
    event('text', { type: 'text', text: 'first ' }),
    event('step_finish', { type: 'step-finish', cost: 0.01, tokens: { input: 100, output: 5 } }),
    event('text', { type: 'text', text: 'second' }),
    event('step_finish', { type: 'step-finish', cost: 0.02, tokens: { input: 200, output: 7 } }),
  ].join('\n');
  const r = parseOpenCodeEvents(multiStep);
  assert.equal(r.output, 'first second');
  assert.ok(Math.abs(r.costUsd - 0.03) < 1e-9);
  assert.deepEqual(r.tokens, { input: 300, output: 12 });
  assert.equal(r.steps, 2);
});

// A real error observed during research: insufficient OpenRouter credit.
test('parseOpenCodeEvents: an error event → ok:false with the reason text', () => {
  const errorEvent = JSON.stringify({
    type: 'error', timestamp: 1, sessionID: 'ses_x',
    error: { name: 'APIError', data: { message: 'This request requires more credits' } },
  });
  const r = parseOpenCodeEvents(errorEvent);
  assert.equal(r.ok, false);
  assert.match(r.error, /more credits/);
  assert.match(r.error, /APIError/);
});

test('parseOpenCodeEvents: malformed lines are skipped and empty input does not crash it', () => {
  const r = parseOpenCodeEvents('{broken line\n' + event('text', { type: 'text', text: 'X' }));
  assert.equal(r.output, 'X');
  for (const empty of ['', null, undefined]) {
    const parsed = parseOpenCodeEvents(empty);
    assert.equal(parsed.output, '');
    assert.equal(parsed.ok, true);
  }
});

test('parseOpenCodeEvents: counts tool calls', () => {
  const toolStream = [
    event('tool_use', { type: 'tool-use' }),
    event('tool', { type: 'tool' }),
    event('tool_use', { type: 'tool-use' }),
  ].join('\n');
  assert.equal(parseOpenCodeEvents(toolStream).toolCalls, 2);
});

// The key invariant: the prompt travels through standard input. It must not appear in the
// arguments — otherwise the Windows command line is cut off at about 8100 characters.
test('buildOpenCodeArgs: the prompt NEVER reaches the arguments', () => {
  const huge = 'x'.repeat(50000);
  const args = buildOpenCodeArgs({ prompt: huge, model: 'moonshotai/kimi-k3' });
  assert.ok(!args.some(a => a.includes('xxx')), 'the prompt text must not be in the arguments');
  assert.ok(args.join(' ').length < 200, 'the arguments must stay short');
});

test('buildOpenCodeArgs: the mandatory flags and a provider-qualified model', () => {
  const args = buildOpenCodeArgs({ model: 'moonshotai/kimi-k3' });
  assert.equal(args[0], 'run');
  assert.ok(args.includes('--format') && args[args.indexOf('--format') + 1] === 'json');
  assert.ok(args.includes('--auto'), 'without --auto there would be permission prompts');
  const i = args.indexOf('-m');
  assert.equal(args[i + 1], `${OPENCODE_PROVIDER}/moonshotai/kimi-k3`);
});

test('buildOpenCodeArgs: a model that already carries a provider is not doubled', () => {
  const args = buildOpenCodeArgs({ model: 'openrouter/moonshotai/kimi-k3' });
  assert.equal(args[args.indexOf('-m') + 1], 'openrouter/moonshotai/kimi-k3');
});

test('buildOpenCodeArgs: session continuation and switchable auto-approval', () => {
  const s = buildOpenCodeArgs({ sessionId: 'ses_42' });
  assert.equal(s[s.indexOf('--session') + 1], 'ses_42');
  assert.ok(!buildOpenCodeArgs({ autoApprove: false }).includes('--auto'));
});

// Our policy is written with Claude Code globs; OpenCode uses a different syntax.
// The requirement: no rule may be lost silently.
test('toOpenCodePermissions: every denial carries over, nothing is lost', () => {
  const { permission, dropped } = toOpenCodePermissions({
    allow: ['Read', 'Bash(git status)', 'Bash(npm test*)'],
    deny: ['Bash(rm -rf /)', 'Bash(rm -rf ~)', 'Bash(git push --force*)'],
  });
  assert.deepEqual(dropped, [], 'no rule may be dropped silently');
  assert.equal(permission.bash['*'], 'allow', 'ordinary commands are allowed');
  assert.equal(permission.bash['rm -rf /'], 'deny');
  assert.equal(permission.bash['rm -rf ~'], 'deny');
  assert.equal(permission.bash['rm -rf /*'], undefined);
  assert.equal(permission.bash['git push --force*'], 'deny');
});

test('toOpenCodePermissions: denials come AFTER the permissive rule', () => {
  const { permission } = toOpenCodePermissions({ allow: [], deny: ['Bash(rm -rf /)'] });
  const keys = Object.keys(permission.bash);
  assert.equal(keys[0], '*', 'in OpenCode the last matching rule wins, so "*" comes first');
  assert.ok(keys.indexOf('rm -rf /') > 0);
});

test('toOpenCodePermissions: non-bash tools are allowed explicitly', () => {
  const { permission } = toOpenCodePermissions({ allow: [], deny: [] });
  for (const tool of ['edit', 'read', 'glob', 'grep', 'webfetch']) {
    assert.equal(permission[tool], 'allow', `tool ${tool} must be allowed`);
  }
});

// The arbiter plugin: the rules come from THE SAME core/safety.mjs as the Claude Code hook.
test('buildOpenCodePluginScript: carries the OpenCode contract and our rule source', () => {
  const s = buildOpenCodePluginScript('/abs/path/core/permission-decision.mjs');
  assert.match(s, /export const \w+/, 'a named export');
  assert.match(s, /tool\.execute\.before/, 'the tool-call interception hook');
  assert.match(s, /output\.args\.command/, 'the command is read from args.command');
  assert.match(s, /decidePermission/, 'the mode comes from the shared decision');
  assert.match(s, /throw new Error/, 'blocking by throwing an error');
  assert.match(s, /permission-decision\.mjs/, 'a reference to the single decision source');
});
