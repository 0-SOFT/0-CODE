#!/usr/bin/env node
// tools/doctor-permissions.mjs — "why am I being asked for permission?"
//
// WHY (v1.2.0): research showed that a prompt has several possible causes and none of them are
// visible from the outside: an `ask` rule outranks any mode; a broken settings file is ignored
// SILENTLY together with all of its rules; a hook can reference a non-existent variable and run
// for nothing. Working this out used to take half a day of experiments. Now it takes one command.
//
// Usage:
//   node tools/doctor-permissions.mjs [project-directory]

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAskRules, DEFAULT_MODE } from '../core/permissions-policy.mjs';

// Variables that do NOT exist in the hook contract. A hook that reads them runs for nothing and
// creates a false sense of safety.
const PHANTOM_VARS = ['CLAUDE_TOOL_INPUT', 'CLAUDE_TOOL_NAME', 'CLAUDE_COMMAND'];

// Settings levels in order of application (later means stronger).
export function settingsLevels(projectDir, home = homedir()) {
  return [
    { name: 'user', path: join(home, '.claude', 'settings.json') },
    { name: 'project', path: join(projectDir, '.claude', 'settings.json') },
    { name: 'local', path: join(projectDir, '.claude', 'settings.local.json') },
  ];
}

export function loadLevel(level) {
  if (!existsSync(level.path)) return { ...level, state: 'no file' };
  let raw;
  try { raw = readFileSync(level.path, 'utf8'); }
  catch (e) { return { ...level, state: 'unreadable', error: e.message }; }
  try { return { ...level, state: 'ok', settings: JSON.parse(raw) }; }
  catch (e) { return { ...level, state: 'BROKEN', error: e.message }; }
}

// A hyper-specific allow entry: a whole command with paths and quotes instead of a glob. These
// come from the "always allow" button and almost never match again.
export function isJunkAllowRule(rule) {
  const s = String(rule);
  if (s.length > 120) return true;
  if (/[\u00AB\u00BB]|\uFFFD/.test(s)) return true;          // traces of broken encoding
  return /^Bash\(.*["'].{40,}["']/.test(s);                      // a long quoted string
}

// The main check: a list of problems, each with a ready-made cure.
export function diagnose(levels, { projectHint = '<project directory>' } = {}) {
  const problems = [];
  for (const lv of levels) {
    if (lv.state === 'BROKEN') {
      problems.push({
        level: lv.name,
        problem: `the settings file does not parse as JSON (${lv.error})`,
        consequence: 'Claude Code SILENTLY ignores the whole file, so neither allows nor denies apply',
        cure: `fix the JSON syntax in ${lv.path}`,
      });
      continue;
    }
    if (lv.state !== 'ok') continue;

    const ask = findAskRules(lv.settings);
    if (ask.length) {
      problems.push({
        level: lv.name,
        problem: `ask rules are present (${ask.length}): ${ask.join(', ')}`,
        consequence: 'an ask rule outranks any mode, including bypassPermissions, and outranks the hook decision',
        cure: `remove the ask category entirely — the guard hook decides instead: node tools/gen-settings.mjs --project ${projectHint}`,
      });
    }

    const mode = lv.settings?.permissions?.defaultMode;
    if (lv.name === 'project' && !mode) {
      problems.push({
        level: lv.name,
        problem: 'permissions.defaultMode is not set',
        consequence: 'the mode depends on a manual toggle in the interface and is lost between sessions',
        cure: `add "defaultMode": "${DEFAULT_MODE}": node tools/gen-settings.mjs --project ${projectHint}`,
      });
    }

    const junk = (lv.settings?.permissions?.allow || []).filter(isJunkAllowRule);
    if (junk.length) {
      problems.push({
        level: lv.name,
        problem: `hyper-specific allow entries (${junk.length})`,
        consequence: 'traces of the "always allow" button: they almost never match again while the list keeps growing',
        cure: `delete them: node tools/gen-settings.mjs --project ${projectHint}${'' } (add --user for the user-level file)`,
        entries: junk,
      });
    }

    for (const [event, entries] of Object.entries(lv.settings?.hooks || {})) {
      for (const entry of entries || []) {
        for (const h of entry.hooks || []) {
          const cmd = String(h.command || '');
          const phantom = PHANTOM_VARS.filter(v => cmd.includes('$' + v) || cmd.includes('%' + v + '%'));
          if (phantom.length) {
            problems.push({
              level: lv.name,
              problem: `the ${event} hook reads non-existent variables: ${phantom.join(', ')}`,
              consequence: 'the checks inside the hook NEVER fire, so the protection is imaginary',
              cure: 'read the event from standard input as JSON, the way hooks/safety-guard.mjs does',
            });
          }
        }
      }
    }
  }

  const project = levels.find(l => l.name === 'project');
  const hasGuard = project?.state === 'ok' && (project.settings?.hooks?.PreToolUse || [])
    .some(e => (e.hooks || []).some(h => String(h.command || '').includes('safety-guard')));
  if (project?.state === 'ok' && !hasGuard) {
    problems.push({
      level: 'project',
      problem: 'the safety-guard arbiter hook is not registered',
      consequence: 'decisions fall to the ordinary permission system, so prompts become possible and destructive commands rely on globs alone',
      cure: `run node tools/gen-settings.mjs --project ${projectHint}`,
    });
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const projectDir = process.argv[2] || process.cwd();
  const levels = settingsLevels(projectDir).map(loadLevel);

  console.log('Claude Code permission check');
  console.log('Project:', projectDir);
  console.log('\nSettings levels (later in the list means stronger):');
  for (const lv of levels) {
    const mode = lv.settings?.permissions?.defaultMode;
    console.log(`  ${lv.name.padEnd(16)} ${lv.state.padEnd(10)} ${mode ? 'mode: ' + mode : ''} ${lv.path}`);
  }

  const problems = diagnose(levels, { projectHint: JSON.stringify(projectDir) });
  if (!problems.length) {
    console.log('\nOK No problems found. If a prompt still appears, it may be folder trust,');
    console.log('   an MCP server tool approval, or a domain approval: those prompts are not');
    console.log('   governed by the permission mode.');
    process.exit(0);
  }

  console.log(`\nFAIL problems found: ${problems.length}\n`);
  problems.forEach((p, i) => {
    console.log(`${i + 1}. [${p.level}] ${p.problem}`);
    console.log(`   consequence: ${p.consequence}`);
    console.log(`   cure:        ${p.cure}`);
    if (p.entries) p.entries.slice(0, 5).forEach(z => console.log(`     · ${String(z).slice(0, 100)}`));
    console.log('');
  });
  process.exit(1);
}
