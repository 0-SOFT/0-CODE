import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODE, ALLOW, DENY, buildPermissionsBlock, buildPreToolUseHook, findAskRules,
} from '../../core/permissions-policy.mjs';

// The key invariant of v1.2.0. Research (experiments B3, D1) proved that an `ask` rule outranks
// both the bypassPermissions mode AND the hook decision — i.e. it is a guaranteed permission
// prompt that nothing can switch off. In an autonomous framework there is nobody to ask,
// so the `ask` category must not exist as a concept.
test('policy: the `ask` category does not exist', () => {
  const block = buildPermissionsBlock();
  assert.equal(block.ask, undefined, 'the permissions block must not contain an ask key');
  assert.deepEqual(Object.keys(block).sort(), ['allow', 'defaultMode', 'deny']);
});

test('policy: the mode is set explicitly and can be overridden', () => {
  assert.equal(DEFAULT_MODE, 'bypassPermissions');
  assert.equal(buildPermissionsBlock().defaultMode, 'bypassPermissions');
  assert.equal(buildPermissionsBlock({ mode: 'default' }).defaultMode, 'default');
});

// v1.2.1: the denial list is a safety net for the case where the hook never runs, so it holds
// only unrecoverable cases where a glob cannot be wrong. Subtle decisions belong to the detector.
test('policy: deny holds only machine destruction and shared-history rewrites', () => {
  const deny = buildPermissionsBlock().deny;
  for (const rule of ['Bash(rm -rf /)', 'Bash(rm -rf ~)', 'Bash(git push --force*)'])
    assert.ok(deny.includes(rule), `deny must contain: ${rule}`);
});

test('policy: deny holds NO globs for routine operations (they would cause false refusals)', () => {
  const deny = buildPermissionsBlock().deny;
  const routine = ['git reset --hard', 'git clean', 'chmod 777', 'npm publish', 'git checkout'];
  for (const fragment of routine) {
    const found = deny.filter(r => r.includes(fragment));
    assert.deepEqual(found, [], `a glob on the routine operation "${fragment}" would block the loop`);
  }
});

test('policy: the denial list stays short', () => {
  assert.ok(buildPermissionsBlock().deny.length <= 10,
    'growing the denial list is a return to false refusals');
});

test('policy: routine loop operations are in allow (otherwise the loop stalls)', () => {
  const allow = buildPermissionsBlock().allow;
  const mustAllow = [
    'Read', 'Edit', 'Write', 'Glob', 'Grep',
    'Bash(git status)', 'Bash(git add *)', 'Bash(git commit *)',
    // moved out of ask: autonomous push is a routine operation; only --force is dangerous (it is in deny)
    'Bash(git push *)',
    // moved out of ask: installing tools and driving the loop are not destructive
    'Bash(npm install -g *)', 'Bash(pm2 *)',
    'Bash(node *)',
  ];
  for (const rule of mustAllow) assert.ok(allow.includes(rule), `allow must contain: ${rule}`);
});

test('policy: the lists carry no duplicates and no contradictions', () => {
  assert.equal(new Set(ALLOW).size, ALLOW.length, 'duplicates in allow');
  assert.equal(new Set(DENY).size, DENY.length, 'duplicates in deny');
  const overlap = ALLOW.filter(r => DENY.includes(r));
  assert.deepEqual(overlap, [], 'a rule cannot be in both allow and deny');
});

// Experiments C1/F1/F2: an `allow` decision from the hook removes the prompt in any mode and
// covers EVERY tool, not just Bash — so the matcher must be "*".
test('policy: the hook is registered for every tool', () => {
  const hooks = buildPreToolUseHook('${CLAUDE_PROJECT_DIR}/hooks/run-hook.cmd safety-guard');
  assert.equal(hooks.PreToolUse.length, 1);
  assert.equal(hooks.PreToolUse[0].matcher, '*', 'the matcher must cover every tool');
  assert.match(hooks.PreToolUse[0].hooks[0].command, /safety-guard/);
});

// A helper for diagnostics and for the settings-consistency test.
test('findAskRules: finds the forbidden category at any settings level', () => {
  assert.deepEqual(findAskRules({ permissions: { allow: ['Read'] } }), []);
  assert.deepEqual(findAskRules({ permissions: { ask: ['Bash(pm2 *)'] } }), ['Bash(pm2 *)']);
  assert.deepEqual(findAskRules(null), []);
  assert.deepEqual(findAskRules({}), []);
});
