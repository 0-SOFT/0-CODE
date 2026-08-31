import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePermission, ARBITER, GUARD_ONLY, ALLOW_ALL, CONFIRM, resolveMode } from '../../core/permission-decision.mjs';

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
  assert.equal(resolveMode({}).mode, ARBITER);
  assert.equal(resolveMode({ SAFETY_GUARD_MODE: 'guard-only' }).mode, GUARD_ONLY);
  assert.equal(resolveMode({ SAFETY_GUARD_MODE: 'arbiter' }).mode, ARBITER);
  // v1.10.0 changed the contract here on purpose. The safe default still wins on a bad value —
  // a typo must not halt the loop — but this assertion used to end at "→ the safe default", and
  // that full stop was the defect: the substitution happened without a word to anyone.
  const bad = resolveMode({ SAFETY_GUARD_MODE: 'nonsense' });
  assert.equal(bad.mode, ARBITER, 'an unrecognised value → the safe default');
  assert.equal(bad.recognised, false, 'and the caller is told, rather than left to assume');
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

// --- v1.10.0: an explicit "off", and an end to silent fallbacks -------------------------------
//
// Two defects, one class. First: the guard has never had an off switch — both existing modes deny,
// so a user who wants no interference has nowhere to go. Second, and worse: any unrecognised value
// was swallowed. `SAFETY_GUARD_MODE=off` looked like switching the guard off and did nothing at
// all, because the resolver quietly returned the default and said nothing. What somebody wrote and
// what happened diverged in silence — the same class this project has now fixed six times.

test('allow-all: nothing is denied, not even destroying the filesystem', () => {
  for (const cmd of ['rm -rf /', 'git push --force', 'mkfs.ext4 /dev/sda', 'taskkill /IM claude.exe']) {
    const d = decidePermission(bash(cmd), { mode: ALLOW_ALL });
    assert.equal(d.hookSpecificOutput.permissionDecision, 'allow', `${cmd} must pass in allow-all`);
  }
});

test('allow-all: the reason names the mode, so "I switched it off" can be checked', () => {
  const d = decidePermission(bash('rm -rf /'), { mode: ALLOW_ALL });
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /allow-all/,
    'the acting mode is stated in the decision itself');
});

test('the resolver reports what was asked for, not only what it decided', () => {
  const known = resolveMode({ SAFETY_GUARD_MODE: 'guard-only' });
  assert.equal(known.mode, GUARD_ONLY);
  assert.equal(known.recognised, true);

  const absent = resolveMode({});
  assert.equal(absent.mode, ARBITER, 'no variable → the safe default');
  assert.equal(absent.recognised, true, 'not asking for anything is not a mistake');
});

// The heart of the fix: the default is still applied — a typo must not stop the work — but the
// substitution stops being invisible. Refusing outright would turn a typo into a halted loop;
// silence turns it into a guard the user believes they disabled.
test('an unrecognised value keeps the safe default AND is reported', () => {
  const r = resolveMode({ SAFETY_GUARD_MODE: 'off' });
  assert.equal(r.mode, ARBITER, 'the safe default still applies');
  assert.equal(r.recognised, false, 'but the value was not understood');
  assert.equal(r.requested, 'off', 'and what was asked for is preserved for the message');
});

test('every documented mode is recognised', () => {
  for (const mode of [ARBITER, GUARD_ONLY, ALLOW_ALL]) {
    const r = resolveMode({ SAFETY_GUARD_MODE: mode });
    assert.equal(r.mode, mode);
    assert.equal(r.recognised, true, `${mode} must be a documented mode`);
  }
});

// Regression: switching the guard off is opt-in. The default must not have moved.
test('regression: without the variable the guard protects exactly as before', () => {
  const { mode } = resolveMode({});
  for (const cmd of ['rm -rf /', 'git push --force']) {
    assert.equal(decidePermission(bash(cmd), { mode }).hookSpecificOutput.permissionDecision, 'deny');
  }
  assert.equal(decidePermission(bash('git status'), { mode }).hookSpecificOutput.permissionDecision, 'allow');
});

// --- v1.11.0: the confirm mode ------------------------------------------------------------------
//
// Refusing tells an agent it may not. Confirming makes it say why it should. The second is the more
// useful answer wherever a command has a legitimate use, because the framework does not know the
// task and the agent does — and a decision with a stated reason can be reviewed afterwards, which a
// silent refusal cannot.

const confirmed = (cmd, why) => bash(`${cmd} # safety-guard: confirmed ${why}`);

test('confirm: a dangerous command without a marker is refused, and told how to proceed', () => {
  const d = decidePermission(bash('git push --force origin main'), { mode: CONFIRM });
  assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
  const why = d.hookSpecificOutput.permissionDecisionReason;
  assert.match(why, /force-overwrites/, 'the consequence is named');
  assert.match(why, /safety-guard: confirmed/, 'and so is the exact way to confirm');
});

test('confirm: the same command with a stated reason goes through', () => {
  const d = decidePermission(
    confirmed('git push --force origin feature', 'my own branch, rebased, nobody else pushed'),
    { mode: CONFIRM });
  assert.equal(d.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /rebased/,
    'the stated reason travels with the decision, so it lands in the log');
});

// Without this the marker degenerates into a keystroke: an agent stuck in a retry loop would append
// it mechanically and nothing would have been reconsidered.
test('confirm: an empty or throwaway reason is not a confirmation', () => {
  for (const why of ['', '   ', 'ok', 'yes', 'because']) {
    const d = decidePermission(confirmed('git push --force origin main', why), { mode: CONFIRM });
    assert.equal(d.hookSpecificOutput.permissionDecision, 'deny', `"${why}" must not count as a reason`);
  }
});

test('confirm: a hard rule is refused even with a marker, and says why arguing will not help', () => {
  for (const cmd of ['rm -rf /', 'mkfs.ext4 /dev/sdb1', 'taskkill /IM claude.exe']) {
    const d = decidePermission(confirmed(cmd, 'a very carefully considered reason'), { mode: CONFIRM });
    assert.equal(d.hookSpecificOutput.permissionDecision, 'deny', `${cmd} must stay refused`);
    assert.match(d.hookSpecificOutput.permissionDecisionReason, /cannot be confirmed/i);
  }
});

// The advisory level exists only here. In arbiter these commands are allowed, exactly as they have
// been since v1.2.1 — bringing them back into the default would restore the false refusals that
// version removed.
test('confirm: advisory rules ask for a reason; other modes never see them', () => {
  const cmd = 'git clean -fdx';
  assert.equal(decidePermission(bash(cmd), { mode: ARBITER }).hookSpecificOutput.permissionDecision,
    'allow', 'unchanged in the default mode');

  const asked = decidePermission(bash(cmd), { mode: CONFIRM });
  assert.equal(asked.hookSpecificOutput.permissionDecision, 'deny');
  const passed = decidePermission(confirmed(cmd, 'a disposable clone, nothing untracked worth keeping'),
    { mode: CONFIRM });
  assert.equal(passed.hookSpecificOutput.permissionDecision, 'allow');
});

test('confirm: safe commands are allowed without any ceremony', () => {
  assert.equal(decidePermission(bash('git status'), { mode: CONFIRM })
    .hookSpecificOutput.permissionDecision, 'allow');
});

// Regression: the marker is a feature of one mode, not a global escape hatch.
test('the marker means nothing outside the confirm mode', () => {
  for (const mode of [ARBITER, GUARD_ONLY]) {
    const d = decidePermission(confirmed('rm -rf /', 'a perfectly good reason'), { mode });
    assert.equal(d.hookSpecificOutput.permissionDecision, 'deny', `${mode}: still refused`);
  }
});

test('confirm is a documented mode of its own', () => {
  const r = resolveMode({ SAFETY_GUARD_MODE: CONFIRM });
  assert.equal(r.mode, CONFIRM);
  assert.equal(r.recognised, true);
});
