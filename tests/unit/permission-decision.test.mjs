import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePermission, ARBITER, GUARD_ONLY, resolveMode } from '../../core/permission-decision.mjs';

const bash = command => ({ tool_name: 'Bash', tool_input: { command } });

// Arbiter mode (the default): the hook ITSELF decides on every tool call.
// Research experiments C1/F1/F2: an explicit `allow` from the hook removes the prompt in any mode
// and for any tool — so no prompt appears whatever the interface toggle says.
test('arbiter: a safe command → allow', () => {
  const d = decidePermission(bash('git status'), { mode: ARBITER });
  assert.equal(d.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(d.hookSpecificOutput.hookEventName, 'PreToolUse');
});

test('arbiter: a destructive command → deny with a clear reason', () => {
  const d = decidePermission(bash('git push --force'), { mode: ARBITER });
  assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /safety-guard/);
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /--force|force-overwrites/i);
});

test('arbiter: non-Bash tools also get allow (otherwise a prompt appears — experiment F1)', () => {
  for (const tool of ['Write', 'Edit', 'Read', 'WebFetch', 'mcp__github__create_pull_request']) {
    const d = decidePermission({ tool_name: tool, tool_input: { file_path: 'x' } }, { mode: ARBITER });
    assert.equal(d.hookSpecificOutput.permissionDecision, 'allow', `tool ${tool}`);
  }
});

test('arbiter: empty and malformed events do not break the decision', () => {
  for (const ev of [null, undefined, {}, { tool_name: 'Bash' }, { tool_name: 'Bash', tool_input: {} }]) {
    const d = decidePermission(ev, { mode: ARBITER });
    assert.equal(d.hookSpecificOutput.permissionDecision, 'allow');
  }
});

// The previous behaviour stays available: guard only, no permission decisions.
test('guard-only: safe → no decision (ordinary flow), destructive → deny', () => {
  assert.equal(decidePermission(bash('git status'), { mode: GUARD_ONLY }), null);
  const d = decidePermission(bash('rm -rf /'), { mode: GUARD_ONLY });
  assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
});

test('the mode comes from the environment, defaulting to arbiter', () => {
  assert.equal(resolveMode({}), ARBITER);
  assert.equal(resolveMode({ SAFETY_GUARD_MODE: 'guard-only' }), GUARD_ONLY);
  assert.equal(resolveMode({ SAFETY_GUARD_MODE: 'arbiter' }), ARBITER);
  assert.equal(resolveMode({ SAFETY_GUARD_MODE: 'nonsense' }), ARBITER, 'an unrecognised value → the safe default');
});

test('destructive commands are blocked in both modes (protection does not depend on the mode)', () => {
  for (const mode of [ARBITER, GUARD_ONLY]) {
    // v1.2.1: the set matches the minimal protection — only unrecoverable cases.
    for (const cmd of ['git push --force', 'rm -rf /', 'taskkill /IM claude.exe',
      'Format-Volume -DriveLetter C']) {
      const d = decidePermission(bash(cmd), { mode });
      assert.equal(d.hookSpecificOutput.permissionDecision, 'deny', `${cmd} in ${mode} mode`);
    }
  }
});

test('the tool_input.cmd field is supported alongside command', () => {
  const d = decidePermission({ tool_name: 'Bash', tool_input: { cmd: 'git push --force' } }, { mode: ARBITER });
  assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
});
