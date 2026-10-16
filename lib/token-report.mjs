#!/usr/bin/env node
// lib/token-report.mjs — token usage per session, per day and per model, plus the plan limit
// expressed in list-price dollars and tokens. The arithmetic lives in core/token-usage.mjs.
//
// Usage:
//   node lib/token-report.mjs                        — report over docs/logs of this project
//   node lib/token-report.mjs --logs <dir> [--json]  — another log directory / machine-readable
//   node lib/token-report.mjs session <transcript.jsonl> <out.usage.json>
//        — called by hooks/save-session-log: writes the session's usage next to its log and prints
//          a markdown section for the human-readable summary.
//
// Inputs, both written automatically once the project is bootstrapped:
//   docs/logs/<date>/*.usage.json   — hooks/save-session-log, on every Stop and SessionEnd
//   docs/logs/limits.jsonl          — hooks/usage-statusline, whenever the plan share moves

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseJsonl, sumUsage, mergeUsage, usageTable, totalTokens, formatTokens,
  calibrate, tokensPerUsd, median, TOKEN_KINDS, LIMITS_FILE,
} from '../core/token-usage.mjs';

export { LIMITS_FILE };
import { findProjectRoot, loadProjectConfig } from '../core/project-config.mjs';

// A subagent writes its own transcript next to the session's: <session>/subagents/*.jsonl. Its
// requests draw on the same plan, so leaving them out would make delegation look free.
export function sessionFiles(transcriptPath) {
  const files = [transcriptPath];
  const sub = join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), 'subagents');
  if (existsSync(sub)) {
    for (const f of readdirSync(sub).sort()) if (f.endsWith('.jsonl')) files.push(join(sub, f));
  }
  return files;
}

export function readSessionUsage(transcriptPath) {
  const records = sessionFiles(transcriptPath).flatMap(f => parseJsonl(readFileSync(f, 'utf8')));
  const withId = records.find(r => r && r.sessionId);
  return {
    session: (withId && withId.sessionId) || basename(transcriptPath, '.jsonl'),
    ...sumUsage(records),
  };
}

export function sessionSection(usage) {
  return [
    '', '---', '', '## Token usage', '',
    usageTable(usage), '',
    '_Each API response counted once; subagent transcripts included. Plan-limit share over all ' +
      'sessions: `node lib/token-report.mjs`._',
    '',
  ].join('\n');
}

function findUsageFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...findUsageFiles(p));
    else if (name.endsWith('.usage.json')) out.push(p);
  }
  return out;
}

// A session that crosses midnight is logged under two dates, each file holding the running total
// of the SAME session. Keeping the fullest copy counts it once.
export function loadSessions(logsDir) {
  const bySession = new Map();
  for (const f of findUsageFiles(logsDir)) {
    let u;
    try { u = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
    if (!u || !u.session) continue;
    const prev = bySession.get(u.session);
    if (!prev || totalTokens(u.total) > totalTokens(prev.total)) bySession.set(u.session, u);
  }
  return [...bySession.values()].sort((a, b) => String(a.first).localeCompare(String(b.first)));
}

export function loadSnapshots(logsDir) {
  const p = join(logsDir, LIMITS_FILE);
  return existsSync(p) ? parseJsonl(readFileSync(p, 'utf8')) : [];
}

export function buildReport(logsDir) {
  const sessions = loadSessions(logsDir);
  const snapshots = loadSnapshots(logsDir);
  const days = new Map();
  for (const s of sessions) {
    const day = String(s.first || 'unknown').slice(0, 10);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(s);
  }
  const mix = tokensPerUsd(sessions, snapshots);
  const sessionStarts = new Map(sessions.filter(s => s.first).map(s => [s.session, s.first]));
  const windows = {};
  for (const w of ['d7', 'h5']) {
    const periods = calibrate(snapshots, { window: w, sessionStarts });
    const capacity = median(periods.map(p => p.capacity_usd));
    const tokens = capacity != null && mix
      ? Object.fromEntries([...TOKEN_KINDS, 'total'].map(k => [k, Math.round(capacity * mix[k])]))
      : null;
    windows[w] = { periods, capacity_usd: capacity, tokens };
  }
  return {
    sessions: sessions.length,
    snapshots: snapshots.length,
    first: sessions.length ? sessions[0].first : null,
    last: sessions.length ? sessions[sessions.length - 1].last : null,
    all: mergeUsage(sessions),
    days: [...days.entries()].map(([day, list]) => ({ day, sessions: list.length, ...mergeUsage(list) })),
    mix,
    windows,
  };
}

const WINDOW_NAMES = { d7: 'Weekly window', h5: '5-hour window' };

export function formatReport(r) {
  const out = [];
  if (!r.sessions) {
    out.push('No session usage recorded yet (*.usage.json in the configured logs role is written by hooks/save-session-log).');
  } else {
    out.push(`# Token usage — ${r.sessions} session(s), ${r.first} … ${r.last}`, '');
    out.push('## By model', '', usageTable(r.all), '');
    out.push('## By day (a session belongs to the day it started)', '');
    out.push('| day | sessions | requests | total tokens | output |', '| --- | --- | --- | --- | --- |');
    for (const d of r.days) {
      out.push(`| ${d.day} | ${d.sessions} | ${d.total.requests} | ${formatTokens(totalTokens(d.total))} | ${formatTokens(d.total.output)} |`);
    }
    out.push('');
  }
  out.push('## Plan limit, measured', '');
  for (const [w, name] of Object.entries(WINDOW_NAMES)) {
    const win = r.windows[w];
    if (!win.periods.length) {
      out.push(`**${name}:** not measured yet — needs at least 5 points of movement inside one window, ` +
        `recorded by hooks/usage-statusline (${r.snapshots} snapshot(s) so far).`, '');
      continue;
    }
    out.push(`**${name}:** ≈ $${win.capacity_usd} of list-price work (median of ${win.periods.length} window(s))`);
    for (const p of win.periods) {
      out.push(`- resets ${new Date(p.resets_at * 1000).toISOString().slice(0, 16)}Z: ` +
        `${p.pct_from}% → ${p.pct_to}% (+${p.delta_pct}) for $${p.spend_usd} → $${p.usd_per_pct} per 1 %`);
    }
    if (win.tokens) {
      out.push(`- at this project's token mix: ${TOKEN_KINDS.map(k => `${k.replace('_', ' ')} ${formatTokens(win.tokens[k])}`).join(' · ')}` +
        ` (total ${formatTokens(win.tokens.total)})`);
    }
    out.push('');
  }
  out.push('_The percentage also counts claude.ai chat and other machines while the spend does not, ' +
    'so a measured capacity errs low. List price is Claude Code\'s own estimate, not a bill._');
  return out.join('\n');
}

function main(argv) {
  if (argv[0] === 'session') {
    const [, transcript, dest] = argv;
    if (!transcript || !dest) throw new Error('usage: token-report.mjs session <transcript.jsonl> <out.usage.json>');
    const usage = { ...readSessionUsage(transcript), transcript, generated_at: new Date().toISOString() };
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, JSON.stringify(usage, null, 2) + '\n');
    process.stdout.write(sessionSection(usage));
    return;
  }
  let logs = loadProjectConfig({ projectDir: process.env.CLAUDE_PROJECT_DIR || findProjectRoot() }).documentPath('logs');
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--logs') logs = resolve(argv[++i] || '.');
    else if (argv[i] === '--json') json = true;
    else throw new Error(`unknown argument "${argv[i]}"`);
  }
  const report = buildReport(logs);
  process.stdout.write((json ? JSON.stringify(report, null, 2) : formatReport(report)) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`token-report: ${e.message}\n`);
    process.exit(2);
  }
}
