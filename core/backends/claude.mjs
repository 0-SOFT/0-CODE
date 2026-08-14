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
import { destructiveReason } from '../safety.mjs';
import { runCli, runCliAsync } from './spawn-cli.mjs';

export class ClaudeBackend extends Backend {
  get id() { return 'claude'; }

  // One agent turn: claude -p "<prompt>" --output-format json [--model ...] plus the headless
  // execution flags (v1.1.0, see buildClaudeArgs).
  async runTurn({ prompt, cwd = process.cwd(), model, permissionMode, strictMcp, maxBudgetUsd,
    promptViaStdin = true } = {}) {
    if (!prompt) return { ok: false, output: '', error: 'empty prompt' };
    const args = buildClaudeArgs({ prompt, model, permissionMode, strictMcp, maxBudgetUsd, promptViaStdin });
    const res = await runCliAsync('claude', args,
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        ...(promptViaStdin ? { input: prompt } : {}) });
    if (!res || res.status !== 0) {
      return { ok: false, output: res?.stdout || '', error: res?.stderr || `claude exited ${res?.status}` };
    }
    // claude --output-format json prints JSON with result/session_id/total_cost_usd fields.
    return { ok: true, ...parseClaudeJson(res.stdout) };
  }

  // Registering portable MCP servers from the manifest: claude mcp add-json <name> '<json>' -s user.
  async registerMcp(manifest, env = process.env) {
    const registered = [], skipped = [];
    const servers = (manifest && Array.isArray(manifest.servers)) ? manifest.servers : [];
    for (const s of servers) {
      if (s.portable === false || s.source === 'claude_ai' || s.needs_setup) { skipped.push(s.name); continue; }
      const payload = substituteEnv(JSON.stringify({ command: s.command, args: s.args || [], env: s.env || {} }), env);
      const res = runCli('claude', ['mcp', 'add-json', s.name, payload, '-s', 'user'],
        { encoding: 'utf8' });
      if (res && res.status === 0) registered.push(s.name); else skipped.push(s.name);
    }
    return { registered, skipped };
  }

  // Agent instructions for Claude → CLAUDE.md in the target project root.
  async installInstructions({ targetDir, content }) {
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    const dest = join(targetDir, 'CLAUDE.md');
    writeFileSync(dest, content, 'utf8');
    return { written: [dest] };
  }

  // Claude permissions → a deep merge of allow/deny into the target project's .claude/settings.json.
  async applyPermissions({ policy, targetDir = process.cwd() }) {
    const dir = join(targetDir, '.claude');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, 'settings.json');
    let cur = {};
    if (existsSync(file)) { try { cur = JSON.parse(readFileSync(file, 'utf8')); } catch { cur = {}; } }
    cur.permissions = cur.permissions || {};
    if (policy.allow) cur.permissions.allow = Array.from(new Set([...(cur.permissions.allow || []), ...policy.allow]));
    if (policy.deny) cur.permissions.deny = Array.from(new Set([...(cur.permissions.deny || []), ...policy.deny]));
    writeFileSync(file, JSON.stringify(cur, null, 2), 'utf8');
    return { applied: true };
  }

  // Destructive pre-check — shared by all backends (core/safety.mjs).
  guardCommand(command) { return destructiveReason(command); }
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
//   --strict-mcp-config                  (default; project MCP servers hang on npx startup and the
//                                         loop does not need them; disable with strictMcp:false);
//   --max-budget-usd <cap>               (per-turn spending guard, when provided);
//   --continue                           NEVER (it glues the turn onto a poisoned session).
// v1.2.0 — the prompt goes to standard input rather than into the arguments: the Windows command
// line is cut off somewhere between 8000 and 8100 characters (experiment L1), while framework
// prompts are tens of kilobytes. Verified live: `claude -p` without a positional argument reads
// the prompt from standard input. The previous way is still available via promptViaStdin:false
// (debugging, compatibility).
export function buildClaudeArgs({ prompt, model, permissionMode, strictMcp, maxBudgetUsd,
  promptViaStdin = true } = {}, env = process.env) {
  const args = ['-p'];
  if (!promptViaStdin) args.push(prompt);
  args.push('--output-format', 'json');
  if (model) args.push('--model', model);
  const mode = permissionMode ?? env.CLAUDE_HEADLESS_PERMISSION_MODE ?? 'bypassPermissions';
  if (mode && mode !== 'none') args.push('--permission-mode', mode);
  if (strictMcp !== false) args.push('--strict-mcp-config');
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

// Substituting ${VAR} and ${VAR:-default} from env (for the secret-free manifest).
export function substituteEnv(str, env) {
  return str.replace(/\$\{([A-Za-z_][\w]*)(?::-([^}]*))?\}/g, (_, name, def) =>
    (env[name] !== undefined && env[name] !== '') ? env[name] : (def ?? ''));
}

export default ClaudeBackend;
