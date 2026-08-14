import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTemplateSettings, applyPolicyToSettings, diffAgainstPolicy, readJson,
  TEMPLATE_PATH, SELF_PATH,
} from '../../tools/gen-settings.mjs';
import { findAskRules } from '../../core/permissions-policy.mjs';

// A research finding: the framework's own settings and the template for target projects had
// drifted apart — the template registered the safety-guard hook while the framework itself had
// makes drift impossible: any manual edit of the file breaks this test.
test('the project template matches the policy (otherwise rebuild it with the generator)', () => {
  const onDisk = readJson(TEMPLATE_PATH);
  assert.ok(onDisk, 'templates/project-settings.json must exist');
  assert.equal(onDisk.__parseError, undefined, 'the template must be valid JSON');
  assert.equal(
    JSON.stringify(onDisk, null, 2),
    JSON.stringify(buildTemplateSettings(), null, 2),
    'the template drifted from core/permissions-policy.mjs — run node tools/gen-settings.mjs',
  );
});

test('the settings of the framework itself match the policy', () => {
  const self = readJson(SELF_PATH);
  assert.ok(self, '.claude/settings.json must exist');
  assert.equal(self.__parseError, undefined, 'the framework settings must be valid JSON');
  assert.deepEqual(diffAgainstPolicy(self), [], 'the framework settings drifted from the policy');
});

test('neither file contains the forbidden ask category', () => {
  for (const path of [TEMPLATE_PATH, SELF_PATH]) {
    assert.deepEqual(findAskRules(readJson(path)), [], `the ask category was found in ${path}`);
  }
});

test('both files register the arbiter hook for every tool', () => {
  for (const path of [TEMPLATE_PATH, SELF_PATH]) {
    const s = readJson(path);
    const entries = s.hooks.PreToolUse || [];
    assert.ok(entries.some(e => e.matcher === '*' &&
      (e.hooks || []).some(h => String(h.command).includes('safety-guard'))),
      `${path} has no safety-guard hook with matcher "*"`);
  }
});

// Normalising to the policy must not wipe hooks the project added itself.
test('applyPolicyToSettings preserves the other hooks of the project', () => {
  const existing = {
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'my-script' }] }] },
    permissions: { ask: ['Bash(pm2 *)'], allow: ['Bash(something)'] },
  };
  const out = applyPolicyToSettings(existing);
  assert.equal(JSON.stringify(out.hooks.Stop), JSON.stringify(existing.hooks.Stop), 'Stop must be preserved');
  assert.deepEqual(findAskRules(out), [], 'the ask category must disappear after normalisation');
  assert.equal(out.permissions.defaultMode, 'bypassPermissions');
  assert.ok((out.hooks.PreToolUse || []).some(e => e.matcher === '*'));
});

test('applyPolicyToSettings does not duplicate an already registered hook', () => {
  const once = applyPolicyToSettings({});
  const twice = applyPolicyToSettings(once);
  assert.equal(twice.hooks.PreToolUse.length, 1, 'a repeated run must not multiply entries');
});

test('diffAgainstPolicy reports the specific differences', () => {
  assert.ok(diffAgainstPolicy({}).length > 0, 'empty settings count as drift');
  const withAsk = { permissions: { ...buildTemplateSettings().permissions, ask: ['Bash(pm2 *)'] },
    hooks: buildTemplateSettings().hooks };
  const problems = diffAgainstPolicy(withAsk);
  assert.ok(problems.some(p => p.includes('ask')), 'the ask category must appear in the report');
});
