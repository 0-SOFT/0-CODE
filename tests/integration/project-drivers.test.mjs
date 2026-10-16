import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installProject } from '../../core/project-installation.mjs';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';
import { cleanupTempDir, readFrontmatter } from '../helpers/index.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const scratch = join(dirname(repo.replace(/[\\/]$/, '')), 'scratch', 'tmp');
mkdirSync(scratch, { recursive: true });
function fixture(t, modules = {}) {
  const root = mkdtempSync(join(scratch, 'drivers-'));
  t.after(() => cleanupTempDir(root));
  installProject(root, { config: { engines: ['claude'], language: 'ru', guard: { mode: 'allow-all' },
    modules: { ...Object.fromEntries(Object.keys(PROJECT_MODULES).map(id => [id, false])), ...modules },
    documents: { state: { path: 'work/status.md' }, roadmap: { path: 'PLAN.md' },
      decisions: { path: 'work/adr', name: 'choose-<name>-<version>.md' },
      logs: { path: 'history/sessions', name: '<id>-<date>.jsonl' } } } });
  return root;
}
function run(root, path, args = [], input = {}, environment = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root, ...environment };
  if (environment.SAFETY_GUARD_MODE === undefined) delete env.SAFETY_GUARD_MODE;
  if (environment.SAFETY_GUARD_LOG === undefined) delete env.SAFETY_GUARD_LOG;
  return spawnSync(process.execPath, [join(root, '.0-code', path), ...args],
    { cwd: join(root, '.0-code'), env, encoding: 'utf8', input: JSON.stringify(input), windowsHide: true });
}
test('installed supervisor and Stop hook read custom roles; process files and backups stay in run', t => {
  const root = fixture(t), state = join(root, 'work/status.md');
  const before = readFileSync(state);
  const preview = run(root, 'core/supervisor.mjs', ['--dry-run']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /work\/status.md/); assert.deepEqual(readFileSync(state), before);
  assert.equal(existsSync(join(root, '.0-code/run/.loop.lock')), false);
  const first = run(root, 'hooks/ralph-loop-stop.mjs', [], { session_id: 'custom-cycle' });
  assert.equal(first.status, 0, first.stderr);
  const reason = JSON.parse(first.stdout).reason;
  assert.match(reason, /work\/status.md/); assert.match(reason, /PLAN.md/);
  assert.equal(reason.includes('docs/STATE.md'), false); assert.equal(reason.includes('docs/ROADMAP.md'), false);
  assert.equal(readFrontmatter(state).iteration, 1);
  assert.equal(existsSync(join(root, '.0-code/run/.loop.lock')), true);
  assert.equal(existsSync(join(root, '.0-code/run/.loop-progress')), true);
  assert.ok(readdirSync(join(root, '.0-code/run')).some(name => name.endsWith('.bak.1')));
  assert.deepEqual(readdirSync(join(root, 'work')), ['status.md']);
  const patch = run(root, 'lib/update-state.mjs', [state], { iteration: 10 });
  assert.equal(patch.status, 0, patch.stderr);
  mkdirSync(join(root, 'work/adr'), { recursive: true });
  writeFileSync(join(root, 'work/adr/choose-layout-0.0.1.md'), readFileSync(join(repo, 'templates/decision.md'), 'utf8').replace('version: "X.Y.Z"', 'version: "0.0.1"'));
  const next = run(root, 'hooks/ralph-loop-stop.mjs', [], { session_id: 'custom-cycle' });
  const reviewed = JSON.parse(next.stdout).reason;
  assert.match(reviewed, /ROADMAP REVIEW/); assert.match(reviewed, /PLAN.md/);
  assert.match(reviewed, /choose-layout-0.0.1.md/);
  assert.equal(existsSync(join(root, 'docs')), false);
});
test('installed guard uses project mode and exported environment overrides it', t => {
  const root = fixture(t), payload = { tool_name: 'Bash', tool_input: { command: 'git push --force' } };
  const allowed = run(root, 'hooks/safety-guard.mjs', [], payload);
  assert.equal(JSON.parse(allowed.stdout).hookSpecificOutput.permissionDecision, 'allow');
  const denied = run(root, 'hooks/safety-guard.mjs', [], payload, { SAFETY_GUARD_MODE: 'arbiter' });
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const records = readFileSync(join(root, '.0-code/run/guard.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2);
});
test('installed logger and token report use custom names, count actual transcript once and preserve old user logs', t => {
  const root = fixture(t, { session_logs: true, token_usage: true });
  const transcript = join(root, 'input.jsonl'), message = { type: 'assistant', sessionId: 'session-one',
    message: { id: 'response-one', model: 'test-model', content: [{ type: 'text', text: '\u0413\u043e\u0442\u043e\u0432\u043e.' }], usage: { input_tokens: 3, output_tokens: 7 } } };
  writeFileSync(transcript, JSON.stringify(message) + '\n' + JSON.stringify(message) + '\n');
  const logs = join(root, 'history/sessions'); mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'user.jsonl'), 'private project log');
  writeFileSync(join(logs, 'limits.jsonl'), '{"history":true}\n');
  const old = new Date(Date.now() - 40 * 86400000);
  for (const path of ['user.jsonl', 'limits.jsonl']) utimesSync(join(logs, path), old, old);
  const payload = { session_id: 'session-one', transcript_path: transcript, cwd: root, hook_event_name: 'Stop' };
  for (let i = 0; i < 2; i++) { const saved = run(root, 'hooks/save-session-log.mjs', [], payload); assert.equal(saved.status, 0, saved.stderr); assert.equal(saved.stderr, ''); }
  const jsonl = readdirSync(logs).filter(name => name.startsWith('session-one-') && name.endsWith('.jsonl'));
  assert.equal(jsonl.length, 1); assert.deepEqual(readFileSync(join(logs, jsonl[0])), readFileSync(transcript));
  const base = join(logs, jsonl[0].replace(/\.jsonl$/, ''));
  assert.match(readFileSync(base + '.summary.md', 'utf8'), /\u0416\u0443\u0440\u043d\u0430\u043b \u0441\u0435\u0441\u0441\u0438\u0438/);
  assert.equal(JSON.parse(readFileSync(base + '.usage.json', 'utf8')).total.requests, 1);
  const report = run(root, 'lib/token-report.mjs', ['--json']);
  assert.equal(report.status, 0, report.stderr); assert.equal(JSON.parse(report.stdout).all.total.output, 7);
  assert.equal(readFileSync(join(logs, 'user.jsonl'), 'utf8'), 'private project log');
  assert.equal(readFileSync(join(logs, 'limits.jsonl'), 'utf8'), '{"history":true}\n');
  const status = run(root, 'hooks/usage-statusline.mjs', [], { session_id: 'session-one', workspace: { project_dir: root },
    rate_limits: { seven_day: { used_percentage: 12, resets_at: 2000000000 } }, cost: { total_cost_usd: 1 } });
  assert.equal(status.status, 0, status.stderr); assert.match(status.stdout, /week 12%/);
  assert.match(readFileSync(join(logs, 'limits.jsonl'), 'utf8'), /session-one/);
  assert.equal(existsSync(join(root, 'docs')), false);
});
test('logger refuses a path in a session identifier before writing outside its role', t => {
  const root = fixture(t, { session_logs: true }), transcript = join(root, 'input.jsonl'); writeFileSync(transcript, '{}\n');
  const saved = run(root, 'hooks/save-session-log.mjs', [], { session_id: '../escape', transcript_path: transcript });
  assert.equal(saved.status, 0); assert.match(saved.stderr, /path|directory/i);
  assert.equal(existsSync(join(root, 'history')), false);
});
