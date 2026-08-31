import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTemplateSettings, applyPolicyToSettings, diffAgainstPolicy, readJson,
  cureSettings, phantomHooks,
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

// --- v1.10.0: the framework learns to cure, not only to diagnose --------------------------------
//
// The doctor used to name the disease and point at `node tools/gen-settings.mjs`, a command that
// knew only its own two files and did nothing at all to somebody else's project. Re-running
// bootstrap did not help either: it deep-merges, a merge unions arrays, and the template has no
// `ask` key to displace the project's with. So a real project stayed broken while the framework
// reported that it knew exactly what was wrong.

const withAsk = () => ({
  permissions: {
    defaultMode: 'bypassPermissions',
    ask: ['Bash(rm -rf *)', 'Bash(git checkout -- *)'],
    allow: ['Bash(git status)', `Bash(node -e 'const x = "${'y'.repeat(60)}"')`],
    deny: [],
  },
  hooks: { SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: 'echo bye' }] }] },
});

test('cure: the ask category is removed from a project the framework owns', () => {
  const { settings, changes } = cureSettings(withAsk(), { owned: true });
  assert.equal(settings.permissions.ask, undefined, 'no ask key may survive');
  assert.equal(findAskRules(settings).length, 0);
  assert.ok(changes.some(c => /ask category/.test(c)), 'the change is reported, not silent');
});

// The whole point of removing `ask` rather than sorting it into deny: the deny list is deliberately
// tiny. Growing it would bring back the v1.2.0 measurement where 7 of 11 everyday commands were
// blocked by mistake.
test('cure: removing ask does not grow the deny list', () => {
  const { settings } = cureSettings(withAsk(), { owned: true });
  const expected = applyPolicyToSettings({}).permissions.deny;
  assert.deepEqual(settings.permissions.deny, expected, 'deny stays exactly the policy list');
  assert.ok(!settings.permissions.deny.includes('Bash(rm -rf *)'),
    'a blanket rm -rf rule would block cleaning a build directory');
});

test('cure: a project keeps its own unrelated hooks', () => {
  const { settings } = cureSettings(withAsk(), { owned: true });
  assert.ok(settings.hooks.SessionEnd, 'the project had a SessionEnd hook and still does');
});

// settings.local.json and the user-level file are personal. Curing them wholesale would throw away
// somebody's own configuration, so there the cure only removes what actively breaks autonomy.
test('cure: a file the framework does not own is treated surgically', () => {
  const personal = withAsk();
  personal.permissions.allow.push('Bash(my-own-tool *)');
  const { settings, changes } = cureSettings(personal, { owned: false });

  assert.equal(settings.permissions.ask, undefined, 'ask still goes: it outranks every mode');
  assert.ok(settings.permissions.allow.includes('Bash(my-own-tool *)'), 'personal rules stay');
  assert.ok(settings.permissions.allow.includes('Bash(git status)'), 'and so do sensible globs');
  assert.ok(!settings.permissions.allow.some(r => r.length > 120), 'the "always allow" residue goes');
  assert.ok(changes.some(c => /hyper-specific/.test(c)));
});

test('cure: a healthy file reports no changes', () => {
  const { changes } = cureSettings(applyPolicyToSettings({}), { owned: true });
  assert.ok(!changes.some(c => /ask|hyper-specific/.test(c)), 'nothing to remove');
});

// A hook reading a variable the contract does not define never fires, so the protection it looks
// like is imaginary. It is reported rather than deleted: what it meant to check is a human
// judgement, and quietly removing somebody's guard would repeat the very mistake being fixed.
test('cure: a hook reading a phantom variable is reported, never silently deleted', () => {
  const s = { hooks: { PreToolUse: [{ matcher: '*', hooks: [
    { type: 'command', command: 'node -e "if (process.env.CLAUDE_TOOL_INPUT) {}"' }] }] } };
  const { settings, needsHuman } = cureSettings(s, { owned: false });
  assert.deepEqual(needsHuman, ['CLAUDE_TOOL_INPUT']);
  assert.ok(settings.hooks.PreToolUse, 'the hook is still there for a human to decide about');
});

test('phantomHooks: an honest hook reading stdin is not flagged', () => {
  assert.deepEqual(phantomHooks({ hooks: { PreToolUse: [{ matcher: '*', hooks: [
    { type: 'command', command: '${CLAUDE_PROJECT_DIR}/hooks/run-hook.cmd safety-guard' }] }] } }), []);
});
