import { cleanupTempDirSync } from '../helpers/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkTempProject, readFrontmatter } from '../helpers/index.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STOP_HOOK = join(ROOT, 'hooks', 'ralph-loop-stop.mjs');
const SAFETY_HOOK = join(ROOT, 'hooks', 'safety-guard.mjs');

function run(file, inputObj, extraEnv = {}) {
  return spawnSync(process.execPath, [file], {
    input: typeof inputObj === 'string' ? inputObj : JSON.stringify(inputObj),
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

// --- ralph-loop-stop ---

test('ralph-loop-stop: continue → decision:block and iteration increment', () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, max_iterations: 60,
    last_session_id: 'old', next_step_prompt: 'do X' });
  try {
    const r = run(STOP_HOOK, { session_id: 'live', stop_hook_active: false }, { CLAUDE_PROJECT_DIR: p.dir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision":"block"/);
    assert.match(r.stdout, /do X/);
    assert.equal(readFrontmatter(p.stateFile).iteration, 1);   // behaviour: the counter grew
    const continuation = JSON.parse(r.stdout);
    const iteration = readFrontmatter(p.stateFile).iteration;
    assert.match(continuation.reason, new RegExp(`iteration: ${iteration}/60 \\|`),
      'the Stop hook has already written the iteration before its continuation is delivered');
    assert.match(continuation.systemMessage, new RegExp(`iter ${iteration}/60`));
  } finally { p.cleanup(); }
});

test('ralph-loop-stop: blockers → stop (no decision:block, iteration does not grow), exit 0', () => {
  const p = mkTempProject({ current_version: '1', iteration: 0, blockers: [{ type: 'x' }],
    next_step_prompt: 'do X' });
  try {
    const r = run(STOP_HOOK, { session_id: 'live' }, { CLAUDE_PROJECT_DIR: p.dir });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /"decision":"block"/);
    assert.equal(readFrontmatter(p.stateFile).iteration, 0);
  } finally { p.cleanup(); }
});

test('ralph-loop-stop: fail open when STATE is missing (exit 0)', () => {
  const empty = mkdtempSync(join(tmpdir(), 'no-state-'));
  try {
    const r = run(STOP_HOOK, { session_id: 'live' }, { CLAUDE_PROJECT_DIR: empty });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /"decision":"block"/);
  } finally { cleanupTempDirSync(empty); }
});

test('ralph-loop-stop: fail open when STATE has no frontmatter (exit 0)', () => {
  const d = mkdtempSync(join(tmpdir(), 'bad-state-'));
  mkdirSync(join(d, 'docs'), { recursive: true });
  writeFileSync(join(d, 'docs', 'STATE.md'), '# no frontmatter\ntext', 'utf8');
  try {
    const r = run(STOP_HOOK, { session_id: 'live' }, { CLAUDE_PROJECT_DIR: d });
    assert.equal(r.status, 0);
  } finally { cleanupTempDirSync(d); }
});

// --- safety-guard ---

test('ralph-loop-stop: configured no_progress thresholds and zero use real state across invocations', () => {
  for (const threshold of [0, 1, 2, 5]) {
    const p = mkTempProject({ no_progress_after: threshold, current_version: '1', max_iterations: 60,
      roadmap_review_every: 0, next_step_prompt: 'do X' },
      { baseDir: process.env.FRAMEWORK_TEST_TMPDIR || tmpdir() });
    try {
      const calls = threshold === 0 ? 7 : threshold + 1; // The first call establishes the hook baseline.
      for (let i = 0; i < calls; i++) {
        const result = run(STOP_HOOK, { session_id: `threshold-${threshold}` },
          { CLAUDE_PROJECT_DIR: p.dir, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' });
        assert.equal(result.status, 0, result.stderr);
        if (threshold > 0 && i === threshold) {
          assert.equal(result.stdout, '');
          assert.equal(readFrontmatter(p.stateFile).blockers[0]?.type, 'no_progress');
        } else {
          assert.equal(JSON.parse(result.stdout).decision, 'block');
          assert.equal(readFrontmatter(p.stateFile).blockers.length, 0);
          if (threshold === 0) assert.doesNotMatch(result.stdout, /SUPERVISOR ESCALATION/);
        }
      }
      assert.equal(readFrontmatter(p.stateFile).iteration, calls);
    } finally { p.cleanup(); }
  }
});

test('safety-guard: destructive → permissionDecision:deny, exit 0', () => {
  const r = run(SAFETY_HOOK, { tool_name: 'Bash', tool_input: { command: 'git push --force' } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /"permissionDecision":"deny"/);
});

// v1.2.0: a safe operation gets an EXPLICIT allow rather than silence. It was that silence which
// used to send the question to the ordinary permission system, which showed a prompt to the user
// even with bypassPermissions enabled.
test('safety-guard: a safe Bash command → permissionDecision:allow, exit 0', () => {
  const r = run(SAFETY_HOOK, { tool_name: 'Bash', tool_input: { command: 'git status' } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /"permissionDecision":"allow"/);
});

test('safety-guard: non-Bash tools also get allow (otherwise a prompt appears)', () => {
  for (const tool of ['Read', 'Write', 'Edit', 'mcp__github__create_pull_request']) {
    const r = run(SAFETY_HOOK, { tool_name: tool, tool_input: { file_path: 'x' } });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"permissionDecision":"allow"/, `tool ${tool}`);
  }
});

test('safety-guard: fail open on empty and malformed stdin (exit 0, no deny)', () => {
  for (const bad of ['', '{broken']) {
    const r = run(SAFETY_HOOK, bad);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /deny/);
  }
});

test('safety-guard: guard-only mode restores the previous behaviour (silence on safe commands)', () => {
  const r = run(SAFETY_HOOK, { tool_name: 'Bash', tool_input: { command: 'git status' } },
    { SAFETY_GUARD_MODE: 'guard-only' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '', 'in guard-only mode no decision is returned');
});

test('safety-guard: destructive commands are blocked in both modes', () => {
  for (const env of [{}, { SAFETY_GUARD_MODE: 'guard-only' }]) {
    const r = run(SAFETY_HOOK, { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }, env);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"permissionDecision":"deny"/);
  }
});
