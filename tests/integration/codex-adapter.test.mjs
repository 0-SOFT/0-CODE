import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname, win32 } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { CodexBackend } from '../../core/backends/codex.mjs';
import { runLoop } from '../../core/supervisor.mjs';
import { runCli, runCliAsync, liveChildCount } from '../../core/backends/spawn-cli.mjs';
import { resolveCliLaunch } from '../../core/backends/cli-launch.mjs';
import { mkTempProject, readFrontmatter, cleanupTempDir } from '../helpers/index.mjs';

const scratch = process.env.FRAMEWORK_TEST_TMPDIR || tmpdir();
mkdirSync(scratch, { recursive: true });
const command = { bin: process.execPath, args: [fileURLToPath(new URL('../helpers/codex-replay.mjs', import.meta.url))] };
const project = state => {
  const p = mkTempProject({ current_version: '1.26.0', next_step_prompt: 'work', iteration: 0,
    max_iterations: 5, ...state }, { baseDir: scratch });
  const stateBase = mkdtempSync(join(scratch, 'codex-replay-home-'));
  const personalHome = join(stateBase, 'personal'); mkdirSync(personalHome);
  return { ...p, homeDir: join(stateBase, 'owned'), personalHome,
    async cleanup() { p.cleanup(); await cleanupTempDir(stateBase); } };
};

test('Windows without CIM or WMIC: a real child is killed and the supervisor retries the turn',
  { skip: process.platform !== 'win32' }, async () => {
  const p = project();
  const children = [], exits = [], kills = [], probes = [];
  const source = readFileSync(new URL('../../core/backends/spawn-cli.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const context = { process: { platform: 'win32', env: process.env, on() {} },
    readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync, dirname, win32, randomUUID, resolveCliLaunch,
    setTimeout, clearTimeout,
    spawn(...args) {
      const child = spawn(...args);
      children.push(child);
      exits.push(new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))));
      return child;
    },
    spawnSync(bin, args, opts) {
      if (bin !== 'taskkill') { probes.push(bin); return { status: null, error: { code: 'ENOENT' } }; }
      const pid = Number(args.at(-1));
      assert.ok(children.some(child => child.pid === pid), 'only our own child can be terminated');
      kills.push(pid);
      return spawnSync(bin, args, opts);
    },
  };
  runInNewContext(source, context);
  context.processIdentityAsync=pid=>context.processIdentity(pid);
  let attempts = 0, retries = 0, first;
  try {
    const backend = new CodexBackend({ command, homeDir: p.homeDir,
      env: { ...process.env, CODEX_HOME: p.personalHome, CODEX_REPLAY_RELEASE: '1' },
      async launch(bin, args, opts) {
        attempts++;
        if (attempts === 1) {
          first = await context.runCliAsync(process.execPath,
            ['-e', 'process.stdout.write("HUNG");setTimeout(()=>{},60000)'],
            { ...opts, timeoutMs: 1500, idleTimeoutMs: 0 });
          return first;
        }
        return context.runCliAsync(bin, args, opts);
      } });
    const result = await runLoop({ stateFile: p.stateFile, backend, useLock: false,
      usePreflight: false, maxLoops: 5, sleep: async () => { retries++; } });
    assert.equal(first.timedOut, true);
    assert.equal(first.cleanupRefused, undefined);
    assert.equal(result.stopped, 'released');
    assert.equal(result.loops, 2);
    assert.equal(attempts, 3);
    assert.equal(retries, 1);
    assert.deepEqual(kills, [children[0].pid]);
    assert.ok(probes.includes('wmic'));
    assert.ok(probes.some(bin => /powershell\.exe$/i.test(bin)));
    const terminated = await exits[0];
    assert.notEqual(terminated.code, 0);
    // The numeric PID can be reused after exit; verify the original child handle instead.
    assert.deepEqual({ code: children[0].exitCode, signal: children[0].signalCode }, terminated);
    assert.ok(children[0].exitCode !== null || children[0].signalCode !== null);
    assert.equal(context.liveChildCount(), 0);
    assert.ok(existsSync(join(p.dir, 'work-1.txt')));
  } finally {
    context.killAllChildren();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.all(exits);
    await p.cleanup();
  }
});

test('supervisor + real Codex adapter + child process replay: two work turns and a release gate', async () => {
  const p = project();
  try {
    const backend = new CodexBackend({ command, homeDir: p.homeDir,
      env: { ...process.env, CODEX_HOME: p.personalHome, CODEX_REPLAY_RELEASE: '1' } });
    const r = await runLoop({ stateFile: p.stateFile, backend, useLock: false, maxLoops: 5 });
    assert.equal(r.stopped, 'released');
    assert.equal(r.loops, 2);
    const state = readFrontmatter(p.stateFile);
    assert.equal(state.iteration, 2);
    assert.equal(state.released_version, '1.26.0');
    const workArgs = JSON.parse(readFileSync(join(p.dir, 'work-0.txt'), 'utf8').trimEnd().split('\n').at(-1));
    assert.equal(workArgs.includes('-m'), false);
    assert.equal(workArgs.some(v => v.startsWith('model_reasoning_effort=')), false);
    assert.ok(existsSync(join(p.dir, 'work-1.txt')));
    assert.equal(liveChildCount(), 0);
  } finally { await p.cleanup(); }
});

test('supervisor + Codex usage exhaustion: one attempt, honest pause and no permanent blocker', async () => {
  for (const { usePreflight, partial } of [false, true].flatMap(usePreflight =>
    [false, true].map(partial => ({ usePreflight, partial })))) {
    const p = project();
    try {
      let turns = 0;
      const backend = new CodexBackend({ command, homeDir: p.homeDir, env: { ...process.env, CODEX_HOME: p.personalHome,
        CODEX_REPLAY_ERROR: 'usage_limited: You have hit your usage limit. Try again tomorrow.' },
        launch: (...args) => { turns++; return runCliAsync(...args); },
      });
      if (partial) backend.env.CODEX_REPLAY_PARTIAL = '1';
      const r = await runLoop({ stateFile: p.stateFile, backend, useLock: false,
        usePreflight, maxLoops: 5, sleep: () => assert.fail('a subscription cap must not trigger a retry') });
      assert.equal(r.stopped, 'usage_limited');
      assert.equal(r.paused, true);
      assert.equal(turns, 1);
      assert.equal(readFrontmatter(p.stateFile).iteration, 0);
      assert.deepEqual(readFrontmatter(p.stateFile).blockers, []);
      assert.equal(liveChildCount(), 0);
    } finally { await p.cleanup(); }
  }
});

test('native argv transport preserves compound TOML, metacharacters and closed stdin', async () => {
  const values = ['permissions.framework.filesystem={":root"="read", ":workspace_roots"={"."="write"}}',
    'spaces and "quotes"', 'literal %PATH% & | > < ^ ( )', 'path ending in slash\\'];
  const input = '\u0442\u0435\u043a\u0441\u0442\n' + 'x'.repeat(40000);
  const script = 'let input="";process.stdin.on("data",d=>input+=d).on("end",()=>process.stdout.write(JSON.stringify({args:process.argv.slice(1),input})))';
  for (const launcher of [runCli, runCliAsync]) {
    const r = await launcher(process.execPath, ['-e', script, ...values], { shell: false, input, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), { args: values, input });
  }
});

test('Codex instruction size is measured in UTF-8 bytes before touching the project', async () => {
  const p = project();
  try {
    const backend = new CodexBackend();
    await assert.rejects(backend.installInstructions({ targetDir: p.dir, content: '\u044f'.repeat(17000), instructionsMaxBytes: 32768 }), /configured limit/);
    assert.equal(existsSync(join(p.dir, 'AGENTS.md')), false);
    await backend.installInstructions({ targetDir: p.dir, content: '\u044f'.repeat(17000) });
    const large = readFileSync(join(p.dir, 'AGENTS.md'), 'utf8');
    assert.ok(Buffer.byteLength(large) > 34000);
    assert.ok(large.includes('\u044f'.repeat(17000)));
    const content = 'Project instructions';
    await backend.installInstructions({ targetDir: p.dir, content });
    assert.match(readFileSync(join(p.dir, 'AGENTS.md'), 'utf8'), /<!-- BEGIN AUTONOMOUS FRAMEWORK -->\nProject instructions\n<!-- END AUTONOMOUS FRAMEWORK -->/);
  } finally { await p.cleanup(); }
});
