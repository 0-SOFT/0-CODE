import { cleanupTempDirSync } from '../helpers/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runCli, processIdentity, stillOurs, sweepStaleChildren, readWindowsProcesses,readWindowsProcessesAsync,
} from '../../core/backends/spawn-cli.mjs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeNpmNodeShim } from '../helpers/npm-shim.mjs';

test('real launchers preserve shell metacharacters, quotes and percent references as argv data', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cli-argv-'));
  t.after(() => cleanupTempDirSync(root));
  const script = join(root, 'arguments.mjs');
  writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const values = ['a"b', '%USERNAME%', 'safe" & echo AUDIT129_INJECTED & rem "',
    'trailing slash\\', 'space and slash\\', '', 'line one\nline two', '^!<>()|&', '\u0420\u0443\u0441\u0441\u043a\u0438\u0439 \u0442\u0435\u043a\u0441\u0442'];
  for (const launcher of [runCli, runCliAsync]) {
    for (const opts of [{}, { shell: true }]) {
      const result = await launcher(process.execPath, [script, ...values], { encoding: 'utf8', ...opts });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, JSON.stringify(values), 'exact argv and no extra command output');
    }
  }
});

test('Windows npm Node shims preserve argv in both launchers without invoking cmd.exe',
  { skip: process.platform !== 'win32' }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'cli-npm-shim-'));
    t.after(() => cleanupTempDirSync(root));
    mkdirSync(join(root, 'node_modules', 'fixture'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'fixture', 'cli.mjs'),
      'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const shim = join(root, 'fixture.cmd');
    writeNpmNodeShim(shim);
    const values = ['quote" & echo AUDIT129_INJECTED & rem "', '%USERNAME%', 'space \\', ''];
    for (const launcher of [runCli, runCliAsync]) {
      const result = await launcher(shim, values, { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, JSON.stringify(values));
    }
  });

test('Windows reads identities through CIM without WMIC and retains a fallback', () => {
  const identity = '20261007120000.000000+000';
  const calls = [];
  const table = readWindowsProcesses({ env: { SystemRoot: 'C:\\Windows' }, inspect(bin, args) {
    calls.push(bin);
    assert.match(bin, /powershell\.exe$/i);
    assert.match(args.at(-1), /Get-CimInstance Win32_Process/);
    return { status: 0, stdout: `4150,${identity},4100\n4160,${identity},4150\n` };
  } });
  assert.deepEqual(table.get(4150), { identity, parentPid: 4100 });
  assert.equal(calls.length, 1, 'WMIC is unnecessary when CIM works');
  const fallback = readWindowsProcesses({ inspect(bin) {
    if (bin !== 'wmic') return { status: 1, stdout: '' };
    return { status: 0, stdout: `Node,CreationDate,ParentProcessId,ProcessId\nHOST,${identity},4100,4150\n` };
  } });
  assert.deepEqual(fallback.get(4150), { identity, parentPid: 4100 });
  assert.equal(readWindowsProcesses({ inspect() { throw new Error('unavailable'); } }).size, 0);
});

test('runCli: a real cross-platform launch (node)', () => {
  // process.execPath may contain spaces (C:\Program Files\...) → this checks binary quoting.
  const r = runCli(process.execPath, ['-e', 'process.stdout.write("ok123")'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ok123/);
});
test('async Windows metadata uses the same CIM and WMIC parsers and honors cancellation',async()=>{
  const identity='20261007120000.000000+000';let calls=0;
  const cim=await readWindowsProcessesAsync({inspect:async()=>{
    calls++;return {status:0,stdout:`4150,${identity},4100\n`};
  }});
  assert.equal(calls,1);assert.deepEqual(cim.get(4150),{identity,parentPid:4100});
  const fallback=await readWindowsProcessesAsync({inspect:async bin=>bin==='wmic'
    ?{status:0,stdout:`Node,CreationDate,ParentProcessId,ProcessId\nHOST,${identity},4100,4150\n`}:{status:1}});
  assert.deepEqual(fallback.get(4150),{identity,parentPid:4100});
  const controller=new AbortController();controller.abort();
  const cancelled=await readWindowsProcessesAsync({signal:controller.signal,inspect:async()=>{throw new Error('must not inspect');}});
  assert.equal(cancelled.size,0);
  assert.equal((await readWindowsProcessesAsync({inspect:async()=>{throw new Error('unavailable');}})).size,0);
});

test('runCli: an argument with spaces arrives intact (quoting)', () => {
  const r = runCli(process.execPath,
    ['-e', 'process.stdout.write(process.argv[1])', 'a b c'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'a b c');   // it did not split into three arguments
});

// v1.2.0 experiment L1 measured cmd.exe's ~8K limit. Since 1.29.0 native launches avoid cmd;
// stdin still carries large prompts without depending on a platform-specific argv limit.
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

test('runCli: long argv no longer crosses the smaller cmd.exe limit', () => {
  const big = 'x'.repeat(20000);
  const r = runCli(process.execPath, ['-e', 'process.stdout.write(String(process.argv[1].length))', big],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '20000');
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
  } finally { cleanupTempDirSync(d); setChildRegistryFile(null); }
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

test('silence cap: a process that goes quiet is aborted', { timeout: 30000 }, async t => {
  // Freeze the parent's deadline clock until a real child has actually produced output.
  // Node startup under the full suite can exceed the silence cap; startup is not this assertion.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  t.after(() => killAllChildren());
  let ready, output = '';
  const started = new Promise(resolve => { ready = resolve; });
  const pending = runCliAsync(process.execPath,
    ['-e', 'process.stdout.write("started");setTimeout(()=>{},60000)'],
    { idleTimeoutMs: 600, onChunk(chunk) { output += chunk; if (output.includes('started')) ready(); } });
  await started;
  t.mock.timers.tick(600);
  const r = await pending;
  assert.equal(r.timedOut, true, 'silence longer than the cap means a hang');
  assert.match(r.stdout, /started/, 'whatever was printed is preserved');
  assert.notEqual(r.cleanupRefused, true, 'the owned real process must be stopped');
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

test('a long owner timeout does not overflow into an immediate abort of a real child', async () => {
  const result = await runCliAsync(process.execPath, ['-e', "setTimeout(() => console.log('LONG_TIMER_OK'), 50)"],
    { timeoutMs: 9999 * 3600000, idleTimeoutMs: 99 * 60000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /LONG_TIMER_OK/);
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
    cleanupTempDirSync(dir);
  }
});
