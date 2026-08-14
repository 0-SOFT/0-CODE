#!/usr/bin/env node
// tools/provision-opencode.mjs — provisioning for the OpenCode backend (OpenRouter models).
//
// v1.3.0, extended in v1.4.0. Built from SINGLE sources:
//   - opencode.json      — permissions from core/permissions-policy.mjs plus MCP servers from
//                          config/mcp-manifest.json
//   - AGENTS.md          — the agent instructions (the same text as CLAUDE.md)
//   - the arbiter plugin — THE MAIN line of defence in ~/.config/opencode/plugins/ (outside the
//                          agent's working directory) plus a copy in .opencode/plugins/ for visibility
//
// Protection in OpenCode genuinely WORKS — verified by live experiment. The v1.4.0 audit showed
// why the main plugin must live outside the project: the agent deletes the in-project copy and
// rewrites the permissions to "allow". The global line of defence survives that.
//
// Run: node tools/provision-opencode.mjs [--target <projectDir>] [--dry-run]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  OpenCodeBackend, buildOpenCodePluginScript, generateOpenCodeMcp,
  toOpenCodePermissions, OPENCODE_PLUGIN_FILE, OPENCODE_CONFIG_FILE, globalPluginDir,
} from '../core/backends/opencode.mjs';
import { buildPermissionsBlock } from '../core/permissions-policy.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const o = { dryRun: false, target: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') o.dryRun = true;
    else if (argv[i] === '--target') o.target = argv[++i];
  }
  return o;
}

// Reading .env (config/.env, then the root one) — secrets are never committed and never reach the
// command line arguments.
function loadEnv(files) {
  const env = { ...process.env };
  for (const file of files) {
    if (!file || !existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*)\s*$/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  // A freshly cloned repository has no personal manifest — only the example. Falling back to it
  // means provisioning works out of the box instead of failing on a file the user was never told
  // to create. (Found by running the acceptance from the published tree rather than this one.)
  let manifestPath = join(ROOT, 'config', 'mcp-manifest.json');
  if (!existsSync(manifestPath)) {
    manifestPath = join(ROOT, 'config', 'mcp-manifest.example.json');
    console.log('  note: config/mcp-manifest.json not found — using the example manifest.');
    console.log('        Copy it to config/mcp-manifest.json and edit it for your own servers.');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const env = loadEnv([join(ROOT, 'config', '.env'), join(ROOT, '.env')]);
  const policy = buildPermissionsBlock();

  if (!env.OPENROUTER_API_KEY) {
    console.log('  ! OPENROUTER_API_KEY is not set — live runs are unavailable. The configuration will still be generated.');
  }

  if (opt.dryRun) {
    const { permission, dropped } = toOpenCodePermissions(policy);
    const { mcp, skipped } = generateOpenCodeMcp(manifest, env);
    const denials = Object.entries(permission.bash).filter(([, v]) => v === 'deny').length;
    console.log('[dry-run] target:', opt.target);
    console.log('[dry-run] ' + OPENCODE_CONFIG_FILE + ': bash denials =', denials,
      '| lost in translation =', dropped.length);
    console.log('[dry-run] MCP servers to register:', Object.keys(mcp).join(', ') || '(none)');
    console.log('[dry-run] MCP servers skipped:', skipped.join(', ') || '(none)');
    console.log('[dry-run] AGENTS.md ←', join(ROOT, 'CLAUDE.md'));
    console.log('[dry-run] arbiter plugin (main line of defence):', join(globalPluginDir(), 'safety-guard.js'));
    console.log('[dry-run] arbiter plugin (copy inside the project):', OPENCODE_PLUGIN_FILE);
    return;
  }

  const backend = new OpenCodeBackend();

  const perm = await backend.applyPermissions({ policy, targetDir: opt.target });
  console.log('  Permissions →', perm.file);
  if (perm.dropped.length) console.log('  ! rules that could not be translated:', perm.dropped.join(', '));

  const mcp = await backend.registerMcp(manifest, env, { targetDir: opt.target });
  console.log('  MCP:', mcp.registered.join(', ') || '(none)');
  console.log('  MCP skipped:', mcp.skipped.join(', ') || '(none)');

  const instrPath = join(ROOT, 'CLAUDE.md');
  if (existsSync(instrPath)) {
    const r = await backend.installInstructions({ targetDir: opt.target, content: readFileSync(instrPath, 'utf8') });
    console.log('  Instructions:', r.written.join(', '));
  }

  const r = await backend.ensureReady({ targetDir: opt.target, cwd: opt.target });
  const globalPath = join(globalPluginDir(), 'safety-guard.js');
  console.log('  Arbiter plugin (main line of defence):', globalPath);
  console.log('  Arbiter plugin (copy inside the project):', join(opt.target, OPENCODE_PLUGIN_FILE));
  console.log('  OK Protection is ACTIVE and beyond the agent reach: the main plugin lives OUTSIDE');
  console.log('     the working directory. The v1.4.0 audit showed the agent deletes the in-project');
  console.log('     copy and rewrites permissions to "allow" — the global line of defence survives');
  console.log('     that and keeps blocking (verified by live experiment).');
  console.log('     The rules are shared with the Claude Code backend (core/safety.mjs).');
}

main().catch(e => { console.error('provision-opencode:', e.message); process.exit(1); });
