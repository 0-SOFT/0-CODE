#!/usr/bin/env node
// hooks/usage-statusline.mjs — the status line: shows how much of the plan is used, and records it.
//
// The status line is the ONLY place Claude Code hands a script the plan share
// (`rate_limits.five_hour` / `seven_day`): hooks, transcripts and `claude -p` output do not carry
// it. So this is where the share is written down — to docs/logs/limits.jsonl, one line whenever the
// share or the session's list-price cost moved — and lib/token-report.mjs turns those lines plus the
// session token counts into "one week of the plan ≈ N dollars ≈ M tokens".
//
// A status line must never break the terminal: every failure here degrades to "print what we can".
//
// Claude Code has ONE status line, and project settings outrank the user's. So a project that
// installs this one would hide a status line the person already uses. It does not have to: set
// USAGE_STATUSLINE_NEXT to that command and it receives the same payload and draws the bar, while
// this script only records.

import { readFileSync, appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { snapshotFromStatus, snapshotChanged, statusLine, parseJsonl, LIMITS_FILE } from '../core/token-usage.mjs';
import { findProjectRoot, loadProjectConfig } from '../core/project-config.mjs';

const TAIL_BYTES = 64 * 1024;

export function limitsPath(payload) {
  const dir = (payload && payload.workspace && payload.workspace.project_dir)
    || process.env.CLAUDE_PROJECT_DIR || (payload && payload.cwd) || process.cwd();
  return join(loadProjectConfig({ projectDir: findProjectRoot(dir) }).documentPath('logs'), LIMITS_FILE);
}

// Only the tail is read: the file grows for as long as the project lives, the status line runs on
// every message, and the previous snapshot of a live session is always near the end.
export function lastSnapshotFor(file, session) {
  if (!existsSync(file)) return null;
  const size = statSync(file).size;
  const len = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  const lines = parseJsonl(buf.toString('utf8'));
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].session === session) return lines[i];
  return null;
}

export function recordSnapshot(payload, now = new Date()) {
  const snap = snapshotFromStatus(payload, now);
  if (!snap) return false;
  const file = limitsPath(payload);
  if (!snapshotChanged(lastSnapshotFor(file, snap.session), snap)) return false;
  mkdirSync(join(file, '..'), { recursive: true });
  appendFileSync(file, JSON.stringify(snap) + '\n');
  return true;
}

// The person's own status line, fed the same payload. null when none is set or it failed — then
// ours is shown rather than an empty bar.
export function chainedLine(command, raw) {
  if (!command) return null;
  const r = spawnSync(command, { input: raw, shell: true, encoding: 'utf8', timeout: 5000 });
  return r.status === 0 && r.stdout ? r.stdout : null;
}

function main() {
  let raw = '', payload = {};
  try { raw = readFileSync(0, 'utf8'); payload = JSON.parse(raw || '{}'); } catch { /* print what we can */ }
  try { recordSnapshot(payload); } catch (e) {
    process.stderr.write(`usage-statusline: ${e.message}\n`);
  }
  const own = chainedLine(process.env.USAGE_STATUSLINE_NEXT, raw);
  process.stdout.write(own || statusLine(payload) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
