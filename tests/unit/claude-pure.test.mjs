import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeBackend, parseClaudeJson, substituteEnv, buildClaudeArgs } from '../../core/backends/claude.mjs';
import { fakeClaudeJson } from '../helpers/index.mjs';

test('parseClaudeJson: a valid JSON response', () => {
  const r = parseClaudeJson(fakeClaudeJson({ result: 'done', session_id: 'sess1', total_cost_usd: 0.01 }));
  assert.equal(r.output, 'done');
  assert.equal(r.sessionId, 'sess1');
  assert.equal(r.costUsd, 0.01);
  assert.ok(r.raw);
});

test('parseClaudeJson: non-JSON → output is the raw stdout', () => {
  const r = parseClaudeJson('just text');
  assert.equal(r.output, 'just text');
  assert.equal(r.sessionId, undefined);
  assert.equal(r.raw, null);
});

test('parseClaudeJson: JSON without the optional fields', () => {
  const r = parseClaudeJson(JSON.stringify({ result: 'R' }));
  assert.equal(r.output, 'R');
  assert.equal(r.costUsd, undefined);
});

test('substituteEnv: ${VAR} and ${VAR:-default}', () => {
  assert.equal(substituteEnv('${A}-${B:-def}', { A: 'x' }), 'x-def');
  assert.equal(substituteEnv('${A}', { A: 'y' }), 'y');
  assert.equal(substituteEnv('${MISSING}', {}), '');
  assert.equal(substituteEnv('${E:-d}', { E: '' }), 'd');   // an empty value is treated as missing
});

test('ClaudeBackend.runTurn: an empty prompt → ok:false without invoking the CLI', async () => {
  const b = new ClaudeBackend();
  const r = await b.runTurn({ prompt: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /empty prompt/);
});

test('ClaudeBackend.id', () => {
  assert.equal(new ClaudeBackend().id, 'claude');
});

// v1.1.0 — the root fix for headless execution: without a permission mode a headless turn
// silently refuses Write/Edit/Bash and degenerates into a plan with no work.
// v1.2.0: by default the prompt goes to standard input and no longer appears in the arguments —
// otherwise the Windows command line is cut off at about 8100 characters (experiment L1).
test('buildClaudeArgs: headless defaults preserve personal MCP and keep the prompt on stdin', () => {
  const args = buildClaudeArgs({ prompt: 'p' }, {});
  assert.deepEqual(args, ['-p', '--output-format', 'json',
    '--permission-mode', 'bypassPermissions']);
  assert.ok(!args.includes('p'), 'the prompt text must not reach the arguments');
});

test('buildClaudeArgs: promptViaStdin:false restores the old way (compatibility)', () => {
  const args = buildClaudeArgs({ prompt: 'p', promptViaStdin: false }, {});
  assert.deepEqual(args, ['-p', 'p', '--output-format', 'json',
    '--permission-mode', 'bypassPermissions']);
});

test('buildClaudeArgs: the argument length does not depend on the prompt size', () => {
  const big = 'x'.repeat(50000);
  const args = buildClaudeArgs({ prompt: big }, {});
  assert.ok(args.join(' ').length < 200, 'the arguments must stay short whatever the prompt');
});

test('buildClaudeArgs: the model is added and the default flags are kept', () => {
  const args = buildClaudeArgs({ prompt: 'p', model: 'm' }, {});
  assert.deepEqual(args, ['-p', '--output-format', 'json', '--model', 'm',
    '--permission-mode', 'bypassPermissions']);
});

test('buildClaudeArgs: an explicit permissionMode outranks both the default and env', () => {
  const args = buildClaudeArgs({ prompt: 'p', permissionMode: 'acceptEdits' },
    { CLAUDE_HEADLESS_PERMISSION_MODE: 'default' });
  assert.ok(args.includes('acceptEdits'));
  assert.ok(!args.includes('bypassPermissions'));
});

test('buildClaudeArgs: env CLAUDE_HEADLESS_PERMISSION_MODE overrides the default', () => {
  const args = buildClaudeArgs({ prompt: 'p' }, { CLAUDE_HEADLESS_PERMISSION_MODE: 'default' });
  assert.deepEqual(args.slice(-2), ['--permission-mode', 'default']);
});

test('buildClaudeArgs: permissionMode "none" → the mode flag is not added', () => {
  const args = buildClaudeArgs({ prompt: 'p', permissionMode: 'none' }, {});
  assert.ok(!args.includes('--permission-mode'));
});

test('buildClaudeArgs: strictMcp:false → no --strict-mcp-config', () => {
  const args = buildClaudeArgs({ prompt: 'p', strictMcp: false }, {});
  assert.ok(!args.includes('--strict-mcp-config'));
});

test('buildClaudeArgs: maxBudgetUsd → --max-budget-usd as a string', () => {
  const args = buildClaudeArgs({ prompt: 'p', maxBudgetUsd: 2.5 }, {});
  const i = args.indexOf('--max-budget-usd');
  assert.ok(i > -1);
  assert.equal(args[i + 1], '2.5');
});

test('buildClaudeArgs: invariant — --continue is NEVER added in headless mode', () => {
  for (const opts of [{ prompt: 'p' }, { prompt: 'p', model: 'm', maxBudgetUsd: 1 },
    { prompt: 'p', permissionMode: 'none', strictMcp: false }]) {
    assert.ok(!buildClaudeArgs(opts, {}).includes('--continue'));
  }
});
