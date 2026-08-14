import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, isJunkAllowRule, settingsLevels } from '../../tools/doctor-permissions.mjs';

const level = (name, settings, state = 'ok') => ({ name, path: `/test/${name}.json`, state, settings });

test('finds ask rules — the main cause of prompts while bypass is enabled', () => {
  const p = diagnose([level('project', {
    permissions: { defaultMode: 'bypassPermissions', ask: ['Bash(pm2 *)'] },
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'x safety-guard' }] }] },
  })]);
  assert.equal(p.length, 1);
  assert.match(p[0].problem, /ask/);
  assert.match(p[0].consequence, /outranks any mode/);
});

// A broken settings file raises no error — it simply stops taking effect.
test('finds a broken settings file (otherwise the rules silently stop working)', () => {
  const p = diagnose([{ name: 'project', path: '/t/s.json', state: 'BROKEN', error: 'Unexpected token' }]);
  assert.equal(p.length, 1);
  assert.match(p[0].consequence, /SILENTLY/);
});

// A real case: a user's global hook checked $CLAUDE_TOOL_INPUT — a variable that does not exist.
test('finds a hook that reads a non-existent variable', () => {
  const p = diagnose([level('user', {
    permissions: { defaultMode: 'bypassPermissions' },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: 'if echo "$CLAUDE_TOOL_INPUT" | grep -q rm; then exit 2; fi' }] }] },
  })]);
  assert.equal(p.length, 1);
  assert.match(p[0].problem, /CLAUDE_TOOL_INPUT/);
  assert.match(p[0].consequence, /NEVER|imaginary/);
});

test('finds a missing mode and an unregistered arbiter hook', () => {
  const p = diagnose([level('project', { permissions: { allow: ['Read'] } })]);
  assert.ok(p.some(x => /defaultMode/.test(x.problem)));
  assert.ok(p.some(x => /safety-guard/.test(x.problem)));
});

test('finds junk allow entries (traces of the "always allow" button)', () => {
  const junk = 'Bash(ssh -o ConnectTimeout=10 root@1.2.3.4 "cd /home/projects && export A=1 && nohup python3 -m pytest tests/ -q > /tmp/log 2>&1 &")';
  const p = diagnose([level('user', {
    permissions: { defaultMode: 'bypassPermissions', allow: ['Bash(git *)', junk] },
  })]);
  const found = p.find(x => /hyper-specific/.test(x.problem));
  assert.ok(found, 'the junk entry must be found');
  assert.equal(found.entries.length, 1);
});

test('isJunkAllowRule: ordinary globs are not treated as junk', () => {
  for (const ok of ['Bash(git push *)', 'Read', 'Bash(npm test*)', 'Edit']) {
    assert.equal(isJunkAllowRule(ok), false, ok);
  }
  assert.equal(isJunkAllowRule('Bash(' + 'x'.repeat(200) + ')'), true);
});

test('correct settings produce no false positives', () => {
  const good = {
    permissions: { defaultMode: 'bypassPermissions', allow: ['Read', 'Bash(git push *)'], deny: ['Bash(rm -rf /)'] },
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '${CLAUDE_PROJECT_DIR}/hooks/run-hook.cmd safety-guard' }] }] },
  };
  assert.deepEqual(diagnose([level('project', good)]), []);
});

test('settings levels are listed in order of application', () => {
  const names = settingsLevels('/project', '/home').map(l => l.name);
  assert.deepEqual(names, ['user', 'project', 'local']);
});

test('missing files do not break the check', () => {
  assert.deepEqual(diagnose([{ name: 'project', path: '/none', state: 'no file' }]), []);
});
