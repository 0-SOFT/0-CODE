import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  head, segmentReason, destructiveReason, destructiveVerdict, confirmationOf, HARD,
} from '../../core/safety.mjs';
import { decidePermission } from '../../core/permission-decision.mjs';
import { evaluateCodexHook } from '../../core/backends/codex-hook.mjs';
import { OpenCodeBackend } from '../../core/backends/opencode.mjs';

// v1.2.1 — protection reduced to a minimum. Only rules where the consequence is unrecoverable AND
// there is essentially no legitimate use inside a development loop survived. Everything else was
// removed deliberately: a measurement showed 7 false positives across 11 everyday operations, and
// each one costs the loop a turn (three in a row become a blocker).

const ASSEMBLED_SQL = 'DROP ' + 'TABLE';   // assembled from parts so the string itself is not matched

test('blocked: destroying the filesystem (POSIX)', () => {
  for (const cmd of ['rm -rf /', 'rm -rf /*', 'rm -rf ~', 'rm -rf ~/*', 'rm -rf $HOME',
    'sudo rm -rf /', 'sudo rm -rf ~']) {
    assert.ok(destructiveReason(cmd), `must be blocked: ${cmd}`);
  }
});

test('all three guards inspect commands behind wrappers, paths and explicit shells', () => {
  const opencode = new OpenCodeBackend();
  for (const command of [
    'env git push --force', 'env CHECK=fixture command /usr/bin/git push --force',
    'CHECK=fixture /usr/bin/env command git push --force',
    '/usr/bin/git push --force', 'command rm -rf /', 'rm --recursive /',
    'bash -c "git push --force"', "bash -lc 'rm --recursive /'",
    '/bin/sh -c "git push --force"',
    'powershell -NoProfile -Command "Remove-Item -Recurse C:/"',
    'pwsh -Command "git push --force"', 'cmd /c "git push --force"',
    'git -C "repo with spaces" push "--force"',
    '"C:\\Program Files\\Git\\bin\\git.exe" push --force',
  ]) {
    const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
    assert.ok(opencode.guardCommand(command), `OpenCode must refuse: ${command}`);
    assert.equal(decidePermission(event, { mode: 'arbiter' }).hookSpecificOutput.permissionDecision, 'deny', command);
    assert.equal(evaluateCodexHook(JSON.stringify(event), decidePermission)?.hookSpecificOutput.permissionDecision,
      'deny', `Codex must refuse: ${command}`);
  }
});

test('wrapper inspection keeps quoted data and ordinary nested commands allowed', () => {
  for (const command of [
    'echo "bash -c git push --force"', 'grep -n "env rm --recursive /" source.txt',
    "bash -c 'echo \"git push --force\"'", 'pwsh -Command "Write-Output hello"',
    'cmd /c "echo hello"', 'env CHECK=fixture /usr/bin/git push origin main',
    'command rm --recursive ./build', 'git -C "repo with spaces" push --force-with-lease',
  ]) assert.equal(destructiveReason(command), null, command);
});

test('all three guards inspect UTF-16LE PowerShell encoded command aliases', () => {
  const opencode = new OpenCodeBackend();
  for (const shell of ['powershell', 'pwsh']) for (const flag of ['-EncodedCommand', '-enc', '-ec', '-e', '/ec', '–EncodedCommand', '—EncodedCommand']) {
    for (const script of ['Remove-Item -Recurse C:/', 'git push --force']) {
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const command = `${shell} -NoProfile -ExecutionPolicy Bypass ${flag} "${encoded.slice(0, 8)} ${encoded.slice(8)}"`;
      const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
      assert.ok(opencode.guardCommand(command), shell + ' ' + flag);
      assert.equal(decidePermission(event, { mode: 'arbiter' }).hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(evaluateCodexHook(JSON.stringify(event), decidePermission)?.hookSpecificOutput.permissionDecision, 'deny');
    }
  }
});

test('PowerShell file arguments, quoted encoded data and ordinary encoded scripts stay allowed', () => {
  const danger = Buffer.from('git push --force', 'utf16le').toString('base64');
  const harmless = Buffer.from('Write-Output "git push --force"', 'utf16le').toString('base64');
  for (const command of [`powershell -EncodedCommand ${harmless}`, `echo "powershell -e ${danger}"`,
    `powershell -File ./data.ps1 -EncodedCommand ${danger}`, 'powershell -File ./data.ps1 -Command "git push --force"',
    'powershell -EncodedCommand invalid!!', 'powershell -EncodedCommand QQ==']) {
    const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
    assert.equal(destructiveReason(command), null, command);
    assert.equal(decidePermission(event, { mode: 'arbiter' }).hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(evaluateCodexHook(JSON.stringify(event), decidePermission), null);
  }
});

test('a hard danger anywhere outranks a confirmed force push in a compound command', () => {
  for (const suffix of ['rm -rf /', "bash -c 'rm --recursive /'"]) {
    const command = `git push --force && ${suffix} # safety-guard: confirmed rebased my own private experimental branch after reviewing all changes`;
    assert.equal(destructiveVerdict(command).level, HARD);
    assert.equal(decidePermission({ tool_name: 'Bash', tool_input: { command } }, { mode: 'confirm' })
      .hookSpecificOutput.permissionDecision, 'deny');
  }
});

test('blocked: destroying the filesystem (Windows)', () => {
  for (const cmd of ['Remove-Item -Recurse -Force C:\\', 'Remove-Item -Path ~ -Recurse',
    'rd /s /q C:\\', 'rmdir /s /q %USERPROFILE%', 'del /f /s /q C:\\*']) {
    assert.ok(destructiveReason(cmd), `must be blocked: ${cmd}`);
  }
});

test('the standalone Windows format help query stays allowed, an actual format stays hard', () => {
  for (const command of ['format /?', 'format.com /?', 'cmd /c "format /?"']) {
    assert.equal(destructiveVerdict(command), null, command);
  }
  for (const command of ['format C:', 'format C: /Q', 'format /? && format C:', 'format /? C:']) {
    assert.equal(destructiveVerdict(command)?.level, HARD, command);
  }
});

test('PowerShell presentation cmdlets remain allowed through all three guard APIs', () => {
  const opencode = new OpenCodeBackend();
  const script = 'Get-ChildItem . | Format-Table -AutoSize';
  for (const command of [script, 'Format-Table -AutoSize', 'Format-List *',
    'Format-Wide -Column 2', 'Format-Custom', `powershell -NoProfile -Command "${script}"`,
    `pwsh -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`]) {
    const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
    assert.equal(destructiveVerdict(command), null, command);
    assert.equal(decidePermission(event, { mode: 'arbiter' }).hookSpecificOutput.permissionDecision, 'allow', command);
    assert.equal(evaluateCodexHook(JSON.stringify(event), decidePermission), null, command);
    assert.equal(opencode.guardCommand(command), null, command);
  }
});

test('presentation cmdlets never hide real disk formatting or attached Windows switches', () => {
  const opencode = new OpenCodeBackend();
  for (const command of ['format Z:', 'format.com/Q Z:', 'format.exe/Q Z:', 'FORMAT/V:FIXTURE Z:',
    'Format-Volume -DriveLetter Z', 'Clear-Disk -Number 99', 'mkfs.ext4 /dev/fixture', 'diskpart',
    'Get-ChildItem . | Format-Table; Format-Volume -DriveLetter Z',
    'powershell -NoProfile -Command "Format-Volume -DriveLetter Z"', 'cmd /c "format.com/Q Z:"']) {
    const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
    assert.equal(destructiveVerdict(command)?.level, HARD, command);
    assert.equal(decidePermission(event, { mode: 'arbiter' }).hookSpecificOutput.permissionDecision, 'deny', command);
    assert.equal(evaluateCodexHook(JSON.stringify(event), decidePermission)?.hookSpecificOutput.permissionDecision, 'deny', command);
    assert.ok(opencode.guardCommand(command), command);
  }
});

test('attached native Windows switches preserve known command identity across all guards', () => {
  const opencode = new OpenCodeBackend();
  for (const command of ['diskpart/s fixture.txt', 'taskkill/F /IM node.exe',
    'rd/s /q C:\\', 'del/f /s /q C:\\*', 'cmd/c "format.com/Q Z:"',
    'C:/Windows/System32/format.com/Q Z:', '.\\format.com/Q Z:',
    '"C:\\Windows\\System32\\format.com/Q" Z:', '\\Windows\\System32\\format.com/Q Z:',
    'tools\\format.com/Q Z:', '\\\\server\\share\\format.com/Q Z:',
    '\\\\?\\C:\\Windows\\System32\\format.com/Q Z:',
    'cmd/cformat Z:', 'cmd/c"format Z:"', 'cmd /cformat Z:',
    'cmd/kformat Z:', 'cmd /d /s /c"format Z:"']) {
    const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
    assert.equal(destructiveVerdict(command)?.level, HARD, command);
    assert.equal(decidePermission(event, { mode: 'arbiter' }).hookSpecificOutput.permissionDecision, 'deny', command);
    assert.equal(evaluateCodexHook(JSON.stringify(event), decidePermission)?.hookSpecificOutput.permissionDecision, 'deny', command);
    assert.ok(opencode.guardCommand(command), command);
  }
  for (const command of ['format.com/?', 'cmd/c "format /?"', 'cmd/c "echo fixture"',
    './format/Q fixture', '/tmp/format/Q fixture', 'C:/tools/ordinary.exe/Q fixture',
    'cmd/cecho "format Z:"', 'cmd/c"echo format Z:"', 'cmd /cecho "format Z:"',
    'cmd/kecho "format Z:"', 'cmd /d /s /c"echo format Z:"']) {
    assert.equal(destructiveVerdict(command), null, command);
  }
});

test('blocked: formatting and wiping disks', () => {
  for (const cmd of ['Format-Volume -DriveLetter C', 'Clear-Disk -Number 0',
    'mkfs.ext4 /dev/sda1', 'diskpart']) {
    assert.ok(destructiveReason(cmd), `must be blocked: ${cmd}`);
  }
});

// This rule works FOR autonomy: mass-killing by image name cuts the loop itself.
test('blocked: mass-killing the agent processes (the loop killing itself)', () => {
  for (const cmd of ['taskkill /IM claude.exe', 'taskkill /F /IM node.exe',
    'pkill -f claude', 'killall node']) {
    assert.ok(destructiveReason(cmd), `must be blocked: ${cmd}`);
  }
});

test('blocked: force-rewriting shared history', () => {
  for (const cmd of ['git push --force', 'git push -f origin main',
    'git push origin main --force']) {
    assert.ok(destructiveReason(cmd), `must be blocked: ${cmd}`);
  }
  // v1.11.0 took --force-with-lease out of this list on purpose. It refuses to overwrite anything
  // that appeared after your last fetch, so it is the careful form and the ordinary way to push a
  // rebased branch of your own — a turn lost on it prevented nothing.
  assert.equal(destructiveReason('git push origin main --force-with-lease'), null);
});

// THE key test of this version: everyday development commands. The v1.2.0 measurement produced
// 7 refusals out of 11 here.
test('NOT blocked: everyday loop operations (the false-positive measurement)', () => {
  const routine = [
    [`grep -r "${ASSEMBLED_SQL}" src/`, 'searching for text in the codebase'],
    [`git commit -m "fix: guard against ${ASSEMBLED_SQL} injection"`, 'the text of a commit message'],
    [`psql -c "${ASSEMBLED_SQL} temp_import"`, 'dropping a temporary table on purpose'],
    ['taskkill /F /PID 1234', 'killing a process by id'],
    ['kill -9 4321', 'the same on POSIX'],
    ['rm -rf ~/projects/build', 'cleaning a build directory inside home'],
    ['rm -rf node_modules', 'cleaning dependencies'],
    ['npm publish --dry-run', 'a dry-run publish'],
    ['npm publish', 'publishing a package on purpose'],
    ['git clean -fdx', 'a routine repository cleanup'],
    ['git reset --hard origin/main', 'aligning a branch with the remote'],
    ['git checkout -- src/file.js', 'reverting a single file'],
    ['git checkout -- .', 'reverting the working tree'],
    ['Remove-Item -Recurse -Force node_modules', 'cleaning dependencies on Windows'],
    ['rd /s /q .\\build', 'cleaning a build directory on Windows'],
    ['chmod 777 /tmp/socket', 'permissions on a temporary socket'],
    ['git commit --no-verify -m x', 'committing while skipping git hooks'],
    ['docker system prune -f', 'cleaning up images'],
    ['kubectl delete pod x', 'deleting a pod'],
    ['git push origin main', 'an ordinary push'],
    ['ls -la', 'listing a directory'],
  ];
  const falsePositives = routine.filter(([cmd]) => destructiveReason(cmd));
  assert.deepEqual(falsePositives.map(([c]) => c), [],
    'no routine operation may be blocked');
});

// Found by the v1.6.0 documentation audit, and found the expensive way: this refusal cost a turn
// during the audit itself. The splitter used to cut on separator characters without regard for
// quoting, so the pipes inside a regex made `mkfs` the head of a segment and an ordinary search was
// refused as "formatting or wiping a disk". The comment above the splitter claimed the opposite —
// that quoting protected against exactly this.
test('NOT blocked: separators inside quotes are arguments, not commands', () => {
  const quoted = [
    ['grep -iE "rule|mkfs|reset" core/safety.mjs', 'an alternation regex containing a dangerous word'],
    ["grep -E 'format|diskpart' docs/", 'the same in single quotes'],
    ['grep -rn "rm -rf /" tests/', 'searching for the text of a dangerous command'],
    ['echo "a && b; c | d"', 'separators inside a quoted string'],
    ['git commit -m "document the mkfs rule"', 'a commit message naming a rule'],
    ['node -e "console.log(\'a|mkfs\')"', 'a quoted script containing both'],
  ];
  const falsePositives = quoted.filter(([cmd]) => destructiveReason(cmd));
  assert.deepEqual(falsePositives.map(([c]) => c), [],
    'quoted text is an argument — the shell will not execute it, and neither may the guard read it as a command');
});

test('still blocked: real separators outside quotes', () => {
  // The fix must not buy comfort with coverage: a genuinely chained destructive command is still
  // a destructive command.
  for (const cmd of ['npm test && rm -rf /', 'echo hi; mkfs.ext4 /dev/sdb',
    'ls | pkill node', 'git add -A && git push --force origin main']) {
    assert.ok(destructiveReason(cmd), `must be blocked: ${cmd}`);
  }
});

// The second half of the same audit finding. Teaching the splitter about quotes was not enough:
// a heredoc body is arbitrary text, and one apostrophe inside it inverts the quote state so that
// pipes several lines later read as separators. The body is data — a Python script, a file being
// written, a commit message — and the shell does not execute it.
test('NOT blocked: heredoc bodies are data, not commands', () => {
  const DANGEROUS = 'mk' + 'fs';           // assembled, so this test file cannot trip the guard
  const search = `grep -iE "rule|${DANGEROUS}|reset" core/safety.mjs`;
  const data = [
    [`python - <<'PY'\ns = "${search}"\nPY`, 'a dangerous word inside a python string'],
    [`python - <<'PY'\nx = "it's fine"\ny = "${search}"\nPY`, 'an apostrophe earlier in the body'],
    [`cat > notes.md <<'EOF'\nNever run ${DANGEROUS}.ext4 /dev/sda\nEOF`, 'writing documentation about it'],
    [`git commit -F - <<'MSG'\nfix: document the ${DANGEROUS} rule\nMSG`, 'a commit message'],
  ];
  const falsePositives = data.filter(([cmd]) => destructiveReason(cmd));
  assert.deepEqual(falsePositives.map(([c]) => c.split('\n')[0]), [],
    'the shell does not execute a heredoc body, and neither may the guard read it as commands');
});

test('still blocked: a heredoc body that IS executed', () => {
  // The exception that keeps the fix honest: when a shell reads the body, the body is commands.
  const DANGEROUS = 'mk' + 'fs';
  for (const cmd of [`bash <<'EOF'\nrm -rf /\nEOF`, `sh <<'EOF'\n${DANGEROUS}.ext4 /dev/sda1\nEOF`]) {
    assert.ok(destructiveReason(cmd), `must be blocked: ${cmd.split('\n')[0]}`);
  }
});

test('head: strips env assignments, wrappers and the sudo prefix', () => {
  assert.equal(head('FOO=bar rm -rf /'), 'rm -rf /');
  assert.equal(head('nohup rm -rf /'), 'rm -rf /');
  assert.equal(head('sudo rm -rf /'), 'rm -rf /');
  assert.equal(head('timeout 30 rm -rf /'), 'rm -rf /');
});

test('compounds: a dangerous segment is found in any position', () => {
  assert.ok(destructiveReason('git add . && git push --force'));
  assert.ok(destructiveReason('cd /tmp && rm -rf /'));
  assert.equal(destructiveReason('git add . && git commit -m x && git push'), null);
});

test('segmentReason and destructiveReason: empty and non-string input', () => {
  assert.equal(destructiveReason(''), null);
  assert.equal(destructiveReason(null), null);
  assert.equal(destructiveReason(undefined), null);
  assert.equal(destructiveReason(42), null);
  assert.equal(segmentReason(''), null);
});

// --- v1.11.0: rules gain a level, and a command can carry its own confirmation ----------------
//
// The idea, from the framework's owner: instead of refusing outright, name the consequence and make
// the agent confirm with a reason. If it still decides to go ahead after reconsidering, that is an
// argued decision in context rather than blind execution.
//
// The limit of that idea, and why levels exist at all: you are asking the same judgement twice — the
// agent confirming is the agent that proposed the command. It helps exactly where the command has a
// legitimate use (a force push after a rebase) and never where it has none (destroying the machine).
// Allowing confirmation everywhere would turn the mode into allow-all with an extra keystroke.

test('levels: catastrophic rules are hard, a force push is confirmable', () => {
  const hard = ['rm -rf /', 'sudo rm -rf ~', 'mkfs.ext4 /dev/sdb1', 'taskkill /IM claude.exe'];
  for (const cmd of hard) {
    const v = destructiveVerdict(cmd);
    assert.ok(v, `must be detected: ${cmd}`);
    assert.equal(v.level, 'hard', `${cmd}: no context makes this the right answer`);
  }
  const push = destructiveVerdict('git push --force origin main');
  assert.equal(push.level, 'confirmable', 'a force push has legitimate uses, so it can be argued for');
});

// The advisory level is the point of the version: it costs a rewritten command instead of a lost
// turn, so rules dropped in v1.2.1 for being too expensive can come back — but only here.
test('levels: advisory rules stay invisible unless asked for', () => {
  const advisory = ['git clean -fdx', 'git reset --hard origin/main', 'docker run -v /:/host alpine ls'];
  for (const cmd of advisory) {
    assert.equal(destructiveVerdict(cmd), null, `${cmd} must not be detected by default`);
    assert.equal(destructiveReason(cmd), null, `${cmd} must stay allowed in every existing mode`);
    const v = destructiveVerdict(cmd, { advisory: true });
    assert.ok(v, `${cmd} must be detected when advisory rules are on`);
    assert.equal(v.level, 'advisory');
  }
});

// destructiveReason is the old contract, used by the OpenCode adapter as well. It must keep
// returning a plain string and must not start reporting advisory rules.
test('the old destructiveReason contract is unchanged', () => {
  assert.equal(typeof destructiveReason('rm -rf /'), 'string');
  assert.equal(destructiveReason('git status'), null);
  assert.equal(destructiveReason('git clean -fdx'), null, 'advisory rules must not leak into it');
});

// A careful force push refuses to overwrite work that appeared after your last fetch. Blocking it
// alongside the blind form cost the loop a turn on an ordinary rebase-then-push.
test('--force-with-lease is allowed, the blind force is not', () => {
  assert.equal(destructiveReason('git push --force-with-lease origin feature'), null);
  assert.equal(destructiveReason('git push --force-with-lease=refs/heads/x origin x'), null);
  assert.ok(destructiveReason('git push --force origin main'));
  assert.ok(destructiveReason('git push -f origin main'));
  assert.ok(destructiveReason('git push origin main --force'));
});

test('confirmationOf: the stated reason is read out of the command', () => {
  const cmd = 'git push --force origin f # safety-guard: confirmed my own branch after a rebase';
  assert.equal(confirmationOf(cmd), 'my own branch after a rebase');
  assert.equal(confirmationOf('git push --force origin f'), null, 'no marker, no confirmation');
  assert.equal(confirmationOf('echo "# safety-guard: confirmed x"'), null,
    'a marker inside quotes is text, not a decision');
});

// The marker must not hide the danger: the guard decides in the order "detect, then look for the
// confirmation". If appending it made the command look harmless, it would be an escape hatch.
test('a confirmation marker does not mask the danger', () => {
  for (const cmd of ['rm -rf /', 'git push --force origin main']) {
    assert.ok(destructiveReason(`${cmd} # safety-guard: confirmed a good reason here`),
      `${cmd}: the danger must still be seen`);
  }
});

// v1.13.0. Blocking the turn to wait is the defect this release exists for: `sleep` appeared 447
// times in one real session, in thirty-nine `until … do sleep N; done` loops, with pauses up to 900
// seconds inside a single tool call. It is advisory rather than forbidden on purpose — a short sleep
// is sometimes the honest thing, and refusing it would cost a turn, which is the very waste being
// fixed.
test('advisory: a shell loop that waits blocks the turn', () => {
  const cmds = [
    'until grep -q DONE log.txt; do sleep 15; done',
    'while ! test -f ready; do sleep 10; done',
    'sleep 900',
  ];
  for (const c of cmds) {
    assert.equal(destructiveReason(c), null, `${c} must stay allowed by default`);
    const v = destructiveVerdict(c, { advisory: true });
    assert.ok(v, `${c} must be noticed when advisory rules are on`);
    assert.equal(v.level, 'advisory');
    assert.match(v.reason, /turn/i, 'and the reason explains what it costs');
  }
});

// A short pause is not the problem, and treating it as one would make the rule noise.
test('advisory: a brief sleep is not worth a word', () => {
  for (const c of ['sleep 2', 'sleep 30', 'npm test && sleep 5']) {
    assert.equal(destructiveVerdict(c, { advisory: true }), null, `${c} is fine`);
  }
});

// --- v1.18.1: the hole this rule had in the one shell the loop actually runs in ----------------
//
// PAID FOR IN SOMEBODY ELSE'S WORK. The rule above exists because killing Claude by image name
// takes down every session on the machine including the loop's own. It was written for the
// canonical `taskkill /IM claude.exe` — and on 2026-09-01 an agent in this very project ran
//
//     taskkill //FI "IMAGENAME eq claude.exe" //F
//
// which the guard ALLOWED, and a Claude Code session belonging to an unrelated project died mid
// tool call. Two things about that form are not exotic: the doubled slash is what MSYS/git-bash
// requires on Windows so the shell does not mangle the flag into a path, and `/FI IMAGENAME eq`
// is the documented filter syntax. Both are ordinary; the rule simply matched one spelling of the
// thing it forbids.
//
// The root is stated so the next reader does not narrow it again: what is dangerous is SELECTING
// PROCESSES BY NAME. Which flag spells the selection is an accident of the command line.
test('killing Claude or node by name is refused however the selection is spelled', () => {
  const forms = [
    'taskkill /IM claude.exe /F',
    'taskkill //IM claude.exe //F',                       // git-bash doubles the slash
    'taskkill //FI "IMAGENAME eq claude.exe" //F',        // the exact command that did the damage
    'taskkill /FI "IMAGENAME eq node.exe" /F',
    "taskkill /fi 'imagename eq Claude.exe' /f",          // flags and names are case-insensitive
    'taskkill /F /FI "IMAGENAME EQ CLAUDE.EXE" /T',
    'Stop-Process -Name claude -Force',
    'Stop-Process -Name node',
    'pkill -f claude',
    'killall node',
  ];
  for (const cmd of forms) {
    const v = destructiveVerdict(cmd);
    assert.equal(v.level, HARD, `must be refused outright: ${cmd}`);
    assert.match(v.reason, /every session|EVERY session/i,
      'and the reason must name the consequence, not just the rule');
  }
});

// The other half of the same rule, and the reason it must stay narrow: killing ONE process by its
// id is the legitimate way to stop something, and refusing it would cost the loop a turn every
// time it cleaned up after itself.
test('killing one named process by its id stays allowed, in every spelling', () => {
  for (const cmd of [
    'taskkill /F /PID 1234',
    'taskkill //F //PID 1234',
    'taskkill /T /F /PID 4242',
    'Stop-Process -Id 1234',
    'kill 4321',
    'kill -9 4321',
  ]) {
    const v = destructiveVerdict(cmd);   // null means nothing matched at all, which is allowed
    assert.ok(!v || v.level !== HARD, `must stay allowed: ${cmd}`);
  }
});

// A command that merely mentions the rule is text, not an act. Refusing these would make the guard
// a nuisance in exactly the work that fixes it — this file's own tests contain the strings.
test('talking about the command is not performing it', () => {
  for (const cmd of [
    'echo "never run taskkill /IM claude.exe"',
    'grep -rn "taskkill /FI" core/',
    'git commit -m "guard now refuses taskkill //FI IMAGENAME eq claude.exe"',
  ]) {
    const v = destructiveVerdict(cmd);   // null means nothing matched at all, which is allowed
    assert.ok(!v || v.level !== HARD, `must stay allowed: ${cmd}`);
  }
});

// v1.25.0, found by the final audit: spellings of the four declared dangers that walked through.
// The rule is stated at the level of the danger (as v1.18.1 did for taskkill): what is forbidden is
// REWRITING SHARED HISTORY, DELETING THE HOME DIRECTORY and WIPING A DISK, whatever the spelling.
test('force push in every spelling is caught, and the careful forms are not', () => {
  for (const c of ['git push origin +main', 'git push origin +HEAD:main', 'git -C repo push -f',
    'git -c core.x=y push --force origin main', 'git push --mirror', 'git push -uf origin main']) {
    assert.ok(destructiveReason(c), `must be caught: ${c}`);
  }
  for (const c of ['git push origin main', 'git push --force-with-lease', 'git push -u origin feature',
    'git push --force-if-includes --force-with-lease origin main', 'git push --force-if-includes origin main',
    'git push origin feature+fix']) {
    assert.equal(destructiveReason(c), null, `must be allowed: ${c}`);
  }
});

test('the home directory with a trailing slash is the home directory', () => {
  for (const c of ['rm -fr ~/', 'rm -rf $HOME/', 'rm -rf "${HOME}/"']) assert.ok(destructiveReason(c), c);
  for (const c of ['rm -rf ~/projects/build', 'rm -rf $HOME/tmp/x']) assert.equal(destructiveReason(c), null, c);
});

test('writing raw bytes over a whole disk is wiping it', () => {
  for (const c of ['dd if=/dev/zero of=/dev/sda', 'sudo dd if=x.img of=/dev/nvme0n1 bs=4M', 'dd of=/dev/disk2 if=/dev/zero']) {
    assert.ok(destructiveReason(c), c);
  }
  for (const c of ['dd if=/dev/zero of=./disk.img bs=1M count=10', 'dd if=/dev/sda of=backup.img']) {
    assert.equal(destructiveReason(c), null, c);
  }
});

test('PowerShell literal here-strings are data for Node and commands for IEX or shells', () => {
  const captured = JSON.parse(readFileSync(new URL('../fixtures/powershell-here-data.json', import.meta.url), 'utf8')).command;
  assert.equal(destructiveReason(captured), null, 'the actual live regression assertion script is data');
  const body = "@'\nrm -rf /\n'@";
  for (const command of [body + ' | node', body + ' | python', "Set-Content -Path notes.txt -Value " + body]) {
    assert.equal(destructiveReason(command), null);
  }
  for (const command of [body + ' | iex', body + '|Invoke-Expression', 'Invoke-Expression ' + body, body + ' | pwsh', body + ' | node; format C:']) {
    assert.ok(destructiveReason(command), 'executed body or later danger must stay blocked');
  }
  const event = {tool_name:'exec_command',hook_event_name:'PreToolUse',tool_input:{command:captured}};
  assert.equal(evaluateCodexHook(JSON.stringify(event), decidePermission), null);
  event.tool_input.command=body + ' | iex';
  assert.equal(evaluateCodexHook(JSON.stringify(event), decidePermission).hookSpecificOutput.permissionDecision, 'deny');
});
