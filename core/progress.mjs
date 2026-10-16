// core/progress.mjs — measures whether an agent turn made progress (v1.1.0, Phase 2 of the
// headless-execution fix).
//
// WHY: an "empty" turn (the agent talked but changed neither git nor STATE) must not slip through
// unnoticed in an unattended loop. The supervisor takes a snapshot BEFORE the turn and AFTER it
// (but before writing its own iteration counter into STATE — otherwise it would mistake its own
// write for progress), compares them, and escalates or blocks per the "no_progress" failure mode.
//
// SRP: this module only snapshots and compares; deciding what to do about it is the supervisor's
// job. Progress signals (any one of): a new git HEAD, a changed working tree, a changed STATE.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DOCUMENT_DEFAULTS } from './project-config.mjs';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return (r && r.status === 0) ? r.stdout : null;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// Snapshot of the observable project state. Outside a git repository the fields are null (we do
// not crash).
export function captureSnapshot({ cwd = process.cwd(), stateFile = null, ignoredFiles = [] } = {}) {
  const head = git(cwd, ['rev-parse', 'HEAD']);
  // Tree: staged+unstaged diff against HEAD plus the list of untracked files (stable order).
  const diff = git(cwd, ['diff', 'HEAD']);
  const untrackedRaw = git(cwd, ['-c','core.quotepath=false','ls-files', '--others', '--exclude-standard']);
  const ignored = new Set(ignoredFiles);
  const untracked = untrackedRaw===null?null:untrackedRaw.split('\n').filter(path=>!ignored.has(path)).join('\n');
  let stateHash = null;
  if (stateFile && existsSync(stateFile)) {
    try { stateHash = sha256(readFileSync(stateFile, 'utf8')); } catch { stateHash = null; }
  }
  return {
    gitHead: head ? head.trim() : null,
    treeHash: (diff !== null || untracked !== null) ? sha256(`${diff ?? ''} ${untracked ?? ''}`) : null,
    stateHash,
  };
}

// Compare two snapshots → was there measurable progress, and what is the evidence.
export function assessProgress(before, after) {
  const evidence = [];
  if (before.gitHead !== after.gitHead) evidence.push(`git HEAD: ${short(before.gitHead)} → ${short(after.gitHead)}`);
  if (before.treeHash !== after.treeHash) evidence.push('working tree changed');
  if (before.stateHash !== after.stateHash) evidence.push('STATE.md changed');
  return { progressed: evidence.length > 0, evidence };
}

// Escalation directive appended to the next turn's prompt (after `stagnantTurns` empty turns).
export function escalationDirective(prompt, stagnantTurns, statePath = DOCUMENT_DEFAULTS.state.path) {
  return `${prompt}\n\n[SUPERVISOR ESCALATION] The previous turns (${stagnantTurns} in a row) ` +
    `produced no measurable progress: no git changes and no ${statePath} update. Stop planning — ` +
    'EXECUTE the next concrete step with tools (Bash/Edit/Write) in this very turn and record the ' +
    `result: a git commit and/or an update to ${statePath}. If the step is genuinely impossible, ` +
    `write a REAL blocker into ${statePath} (the blockers field) with the reason.`;
}

function short(sha) { return sha ? String(sha).slice(0, 7) : 'none'; }

export default { captureSnapshot, assessProgress, escalationDirective };
