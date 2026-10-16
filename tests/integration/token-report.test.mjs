import { cleanupTempDirSync } from '../helpers/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  sessionFiles, readSessionUsage, sessionSection, loadSessions, buildReport, formatReport, LIMITS_FILE,
} from '../../lib/token-report.mjs';
import { limitsPath, lastSnapshotFor, recordSnapshot, chainedLine } from '../../hooks/usage-statusline.mjs';

// v1.22.0: the two halves of "how many tokens is a week of the plan" — per-session token counts
// written by the session logger, and the plan share written by the status line — and the report
// that joins them.

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPORT = join(ROOT, 'lib', 'token-report.mjs');
const STATUSLINE = join(ROOT, 'hooks', 'usage-statusline.mjs');

const line = (id, usage, ts = '2026-09-01T10:00:00Z', model = 'claude-x') =>
  JSON.stringify({ type: 'assistant', sessionId: 'sess-1', timestamp: ts, message: { id, model, usage } });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'token-report-'));
  const transcript = join(dir, 'sess-1.jsonl');
  writeFileSync(transcript, [
    line('m1', { input_tokens: 5, cache_read_input_tokens: 1000, output_tokens: 100 }),
    line('m1', { input_tokens: 5, cache_read_input_tokens: 1000, output_tokens: 100 }),
    line('m2', { input_tokens: 5, cache_creation_input_tokens: 200, output_tokens: 50 }, '2026-09-01T11:00:00Z'),
  ].join('\n') + '\n');
  mkdirSync(join(dir, 'sess-1', 'subagents'), { recursive: true });
  writeFileSync(join(dir, 'sess-1', 'subagents', 'agent-a.jsonl'),
    line('sub1', { input_tokens: 1, output_tokens: 10 }, '2026-09-01T10:30:00Z', 'claude-small') + '\n');
  writeFileSync(join(dir, 'sess-1', 'subagents', 'notes.txt'), 'not a transcript');
  return { dir, transcript };
}

test('a session includes its subagents, and each response counts once', () => {
  const { dir, transcript } = fixture();
  try {
    assert.equal(sessionFiles(transcript).length, 2, 'the main transcript plus one subagent transcript');
    const u = readSessionUsage(transcript);
    assert.equal(u.session, 'sess-1');
    assert.equal(u.total.requests, 3);
    assert.equal(u.total.output, 160);
    assert.equal(u.models['claude-small'].output, 10, 'delegated work is not free');
    assert.match(sessionSection(u), /## Token usage/);
  } finally { cleanupTempDirSync(dir); }
});

test('without a sessionId in the records the file name identifies the session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-report-'));
  try {
    const t = join(dir, 'abc.jsonl');
    writeFileSync(t, JSON.stringify({ message: { id: 'x', usage: { output_tokens: 1 } } }) + '\n');
    assert.equal(readSessionUsage(t).session, 'abc');
  } finally { cleanupTempDirSync(dir); }
});

test('the `session` command writes .usage.json and prints the summary section', () => {
  const { dir, transcript } = fixture();
  try {
    const dest = join(dir, 'logs', '2026-09-01', '10-00-00_sess-1.usage.json');
    const r = spawnSync(process.execPath, [REPORT, 'session', transcript, dest], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\| claude-x \|/);
    const u = JSON.parse(readFileSync(dest, 'utf8'));
    assert.equal(u.total.requests, 3);
    assert.equal(u.transcript, transcript);
    const bad = spawnSync(process.execPath, [REPORT, 'session'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /usage: token-report/);
  } finally { cleanupTempDirSync(dir); }
});

function logsWithHistory() {
  const logs = mkdtempSync(join(tmpdir(), 'token-logs-'));
  const put = (day, name, obj) => {
    mkdirSync(join(logs, day), { recursive: true });
    writeFileSync(join(logs, day, name), typeof obj === 'string' ? obj : JSON.stringify(obj));
  };
  const usage = (session, output, first) => ({
    session, first, last: first,
    models: { 'claude-x': { requests: 2, input: 10, cache_write: 0, cache_read: 1000, output } },
    total: { requests: 2, input: 10, cache_write: 0, cache_read: 1000, output },
  });
  put('2026-09-01', 'a.usage.json', usage('s1', 100, '2026-09-01T23:00:00Z'));
  // The same session crossing midnight: a second, fuller copy under the next date.
  put('2026-09-02', 'a.usage.json', usage('s1', 300, '2026-09-01T23:00:00Z'));
  put('2026-09-02', 'b.usage.json', usage('s2', 50, '2026-09-02T09:00:00Z'));
  put('2026-09-02', 'broken.usage.json', '{not json');
  put('2026-09-02', 'nosession.usage.json', { total: {} });
  const reset = 2_000_000_000;
  const snaps = [
    { ts: '2026-09-01T23:00:00Z', session: 's1', cost_usd: 1, d7: 10, d7_reset: reset, h5: 1, h5_reset: 1 },
    { ts: '2026-09-02T00:30:00Z', session: 's1', cost_usd: 9, d7: 14, d7_reset: reset, h5: 2, h5_reset: 1 },
    { ts: '2026-09-02T09:00:00Z', session: 's2', cost_usd: 2, d7: 15, d7_reset: reset, h5: 3, h5_reset: 1 },
    { ts: '2026-09-02T10:00:00Z', session: 's2', cost_usd: 12, d7: 20, d7_reset: reset, h5: 4, h5_reset: 1 },
  ];
  writeFileSync(join(logs, LIMITS_FILE), snaps.map(s => JSON.stringify(s)).join('\n') + '\n');
  return logs;
}

test('the report counts a midnight-crossing session once and measures the weekly window', () => {
  const logs = logsWithHistory();
  try {
    const sessions = loadSessions(logs);
    assert.deepEqual(sessions.map(s => s.session), ['s1', 's2']);
    assert.equal(sessions[0].total.output, 300, 'the fuller copy wins');
    const r = buildReport(logs);
    assert.equal(r.sessions, 2);
    assert.equal(r.all.total.output, 350);
    assert.equal(r.days.length, 2);
    // Spend inside the window: s1 +8, s2 born inside +2 then +10 → $20 for 10 points.
    assert.equal(r.windows.d7.periods[0].spend_usd, 20);
    assert.equal(r.windows.d7.capacity_usd, 200);
    // Mix: s1 final $9 + s2 final $12 = $21 for 2 × 1010 input-side + 350 output tokens.
    assert.equal(r.mix.usd, 21);
    assert.equal(r.windows.d7.tokens.output, Math.round(200 * 350 / 21));
    assert.equal(r.windows.h5.periods.length, 0, 'a 3-point move of the 5-hour share is not a measurement');
    const text = formatReport(r);
    assert.match(text, /Weekly window:\*\* ≈ \$200/);
    assert.match(text, /5-hour window:\*\* not measured yet/);
    assert.match(text, /at this project's token mix/);
  } finally { cleanupTempDirSync(logs); }
});

test('the report command: text, json, an empty directory and a bad flag', () => {
  const logs = logsWithHistory();
  const empty = mkdtempSync(join(tmpdir(), 'token-empty-'));
  try {
    const text = spawnSync(process.execPath, [REPORT, '--logs', logs], { encoding: 'utf8' });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /# Token usage — 2 session/);
    const json = spawnSync(process.execPath, [REPORT, '--logs', logs, '--json'], { encoding: 'utf8' });
    assert.equal(JSON.parse(json.stdout).sessions, 2);
    const none = spawnSync(process.execPath, [REPORT], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: empty } });
    assert.equal(none.status, 0);
    assert.match(none.stdout, /No session usage recorded yet/);
    const bad = spawnSync(process.execPath, [REPORT, '--nope'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown argument/);
  } finally {
    cleanupTempDirSync(logs);
    cleanupTempDirSync(empty);
  }
});

const status = (dir, cost, d7, session = 's1') => ({
  session_id: session, workspace: { project_dir: dir }, cost: { total_cost_usd: cost },
  rate_limits: { seven_day: { used_percentage: d7, resets_at: 2_000_000_000 } },
});

test('the status line records a moved share once and skips repeats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'statusline-'));
  try {
    const file = limitsPath(status(dir, 1, 10));
    assert.equal(file, join(dir, 'docs', 'logs', LIMITS_FILE));
    assert.equal(lastSnapshotFor(file, 's1'), null);
    assert.equal(recordSnapshot(status(dir, 1, 10)), true);
    assert.equal(recordSnapshot(status(dir, 1, 10)), false, 'a timer refresh adds no line');
    assert.equal(recordSnapshot(status(dir, 1, 10, 's2')), true, 'another session is its own series');
    assert.equal(recordSnapshot(status(dir, 2, 11)), true);
    assert.equal(recordSnapshot({ session_id: 's1', workspace: { project_dir: dir } }), false, 'no limits, nothing to record');
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 3);
    assert.equal(lastSnapshotFor(file, 's1').cost_usd, 2);
    assert.equal(lastSnapshotFor(file, 'nobody'), null);
  } finally { cleanupTempDirSync(dir); }
});

test('limitsPath falls back to CLAUDE_PROJECT_DIR, then cwd', () => {
  const saved = process.env.CLAUDE_PROJECT_DIR;
  try {
    process.env.CLAUDE_PROJECT_DIR = '/proj';
    assert.equal(limitsPath({}), resolve('/proj', 'docs', 'logs', LIMITS_FILE));
    delete process.env.CLAUDE_PROJECT_DIR;
    assert.equal(limitsPath({ cwd: '/elsewhere' }), resolve('/elsewhere', 'docs', 'logs', LIMITS_FILE));
    assert.equal(limitsPath(null), join(process.cwd(), 'docs', 'logs', LIMITS_FILE));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
  }
});

test('a status line the person already had draws the bar; a broken one falls back to ours', () => {
  assert.equal(chainedLine('', '{}'), null);
  assert.equal(chainedLine(`"${process.execPath}" -e "process.stdin.pipe(process.stdout)"`, 'echoed'), 'echoed');
  assert.equal(chainedLine(`"${process.execPath}" -e "process.exit(3)"`, 'x'), null);
});

test('the status line script end to end: prints, records, and survives garbage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'statusline-'));
  try {
    const r = spawnSync(process.execPath, [STATUSLINE], { input: JSON.stringify(status(dir, 1.5, 12)), encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /week 12%/);
    assert.ok(existsSync(join(dir, 'docs', 'logs', LIMITS_FILE)));
    const chained = spawnSync(process.execPath, [STATUSLINE], {
      input: JSON.stringify(status(dir, 1.6, 12)), encoding: 'utf8',
      env: { ...process.env, USAGE_STATUSLINE_NEXT: `"${process.execPath}" -e "console.log('THEIRS')"` },
    });
    assert.equal(chained.stdout.trim(), 'THEIRS');
    const garbage = spawnSync(process.execPath, [STATUSLINE], { input: 'not json', encoding: 'utf8' });
    assert.equal(garbage.status, 0, 'a status line must never break the terminal');
    // A project directory that cannot be created: recording fails, the bar is still drawn.
    const blocker = join(dir, 'file');
    writeFileSync(blocker, '');
    const blocked = spawnSync(process.execPath, [STATUSLINE], { input: JSON.stringify(status(blocker, 1, 13)), encoding: 'utf8' });
    assert.equal(blocked.status, 0);
    assert.match(blocked.stdout, /week 13%/);
    assert.match(blocked.stderr, /usage-statusline:/);
  } finally { cleanupTempDirSync(dir); }
});
