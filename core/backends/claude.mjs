// core/backends/claude.mjs — the Claude Code / Claude CLI backend adapter.
//
// v0.8.0, Phase 1. Wraps the existing path (the claude CLI, settings.json, claude mcp) behind the
// shared Backend interface. IMPORTANT: the autonomous loop still lives on the Stop hook
// (hooks/ralph-loop-stop.mjs) — this adapter is used by the external supervisor
// (core/supervisor.mjs) as an ALTERNATIVE way to drive the loop (for OpenCode it is the primary
// one). So adding the adapter does NOT change Claude Code's default behaviour (no regression).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Backend } from './Backend.mjs';
import { guardReason } from '../permission-decision.mjs';
import { runCliAsync } from './spawn-cli.mjs';
import { registerClaudeMcp } from './claude-mcp.mjs';
import { readJsonConfig, writeJsonConfig } from '../../lib/json-config.mjs';
import { resolveEngineSettings } from '../engine-settings.mjs';
import { loadEngineSettingsEnvironment } from '../../lib/codex-env.mjs';
import { publishProjectInstructions } from '../../lib/project-instructions.mjs';
import { LEGACY_FRAMEWORK_DENY } from '../permissions-policy.mjs';
import { loadProjectConfig } from '../project-config.mjs';

export function claudeProjectArgs(cwd,env=process.env) {
  const project=loadProjectConfig({projectDir:cwd,env});
  return project.installed&&project.config.instructions.claude_settings==='.0-code/claude/settings.json'
    ?['--settings',join(project.projectDir,project.config.instructions.claude_settings)]:[];
}

export class ClaudeBackend extends Backend {
  constructor({ env = process.env, envFiles = [] } = {}) {
    super();
    this.env = loadEngineSettingsEnvironment(envFiles, env);
  }
  get id() { return 'claude'; }

  // One agent turn: claude -p "<prompt>" --output-format json [--model ...] plus the headless
  // execution flags (v1.1.0, see buildClaudeArgs).
  async runTurn({ prompt, cwd = process.cwd(), model, effort, permissionMode, strictMcp, maxBudgetUsd,
    env = this.env, timeoutMs, idleTimeoutMs, promptViaStdin = true } = {}) {
    if (!prompt) return { ok: false, output: '', error: 'empty prompt' };
    const settings = resolveEngineSettings(this.id, { model, effort, permissionMode, strictMcp, timeoutMs, idleTimeoutMs }, env);
    const args = buildClaudeArgs({ prompt, ...settings, maxBudgetUsd, promptViaStdin }, env);
    args.push(...claudeProjectArgs(cwd,env));
    const res = await runCliAsync('claude', args,
      { cwd, env, timeoutMs: settings.timeoutMs, idleTimeoutMs: settings.idleTimeoutMs,
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        ...(promptViaStdin ? { input: prompt } : {}) });
    if (res?.cleanupRefused) return { ok: false, output: res.stdout || '', cleanupRefused: true,
      error: `Child cleanup refused: ${res.stderr || 'process ownership could not be proved'}` };
    if (!res || res.status !== 0) {
      return { ok: false, output: res?.stdout || '', error: res?.stderr || `claude exited ${res?.status}` };
    }
    // claude --output-format json prints JSON with result/session_id/total_cost_usd fields.
    return { ok: true, ...parseClaudeJson(res.stdout) };
  }

  async registerMcp(manifest, env = process.env, options = {}) {
    return registerClaudeMcp(manifest, env, options);
  }

  // Agent instructions for Claude → CLAUDE.md in the target project root.
  async installInstructions({ targetDir, content }) {
    return publishProjectInstructions({ targetDir, filename: 'CLAUDE.md', content });
  }

  // Claude permissions → a deep merge of allow/deny into the target project's .claude/settings.json.
  async applyPermissions({ policy, targetDir = process.cwd() }) {
    const dir = join(targetDir, '.claude');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, 'settings.json');
    const cur = readJsonConfig(file);
    cur.permissions = cur.permissions || {};
    // Remove only the known former framework rules, preserving other explicit project denials.
    cur.permissions.deny = (cur.permissions.deny || []).filter(rule => !LEGACY_FRAMEWORK_DENY.includes(rule));
    if (policy.allow) cur.permissions.allow = Array.from(new Set([...(cur.permissions.allow || []), ...policy.allow]));
    if (policy.deny) cur.permissions.deny = Array.from(new Set([...(cur.permissions.deny || []), ...policy.deny]));
    writeJsonConfig(file, cur);
    return { applied: true };
  }

  async ensureReady({ cwd = process.cwd() } = {}) {
    const project=loadProjectConfig({projectDir:cwd});
    if(project.installed&&project.config.instructions.claude_settings==='.0-code/claude/settings.json')return {restored:[]};
    const file = join(cwd, '.claude', 'settings.json');
    if (!existsSync(file)) return { restored: [] };
    const config = readJsonConfig(file);
    const deny = config.permissions?.deny;
    if (!Array.isArray(deny) || !deny.some(rule => LEGACY_FRAMEWORK_DENY.includes(rule))) return { restored: [] };
    config.permissions.deny = deny.filter(rule => !LEGACY_FRAMEWORK_DENY.includes(rule));
    writeJsonConfig(file, config);
    return { restored: [file] };
  }

  // Destructive pre-check — shared by all backends (core/safety.mjs).
  guardCommand(command) { return guardReason(command, this.env); }
}

// Assembling `claude -p ...` arguments (pure, for tests and SRP).
//
// v1.1.0 — THE ROOT FIX FOR HEADLESS EXECUTION (see the research report in the development
// repository): in headless mode there is nobody to ask, and every tool that is not explicitly
// permitted is SILENTLY refused ("requested permissions … but you haven't granted it yet") — the
// turn degenerates into "a plan with no work". Hence:
//   --permission-mode bypassPermissions  (default; destructive commands are held back by the
//                                         PreToolUse safety-guard plus the settings deny list,
//                                         which apply in ANY mode);
//     override order: opts.permissionMode > env.CLAUDE_HEADLESS_PERMISSION_MODE > default;
//     the value 'none' means "do not pass the flag" (old behaviour, for debugging);
//   --strict-mcp-config                  only when explicitly selected (CLAUDE_STRICT_MCP=1);
//   --max-budget-usd <cap>               (per-turn spending guard, when provided);
//   --continue                           NEVER (it glues the turn onto a poisoned session).
// v1.2.0 — the prompt goes to standard input rather than into the arguments: the Windows command
// line is cut off somewhere between 8000 and 8100 characters (experiment L1), while framework
// prompts are tens of kilobytes. Verified live: `claude -p` without a positional argument reads
// the prompt from standard input. The previous way is still available via promptViaStdin:false
// (debugging, compatibility).
export function buildClaudeArgs({ prompt, model, effort, permissionMode, strictMcp, maxBudgetUsd,
  promptViaStdin = true } = {}, env = process.env) {
  const args = ['-p'];
  if (!promptViaStdin) args.push(prompt);
  args.push('--output-format', 'json');
  const settings = resolveEngineSettings('claude', { model, effort, permissionMode, strictMcp }, env);
  if (settings.model) args.push('--model', settings.model);
  if (settings.effort) args.push('--effort', settings.effort);
  const mode = settings.permissionMode;
  if (mode && mode !== 'none') args.push('--permission-mode', mode);
  if (settings.strictMcp) args.push('--strict-mcp-config');
  if (maxBudgetUsd) args.push('--max-budget-usd', String(maxBudgetUsd));
  return args;
}

// Parsing the stdout of `claude --output-format json` → {output, sessionId, costUsd, raw}. A pure
// function (extracted from runTurn for testability, v0.9.0). Not JSON → output is the raw stdout.
export function parseClaudeJson(stdout) {
  let raw = null, output = stdout, sessionId, costUsd;
  try {
    raw = JSON.parse(stdout);
    output = raw.result ?? stdout;
    sessionId = raw.session_id;
    costUsd = raw.total_cost_usd;
  } catch { /* not JSON — return as is */ }
  return { output, sessionId, costUsd, raw };
}

export { substituteEnv } from './mcp-input.mjs';

export default ClaudeBackend;
