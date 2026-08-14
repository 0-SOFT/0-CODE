import { test } from 'node:test';
import assert from 'node:assert/strict';
import { head, segmentReason, destructiveReason } from '../../core/safety.mjs';

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

test('blocked: destroying the filesystem (Windows)', () => {
  for (const cmd of ['Remove-Item -Recurse -Force C:\\', 'Remove-Item -Path ~ -Recurse',
    'rd /s /q C:\\', 'rmdir /s /q %USERPROFILE%', 'del /f /s /q C:\\*']) {
    assert.ok(destructiveReason(cmd), `must be blocked: ${cmd}`);
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
    'git push origin main --force-with-lease']) {
    assert.ok(destructiveReason(cmd), `must be blocked: ${cmd}`);
  }
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
