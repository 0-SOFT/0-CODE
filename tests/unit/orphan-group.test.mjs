import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, win32 } from 'node:path';
import { validateCodexRuntimeOptions } from '../../core/backends/codex-config.mjs';
import { withoutOwnerTelegramEnvironment } from '../../lib/cloud-mcp-policy.mjs';
import { loadEngineSettingsEnvironment } from '../../lib/codex-env.mjs';
import { resolveEngineSettings, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS } from '../../core/engine-settings.mjs';
import { resolveMode, ALLOW_ALL } from '../../core/permission-decision.mjs';
import { ownsSurvivingGroup } from '../../core/backends/spawn-cli.mjs';
import { resolveCliLaunch } from '../../core/backends/cli-launch.mjs';
import { classifyFailure, decideRetry } from '../../core/turn-retry.mjs';

// Exercise the actual launcher's cleanup in an OS harness. No simulated successful model output
// and no real process kills. A dead leader, a survivor and recycled ids can be set deterministically.
const source = readFileSync(new URL('../../core/backends/spawn-cli.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const token = '00000000-0000-4000-8000-000000000001';
const bootId = '65bdbb12-b3ce-4413-9494-fc9b7529cfd9';
function harness({ marker = token, group = 4150, leader = null, denied = false, platform = 'linux' } = {}) {
  const killed = [], registry = { children: [{ pid: 4150, identity: '100', groupToken: token }] };
  const files = new Map([['registry', JSON.stringify(registry)]]);
  files.set('/proc/sys/kernel/random/boot_id', bootId + '\n');
  const procStat = (pid, pgid, start) => `${pid} (worker with spaces) S 1 ${pgid} `
    + [...Array(16).fill('0'), start].join(' ');
  if (leader !== null) files.set('/proc/4150/stat', procStat(4150, 4150, leader));
  files.set('/proc/4160/stat', procStat(4160, group, '120'));
  files.set('/proc/4160/environ', `PATH=/bin\0ZERO_CODE_CHILD_GROUP=${marker}\0`);
  const context = {
    win32,
    resolveCliLaunch: (bin, args, opts) => resolveCliLaunch(bin, args, { ...opts, platform }),
    process: { platform, on() {}, kill(pid, signal) { killed.push([pid, signal]); } },
    randomUUID: () => token,
    readFileSync(path) {
      if (denied && path.includes('/environ')) throw new Error('permission denied');
      if (!files.has(path)) throw new Error('not found');
      return files.get(path);
    },
    existsSync: path => files.has(path), unlinkSync: path => files.delete(path),
    writeFileSync: (path, value) => files.set(path, value), mkdirSync() {}, dirname: () => '.',
    spawnSync(bin, args) {
      if (bin !== 'ps') throw new Error('unexpected command');
      if (args.includes('pid=,pgid=')) return { status: 0, stdout: `4160 ${group}\n` };
      if (args.includes('pgid=,command=')) return { status: denied ? 1 : 0,
        stdout: `${group} /bin/worker ZERO_CODE_CHILD_GROUP=${marker}\n` };
      return { status: 1, stdout: '' };
    },
  };
  runInNewContext(source, context);
  // OS scheduling is controlled here; real asynchronous CIM is tested by native launcher tests.
  context.processIdentityAsync=pid=>context.processIdentity(pid);
  return { context, killed, files };
}

test('a dead POSIX leader does not lose a surviving owned group during orphan sweep', () => {
  for (const platform of ['linux', 'darwin']) {
    const h = harness({ platform });
    assert.equal(h.context.sweepStaleChildren('registry'), 1, platform);
    assert.deepEqual(h.killed, [[-4150, 'SIGKILL']]);
  }
});

test('a marker cannot authorize another group, a recycled leader, or an unreadable environment', () => {
  for (const options of [{ marker: 'another-launch' }, { group: 5000 }, { leader: '200' }, { denied: true }]) {
    const h = harness(options);
    assert.equal(h.context.sweepStaleChildren('registry'), 0);
    assert.deepEqual(h.killed, []);
  }
});

test('old orphan records without a group marker still require the original live leader', () => {
  const h = harness();
  h.files.set('registry', JSON.stringify({ children: [{ pid: 4150, identity: '100' }] }));
  assert.equal(h.context.sweepStaleChildren('registry'), 0);
  assert.deepEqual(h.killed, []);
});

test('the ownership verifier checks both group membership and exact inherited launch identity', () => {
  for (const platform of ['linux', 'darwin']) {
    for (const options of [{}, { marker: 'another-launch' }, { group: 5000 }, { denied: true }]) {
      const h = harness({ ...options, platform });
      const result = ownsSurvivingGroup(4150, token, { platform,
        read: h.context.readFileSync, inspect: h.context.spawnSync });
      assert.equal(result, Object.keys(options).length === 0);
    }
  }
  assert.equal(ownsSurvivingGroup(4150, undefined), false);
  assert.equal(ownsSurvivingGroup(4150, token, { inspect: () => { throw new Error('no ps'); } }), false);
  assert.equal(ownsSurvivingGroup(4150, token, { inspect: () => ({ status: 1 }) }), false);
});

test('the actual launcher passes and persists its marker before a leaderless cleanup', async () => {
  const h = harness({ leader: '100' });
  let options;
  const child = new EventEmitter();
  child.pid = 4150;
  child.stdin = { end() {}, on() {} };
  h.context.spawn = (_, __, opts) => { options = opts; return child; };
  h.context.setChildRegistryFile('registry');
  const pending = h.context.runCliAsync('engine', [], { env: { USER_SETTING: 'preserved' } });
  assert.equal(options.env.ZERO_CODE_CHILD_GROUP, token);
  assert.equal(options.env.USER_SETTING, 'preserved');
  assert.equal(JSON.parse(h.files.get('registry')).children[0].groupToken, token);
  h.files.delete('/proc/4150/stat');
  // Finishing another turn must not discard the first group's still-pending record.
  const second = new EventEmitter();
  second.pid = 4200;
  second.stdin = { end() {}, on() {} };
  h.context.spawn = () => second;
  const another = h.context.runCliAsync('other-engine', [], {});
  second.emit('close', 0);
  await another;
  assert.equal(JSON.parse(h.files.get('registry')).children[0].pid, 4150);
  assert.equal(h.context.killAllChildren(), 1);
  assert.deepEqual(h.killed, [[-4150, 'SIGKILL']]);
  child.emit('close', null, 'SIGKILL');
  await pending;
  assert.equal(h.context.liveChildCount(), 0);
});

test('an abnormal leader close cleans owned survivors; success and foreign identities are preserved', async () => {
  for (const [status, options, expected] of [[null, {}, 1], [1, {}, 1], [0, {}, 0],
    [null, { marker: 'another-launch' }, 0], [null, { leader: '200' }, 0]]) {
    const h = harness({ leader: '100', ...options });
    const child = new EventEmitter();
    child.pid = 4150;
    child.stdin = { end() {}, on() {} };
    h.context.spawn = () => child;
    h.context.setChildRegistryFile('registry');
    const pending = h.context.runCliAsync('engine', [], {});
    if (!options.leader) h.files.delete('/proc/4150/stat');
    else h.files.set('/proc/4150/stat', h.files.get('/proc/4150/stat').replace(/200$/, '300'));
    child.emit('close', status, status === null ? 'SIGKILL' : null);
    await pending;
    assert.equal(h.killed.length, expected);
    if (expected) assert.deepEqual(h.killed, [[-4150, 'SIGKILL']]);
    assert.equal(h.context.liveChildCount(), 0);
  }
});

test('a saved Linux process identity cannot authorize a different boot with matching PID and ticks', () => {
  const h = harness({ leader: '100', marker: 'foreign-launch' });
  const identity = h.context.processIdentity(4150);
  assert.ok(identity, 'the original live leader must have a verifiable identity');
  h.files.set('registry', JSON.stringify({ children: [{ pid: 4150, identity, groupToken: token }] }));
  // The registry persists, but the next boot gives this PID and start tick to another process.
  h.files.set('/proc/sys/kernel/random/boot_id', '7d41b2de-772e-4b11-a8bb-280e3fb72bc8\n');
  assert.equal(h.context.sweepStaleChildren('registry'), 0);
  assert.deepEqual(h.killed, []);
});

test('Linux identities verify their boot and refuse legacy or unavailable boot evidence', () => {
  const h = harness({ leader: '100' });
  const identity = h.context.processIdentity(4150);
  assert.equal(identity, `linux:${bootId}:100`);
  assert.equal(h.context.stillOurs(4150, identity), true);
  assert.equal(h.context.stillOurs(4150, '100'), false, 'legacy start ticks cannot establish the boot');
  assert.equal(h.context.killTree(4150, { identity: '100', groupToken: token }), false,
    'a legacy registry cannot authorize a live PID even when its old group marker was retained');
  h.files.set('registry', JSON.stringify({ children: [{ pid: 4150, identity, groupToken: token }] }));
  assert.equal(h.context.sweepStaleChildren('registry'), 1, 'our live leader in the same boot can be cleaned');
  assert.deepEqual(h.killed, [[-4150, 'SIGKILL']]);

  // Even an available ps wall-clock birth is not a substitute for the missing boot UUID.
  h.context.spawnSync = () => ({ status: 0, stdout: 'Tue Oct 6 01:00:00 2026' });
  for (const evidence of [undefined, '', 'not-a-uuid']) {
    if (evidence === undefined) h.files.delete('/proc/sys/kernel/random/boot_id');
    else h.files.set('/proc/sys/kernel/random/boot_id', evidence);
    assert.equal(h.context.processIdentity(4150), null);
    assert.equal(h.context.stillOurs(4150, identity), false);
    assert.equal(h.context.killTree(4150, { identity, groupToken: token }), false);
  }
  h.files.set('/proc/sys/kernel/random/boot_id', bootId);
  h.files.set('/proc/4150/stat', h.files.get('/proc/4150/stat').replace(/100$/, 'invalid'));
  assert.equal(h.context.processIdentity(4150), null);
});

function capturedChild(pid = 4150) {
  const child = new EventEmitter();
  child.pid = pid;
  for (const name of ['stdin', 'stdout', 'stderr']) {
    const stream = child[name] = new EventEmitter();
    stream.setEncoding = () => {};
    stream.end = () => {};
    stream.destroy = () => { stream.destroyed = true; };
  }
  child.unref = () => { child.unreferenced = true; };
  return child;
}

function stoppingHarness(options = {}) {
  const h = harness({ leader: '100', ...options });
  const timers = [];
  let clock = 0;
  h.context.Date = class extends Date { static now() { return clock; } };
  h.context.setTimeout = (fn, ms) => {
    const timer = { fn, ms, due: clock + ms, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  };
  h.context.clearTimeout = timer => { timer.cleared = true; };
  h.context.setChildRegistryFile('registry');
  return { ...h, timers, advance: timer => { clock = timer.due; timer.fn(); } };
}

const stopOptions = mode => mode === 'idle' ? { idleTimeoutMs: 11 }
  : mode === 'overall' ? { timeoutMs: 17 } : { onChunk: () => 'abort' };
function triggerStop(h, child, mode) {
  if (mode === 'abort') child.stdout.emit('data', 'late descendant output');
  else h.advance(h.timers.find(t => t.ms === (mode === 'idle' ? 11 : 17) && !t.cleared));
}

test('the signal boundary refuses callers without a saved process identity', () => {
  const h = harness({ leader: '100' });
  assert.equal(h.context.killTree(4150), false);
  assert.deepEqual(h.killed, []);
});

for (const mode of ['idle', 'overall', 'abort']) {
  test(`${mode} stop protects foreign or unknown owners, cleans our group, and ends capture before close`, async () => {
    for (const scenario of ['foreign', 'unknown', 'live', 'leaderless']) {
      const h = stoppingHarness();
      if (scenario === 'unknown') h.files.delete('/proc/sys/kernel/random/boot_id');
      const child = capturedChild();
      h.context.spawn = () => child;
      const pending = h.context.runCliAsync('engine', [], stopOptions(mode));
      let result;
      pending.then(value => { result = value; });
      if (scenario === 'foreign') {
        child.emit('exit', 0);
        h.files.set('/proc/4150/stat', h.files.get('/proc/4150/stat').replace(/100$/, '200'));
        h.files.set('/proc/4160/environ', 'ZERO_CODE_CHILD_GROUP=foreign-launch\0');
      } else if (scenario === 'leaderless') {
        child.emit('exit', 1);
        h.files.delete('/proc/4150/stat');
      }
      triggerStop(h, child, mode);
      try {
        const ours = ['live', 'leaderless'].includes(scenario);
        assert.deepEqual(h.killed, ours ? [[-4150, 'SIGKILL']] : [], scenario);
        await Promise.resolve();
        assert.ok(result, 'a held pipe must not keep a stopped turn pending');
        assert.equal(result.status, null);
        assert.equal(result.cleanupRefused === true, !ours);
        assert.equal(result.timedOut, mode !== 'abort');
        assert.equal(result.aborted === true, mode === 'abort');
        for (const name of ['stdin', 'stdout', 'stderr']) assert.equal(child[name].destroyed, true);
        assert.equal(child.unreferenced, true);
        assert.equal(h.context.liveChildCount(), 0);
        // Data/close arriving after our capture stop cannot repeat the observer or kill.
        child.stdout.emit('data', 'after stop');
        child.emit('close', 1);
        assert.deepEqual(h.killed, ours ? [[-4150, 'SIGKILL']] : []);
      } finally { child.emit('close', 0); await pending; }
    }
  });
}

test('a stopped old capture cannot remove a new launch record with the same numeric PID', async () => {
  const h = stoppingHarness();
  const old = capturedChild();
  h.context.spawn = () => old;
  const previous = h.context.runCliAsync('old', [], { timeoutMs: 17 });
  old.emit('exit', 0);
  h.files.set('/proc/4150/stat', h.files.get('/proc/4150/stat').replace(/100$/, '200'));
  const replacement = capturedChild();
  h.context.randomUUID = () => '00000000-0000-4000-8000-000000000002';
  h.context.spawn = () => replacement;
  const current = h.context.runCliAsync('new', [], {});
  triggerStop(h, old, 'overall');
  try {
    await Promise.resolve();
    assert.deepEqual(h.killed, []);
    assert.equal(h.context.liveChildCount(), 1);
    const record = JSON.parse(h.files.get('registry')).children[0];
    assert.equal(record.identity, `linux:${bootId}:200`);
    assert.equal(record.groupToken, '00000000-0000-4000-8000-000000000002');
    old.emit('close', 1);
    assert.equal(h.context.liveChildCount(), 1);
  } finally { old.emit('close', 0); replacement.emit('close', 0); await Promise.all([previous, current]); }
});

test('Windows stops its current handle without a birth identity but refuses after exit', async () => {
  for (const mode of ['idle', 'overall', 'abort', 'cleanup', 'exited']) {
    const h = stoppingHarness({ platform: 'win32' });
    h.context.spawnSync = (bin, args) => {
      if (bin === 'taskkill') { h.killed.push(Array.from(args)); return { status: 0 }; }
      return { status: null, error: { code: 'ENOENT' } };
    };
    const child = capturedChild();
    h.context.spawn = () => child;
    const pending = h.context.runCliAsync('engine', [], { shell: false,
      ...stopOptions(mode === 'exited' ? 'overall' : mode) });
    if (mode === 'exited') child.emit('exit', 0);
    if (mode === 'cleanup') { assert.equal(h.context.killAllChildren(), 1); child.emit('close', null); }
    else triggerStop(h, child, mode === 'exited' ? 'overall' : mode);
    const result = await pending;
    assert.deepEqual(h.killed, mode === 'exited' ? [] : [['/T', '/F', '/PID', '4150']]);
    assert.equal(result.cleanupRefused === true, mode === 'exited');
    h.files.set('registry', JSON.stringify({ children: [{ pid: 4150, identity: null }] }));
    const count = h.killed.length;
    assert.equal(h.context.sweepStaleChildren('registry'), 0, 'the handle is never transferred to a stale entry');
    assert.equal(h.killed.length, count);
  }
});

test('Windows stop verifies fresh birth evidence rather than a cached PID owner', async () => {
  for (const mode of ['idle', 'overall', 'abort']) {
    const h = stoppingHarness({ platform: 'win32' });
    let birth = '20261007120000.000000+000';
    let snapshots = 0;
    h.context.spawnSync = (bin, args) => {
      if (bin === 'wmic') { snapshots++; return { status: 0, stdout: `Node,CreationDate,ProcessId\nHOST,${birth},4150\n` }; }
      if (bin === 'taskkill') { h.killed.push(args); return { status: 0 }; }
      throw new Error('unexpected command');
    };
    const child = capturedChild();
    h.context.spawn = () => child;
    const pending = h.context.runCliAsync('engine', [], { shell: false, ...stopOptions(mode) });
    child.emit('exit', 0);
    birth = '20261007120001.000000+000';
    triggerStop(h, child, mode);
    try {
      assert.deepEqual(h.killed, []);
      assert.ok(snapshots >= 2, 'termination needs a fresh OS lookup after registration');
    } finally { child.emit('close', 0); await pending; }
  }
});
test('delayed Windows metadata cannot bind after exit, observed termination or record replacement', async () => {
  for (const mode of ['exit', 'exitCode', 'signalCode', 'replacement']) {
    const h = stoppingHarness({ platform: 'win32' }), child = capturedChild();
    let answer;
    h.context.processIdentityAsync = () => new Promise(resolve => { answer = resolve; });
    h.context.spawn = () => child;
    child.kill = () => { throw new Error('metadata must never signal a child'); };
    const pending = h.context.runCliAsync('engine', [], stopOptions('idle'));
    let replacement, replacementChild;
    if (mode === 'exit') child.emit('exit', 0); // Pipes remain open until close.
    if (mode === 'exitCode') child.exitCode = 0;
    if (mode === 'signalCode') child.signalCode = 'SIGKILL';
    if (mode === 'replacement') {
      h.context.processIdentityAsync = () => null;
      replacementChild = capturedChild();
      h.context.spawn = () => replacementChild;
      replacement = h.context.runCliAsync('new-engine', [], stopOptions('idle'));
    }
    answer('20261007120001.000000+000');
    await Promise.resolve(); await Promise.resolve();
    assert.equal(JSON.parse(h.files.get('registry')).children[0].identity, null, mode);
    child.emit('exit', 0);
    triggerStop(h, child, 'idle');
    const result = await pending;
    assert.equal(result.cleanupRefused, true); assert.deepEqual(h.killed, []);
    assert.equal(h.context.liveChildCount(), mode === 'replacement' ? 1 : 0);
    if (replacement) { replacementChild.emit('close', 0); await replacement; }
  }
});

test('all adapters expose refused cleanup as fatal before timeout, budget or subscription text', async () => {
  for (const [file, name] of [['claude', 'ClaudeBackend'], ['opencode', 'OpenCodeBackend'], ['codex', 'CodexBackend']]) {
    const adapterSource = readFileSync(new URL(`../../core/backends/${file}.mjs`, import.meta.url), 'utf8')
      .replace(/^import .*;\r?\n/gm, '').replace(/^export \{.*from .*;\r?$/gm, '').replace(/^export default .*;\r?$/gm, '').replace(/^export /gm, '')
      .replaceAll('import.meta.url', JSON.stringify(new URL(`../../core/backends/${file}.mjs`, import.meta.url).href));
    for (const stop of [{ timedOut: true }, { aborted: true }]) {
      const context = { Backend: class {}, Buffer, validateCodexRuntimeOptions, withoutOwnerTelegramEnvironment,
        loadEngineSettingsEnvironment, resolveEngineSettings, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS, resolveMode, ALLOW_ALL,
        CodexHome: class { mode = 'managed'; prepareExecution() { return { home: 'owned', executionHome: 'owned', mode: 'managed', guardEnabled: true, overrides: [] }; } }, process: { env: {} }, fileURLToPath, URL, dirname, join, resolve, existsSync, statSync, readFileSync,
        runCli() {}, runCliAsync: async () => ({ status: null, stdout: '',
          stderr: 'usage_limited ECONNRESET', cleanupRefused: true, ...stop }) };
      runInNewContext(adapterSource, context);
      const backend = runInNewContext(`new ${name}(${file === 'codex' ? '{command:{bin:"probe",args:[]}}' : ''})`, context);
      const result = await backend.runTurn({ prompt: 'probe', cwd: '.' });
      assert.equal(result.ok, false);
      assert.equal(result.cleanupRefused, true, `${file}: ${result.error}`);
      assert.equal(classifyFailure(result.error), 'fatal', file);
      assert.equal(decideRetry({ error: result.error }).retry, false, file);
    }
  }
});
