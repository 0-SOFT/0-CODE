import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runCli, quoteWin, processIdentity, stillOurs, sweepStaleChildren,
} from '../../core/backends/spawn-cli.mjs';

test('quoteWin: quotes only for spaces and metacharacters', () => {
  assert.equal(quoteWin('simple'), 'simple');
  assert.equal(quoteWin('with space'), '"with space"');
  assert.equal(quoteWin('a&b'), '"a&b"');
  assert.equal(quoteWin('say "hi"'), '"say \\"hi\\""');
});

test('runCli: a real cross-platform launch (node)', () => {
  // process.execPath may contain spaces (C:\Program Files\...) → this checks binary quoting.
  const r = runCli(process.execPath, ['-e', 'process.stdout.write("ok123")'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ok123/);
});

test('runCli: an argument with spaces arrives intact (quoting)', () => {
  const r = runCli(process.execPath,
    ['-e', 'process.stdout.write(process.argv[1])', 'a b c'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'a b c');   // it did not split into three arguments
});

// v1.2.0, experiment L1: the Windows command line is cut off between 8000 and 8100 characters.
// Framework prompts are tens of kilobytes, so long text must travel through standard input
// rather than through the arguments.
const READ_STDIN = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write("LENGTH="+s.length))';

test('runCli: passing data through standard input (short text)', () => {
  const r = runCli(process.execPath, ['-e', READ_STDIN], { encoding: 'utf8', input: 'hello' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /LENGTH=5/);
});

test('runCli: text beyond the Windows command-line limit passes through standard input', () => {
  const big = 'x'.repeat(20000);          // three times the cmd.exe limit (~8100 characters)
  const r = runCli(process.execPath, ['-e', READ_STDIN], { encoding: 'utf8', input: big });
  assert.equal(r.status, 0, `exit code ${r.status}, error: ${String(r.stderr).slice(0, 200)}`);
  assert.match(r.stdout, /LENGTH=20000/);
});

test('runCli: the same volume IN AN ARGUMENT fails on Windows (proof that stdin is required)', () => {
  const big = 'x'.repeat(20000);
  const r = runCli(process.execPath, ['-e', 'process.stdout.write(String(process.argv[1].length))', big],
    { encoding: 'utf8' });
  if (process.platform === 'win32') {
    assert.notEqual(r.status, 0, 'on Windows such an argument must be rejected by the system');
  } else {
    assert.equal(r.status, 0, 'on POSIX the limit is incomparably higher — there is no restriction');
  }
});

// v1.3.0: a silent hang is a proven failure mode of external engines (opencode hangs if standard
// input is never closed). The supervisor must receive diagnostics rather than silence.
test('runCli: the timeout aborts a hung process and reports it', () => {
  const t0 = Date.now();
  const r = runCli(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { encoding: 'utf8', timeoutMs: 1500 });
  const elapsed = Date.now() - t0;
  assert.equal(r.timedOut, true, 'the timeout flag must be set');
  assert.ok(elapsed < 20000, `the process must be aborted rather than run to completion (elapsed ${elapsed} ms)`);
});

test('runCli: an ordinary process is untouched by the timeout', () => {
  const r = runCli(process.execPath, ['-e', 'process.stdout.write("fast")'], { encoding: 'utf8', timeoutMs: 30000 });
  assert.equal(r.status, 0);
  assert.equal(r.timedOut, undefined);
  assert.match(r.stdout, /fast/);
});

// v1.5.0 — process groups. Found live during v1.4.0: a supervisor killed from the outside left a
// live `opencode` child; several such orphans competed over one STATE and loaded the machine.
import { runCliAsync, killAllChildren, liveChildCount, killTree } from '../../core/backends/spawn-cli.mjs';

test('runCliAsync: the same result shape as the synchronous launcher', async () => {
  const r = await runCliAsync(process.execPath, ['-e', 'process.stdout.write("ok123")']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ok123/);
  assert.equal(r.timedOut, false);
});

test('runCliAsync: standard input reaches the process', async () => {
  const r = await runCliAsync(process.execPath,
    ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write("received:"+d))'],
    { input: 'hello' });
  assert.match(r.stdout, /received:hello/);
});

test('runCliAsync: an argument with spaces arrives intact', async () => {
  const r = await runCliAsync(process.execPath,
    ['-e', 'process.stdout.write(process.argv[1])', 'two words'], {});
  assert.match(r.stdout, /two words/);
});

test('runCliAsync: exceeding the time limit is marked by the timedOut flag', async () => {
  const r = await runCliAsync(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { timeoutMs: 400 });
  assert.equal(r.timedOut, true, 'a hang must be distinguishable from an honest error');
});

test('child tracking: no live children remain after the turn ends', async () => {
  const before = liveChildCount();
  await runCliAsync(process.execPath, ['-e', 'process.stdout.write("x")']);
  assert.equal(liveChildCount(), before, 'a finished process is removed from the registry');
});

test('killAllChildren kills a running process without waiting for it to finish', async () => {
  const longRunning = runCliAsync(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)']);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(liveChildCount() >= 1, 'a running process must be counted as live');
  const killed = killAllChildren();
  assert.ok(killed >= 1);
  const r = await longRunning;
  assert.notEqual(r.status, 0, 'a killed process does not exit successfully');
  assert.equal(liveChildCount(), 0);
});

test('killTree does not throw on a non-existent process', () => {
  assert.equal(killTree(0), false);
  assert.equal(killTree(-5), false);
  assert.doesNotThrow(() => killTree(999999));
});

// A live check revealed a fundamental limitation: when the parent is killed HARD
// (kill -9 / taskkill /F) exit handlers do not run at all, so cleaning up from inside a dying
// process is physically impossible. Hence the second line of defence: the on-disk registry.
test('orphan registry: the next launch finishes off the children of a killed predecessor', async () => {
  const { setChildRegistryFile, sweepStaleChildren } = await import('../../core/backends/spawn-cli.mjs');
  const { mkdtempSync, rmSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const d = mkdtempSync(join(tmpdir(), 'sirot-'));
  const registry = join(d, 'docs', '.loop-children');
  try {
    setChildRegistryFile(registry);
    // launch a long-running process and read its id back from the registry
    const longRunning = runCliAsync(process.execPath, ['-e', 'setTimeout(()=>{},60000)']);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(existsSync(registry), 'child ids must reach the disk');
    const { pids } = JSON.parse((await import('node:fs')).readFileSync(registry, 'utf8'));
    assert.ok(pids.length >= 1);

    // simulate a hard parent kill: the registry survives while our in-memory tracking forgets the child
    const { killAllChildren } = await import('../../core/backends/spawn-cli.mjs');
    writeFileSync(registry, JSON.stringify({ pids, at: new Date().toISOString() }), 'utf8');
    killAllChildren();          // clears the in-memory tracking (as after a process restart)
    await longRunning;

    // write the registry again as if left by a predecessor, then sweep
    writeFileSync(registry, JSON.stringify({ pids: [999999], at: new Date().toISOString() }), 'utf8');
    sweepStaleChildren(registry);
    assert.equal(existsSync(registry), false, 'after sweeping, the registry must be gone');
    setChildRegistryFile(null);
  } finally { rmSync(d, { recursive: true, force: true }); setChildRegistryFile(null); }
});

// v1.5.0, the lesson of the final gate: a total time cap killed HONEST work. On a real task the
// agent had already produced two commits but did not fit into 15 minutes, and the whole turn was discarded.
// The design error: the cap was meant to catch a HANG but measured DURATION. A hung process
// differs from a working one not by how long it lives but by the fact that it is SILENT.
// The margin here is deliberately enormous, and must stay that way. This test measures "output
// keeps the process alive", not any particular number of milliseconds — but it used to tick every
// 150 ms against a 500 ms cap, and that 3x margin was not enough for a machine running the whole
// suite in parallel: a tick would slip past the cap and the test failed at random. A flaky gate is
// worse than a missing one, because it teaches everyone to re-run until green.
test('silence cap: a working process is not aborted even though it outlives the cap', async () => {
  // prints every 100 ms for about 0.8 s; the silence cap is 3 s — a 30x margin
  const r = await runCliAsync(process.execPath,
    ['-e', 'let n=0;const t=setInterval(()=>{process.stdout.write("tick ");if(++n>=8){clearInterval(t)}},100)'],
    { idleTimeoutMs: 3000 });
  assert.equal(r.timedOut, false, 'while output keeps coming this is work, not a hang');
  assert.match(r.stdout, /tick/);
});

test('silence cap: a process that goes quiet is aborted', async () => {
  const r = await runCliAsync(process.execPath,
    ['-e', 'process.stdout.write("started");setTimeout(()=>{},60000)'],
    { idleTimeoutMs: 600 });
  assert.equal(r.timedOut, true, 'silence longer than the cap means a hang');
  assert.match(r.stdout, /started/, 'whatever was printed is preserved');
});

test('the total cap remains a far backstop', async () => {
  const r = await runCliAsync(process.execPath,
    ['-e', 'const t=setInterval(()=>process.stdout.write("."),100)'],   // talks without stopping
    { idleTimeoutMs: 5000, timeoutMs: 900 });
  assert.equal(r.timedOut, true, 'endless chatter must eventually hit the total cap');
});

// --- v1.15.0: a cleanup must never be able to destroy somebody else's work --------------------
//
// WHAT HAPPENED. A live supervisor run was started from the framework directory. Its engine probe
// force-killed a process tree, and a Claude Code session belonging to an UNRELATED project ended in
// the same minute, cut off mid tool call. The framework's own header says killing by NAME was
// rejected because it "would also take down the user's unrelated processes" — and then the registry
// that replaced it reached the same outcome by another route.
//
// THE MECHANISM. `sweepStaleChildren` read process numbers out of a file written by an EARLIER run
// and handed each one to `taskkill /T /F`, with no check that the number still belonged to us. A
// process number is not a name: the system issues it again once the process is gone, and a file
// written minutes or hours ago is exactly old enough for that to have happened.

test('a recorded number that now belongs to somebody else is not killed', async () => {
  const { spawn } = await import('node:child_process');
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
  try {
    await new Promise(r => setTimeout(r, 300));
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
    assert.ok(alive(bystander.pid), 'the probe must actually have a process to protect');

    // We hold a record of this number from a previous run, but the process behind it is not ours.
    const killed = killTree(bystander.pid, { identity: 'a process that started at some other time' });
    assert.equal(killed, false, 'an unverified number must be refused, not force-killed');
    await new Promise(r => setTimeout(r, 200));
    assert.ok(alive(bystander.pid), "somebody else's process must still be running");
  } finally { try { bystander.kill('SIGKILL'); } catch { /* already gone */ } }
});

test('an identity is what the process is, not what we hope it is', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
  try {
    await new Promise(r => setTimeout(r, 300));
    const id = processIdentity(child.pid);
    // On a system that will not answer, identity is null — and by the rule above that means "do not
    // kill", which is the safe error. Where it does answer, it must be stable and it must match.
    if (id) {
      assert.equal(processIdentity(child.pid), id, 'the same process must give the same answer twice');
      assert.equal(stillOurs(child.pid, id), true);
      assert.equal(stillOurs(child.pid, `${id}-different`), false);
    }
    assert.equal(stillOurs(999999, 'anything'), false, 'a process that is gone is never ours');
    assert.equal(stillOurs(child.pid, null), false, 'no identity means no permission to kill');
  } finally { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
});

test('a registry from before v1.15.0 carries no identities, so it kills nothing', async () => {
  const { mkdtempSync, writeFileSync: write, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
  try {
    await new Promise(r => setTimeout(r, 300));
    const file = join(dir, '.loop-children');
    write(file, JSON.stringify({ pids: [bystander.pid], at: new Date().toISOString() }), 'utf8');
    const killed = sweepStaleChildren(file);
    assert.equal(killed, 0, 'one leaked orphan is cheaper than one destroyed stranger');
    const alive = (() => { try { process.kill(bystander.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } })();
    assert.ok(alive, 'the bystander must survive a sweep it cannot be proved to belong to');
  } finally {
    try { bystander.kill('SIGKILL'); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
