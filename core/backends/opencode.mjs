// core/backends/opencode.mjs — the OpenCode backend adapter (OpenRouter models, Kimi included).
//
// v1.3.0. The second execution engine, plugged into the same core/backends/Backend.mjs port as
// Claude Code (Liskov: it substitutes for the base class). The loop driver is the external
// core/supervisor.mjs, because OpenCode has no Stop hook.
//
// The behavioural facts below were verified EMPIRICALLY against opencode 1.18.16, not taken from
// documentation:
//
//   1. `opencode run` READS standard input and HANGS FOREVER if the stream stays open. First
//      experiment: 300 seconds, zero bytes of output, zero diagnostics. That is exactly how the
//      supervisor launches child processes — so the prompt MUST travel through standard input
//      (which then closes by itself), and the turn gets a timeout.
//   2. Passing the prompt via standard input works — no file-based workaround is needed and the
//      Windows command-line limit (~8100 characters) is avoided outright.
//   3. The `--format json` event stream is line-delimited JSON {type, timestamp, sessionID, part}:
//      text (part.text — the result), step_finish (part.cost, part.tokens), tool_use/tool, file,
//      error (error.name, error.data.message).
//   4. Authentication uses the OPENROUTER_API_KEY environment variable; the key never appears in
//      the command line arguments.
//   5. Protection works: the `tool.execute.before` plugin genuinely prevents a command from
//      running.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Backend } from './Backend.mjs';
import { destructiveReason } from '../safety.mjs';
import { buildPermissionsBlock } from '../permissions-policy.mjs';
import { runCli, runCliAsync } from './spawn-cli.mjs';

export const OPENCODE_PROVIDER = 'openrouter';
export const OPENCODE_CONFIG_FILE = 'opencode.json';
export const OPENCODE_PLUGIN_FILE = join('.opencode', 'plugins', 'safety-guard.js');

// Per-turn limits. They are not "just in case": a silent hang is a proven failure mode of this
// engine, and the supervisor must receive diagnostics rather than silence.
//
// v1.5.0, lesson from the final gate: a 15-minute total cap killed HONEST work — on a real task
// the agent had already produced two commits but did not fit the window, and the whole turn was
// discarded. A hung process differs from a working one not by duration but by SILENCE. So the
// primary limit is on silence, and the total cap remains only as a far backstop.
export const OPENCODE_IDLE_TIMEOUT_MS = 10 * 60 * 1000;     // no output for 10 minutes → hung
export const OPENCODE_TURN_TIMEOUT_MS = 4 * 60 * 60 * 1000; // backstop: 4 hours per turn

// Path to the shared rule detector — the arbiter plugin is generated from it.
export const SAFETY_MODULE_PATH = fileURLToPath(new URL('../safety.mjs', import.meta.url));

// The GLOBAL OpenCode plugin directory — OUTSIDE the agent's working directory (v1.4.0).
//
// WHY: an audit showed that the agent deletes a plugin living inside the project — with an
// ordinary cleanup or a direct `rm` — and rewrites the configuration to "allow everything".
// Protection that lives in a directory the agent controls is not protection. The global plugin
// fires even when the project contains neither plugin nor configuration (verified live), and the
// agent cannot reach it.
export function globalPluginDir(home = homedir()) {
  return join(home, '.config', 'opencode', 'plugins');
}

export class OpenCodeBackend extends Backend {
  get id() { return 'opencode'; }

  // One agent turn. The prompt goes ONLY through standard input (see point 1 in the header).
  async runTurn({ prompt, cwd = process.cwd(), model, sessionId, autoApprove = true,
    env = process.env, timeoutMs = OPENCODE_TURN_TIMEOUT_MS,
    idleTimeoutMs = OPENCODE_IDLE_TIMEOUT_MS, maxBudgetUsd } = {}) {
    if (!prompt) return { ok: false, output: '', error: 'empty prompt' };

    // Spending guard INSIDE the turn (v1.5.0). Cost used to be counted only on completion, so on
    // half-hour turns the cap was powerless: an overrun was discovered after the fact. Now step
    // costs are read from the event stream on the fly, and the turn aborts once the remaining
    // allowance is exceeded.
    const watcher = makeBudgetWatcher(maxBudgetUsd);
    const args = buildOpenCodeArgs({ model, sessionId, autoApprove });
    const res = await runCliAsync('opencode', args, {
      cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
      input: prompt,              // closes standard input → the process does not hang
      timeoutMs, idleTimeoutMs,
      onChunk: watcher.onChunk,
    });
    if (res && res.aborted) {
      const parsed = parseOpenCodeEvents(res.stdout || '');
      return {
        ...parsed, ok: false,
        error: `turn aborted by the spending guard: spent $${watcher.spent().toFixed(4)}`
          + ` against a remaining allowance of $${Number(maxBudgetUsd).toFixed(2)}`,
        budgetExceeded: true,
      };
    }
    if (res && res.timedOut) {
      return {
        ok: false, output: res.stdout || '',
        error: `turn aborted: the engine was silent for more than ${Math.round(idleTimeoutMs / 60000)} min`
          + ` (overall backstop — ${Math.round(timeoutMs / 3600000)} h)`,
      };
    }
    const parsed = parseOpenCodeEvents(res?.stdout || '');
    if (!res || res.status !== 0) {
      return { ...parsed, ok: false, error: parsed.error || res?.stderr || `opencode exited ${res?.status}` };
    }
    return parsed;
  }

  // MCP: servers from the secret-free manifest → the `mcp` block in opencode.json (idempotent merge).
  async registerMcp(manifest, env = process.env, { targetDir = process.cwd() } = {}) {
    const gen = generateOpenCodeMcp(manifest, env);
    const cfg = readConfig(targetDir);
    cfg.mcp = { ...(cfg.mcp || {}), ...gen.mcp };
    writeConfig(targetDir, cfg);
    return { registered: Object.keys(gen.mcp), skipped: gen.skipped };
  }

  // Agent instructions → AGENTS.md (OpenCode reads it first; the text comes from a single source).
  async installInstructions({ targetDir, content }) {
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    const dest = join(targetDir, 'AGENTS.md');
    writeFileSync(dest, content, 'utf8');
    return { written: [dest] };
  }

  // Permissions → the `permission` block in opencode.json. The mechanism genuinely WORKS here
  // (verified by experiment), so `applied: true` is the truth rather than a comfortable fiction.
  async applyPermissions({ policy, targetDir = process.cwd() } = {}) {
    const { permission, dropped } = toOpenCodePermissions(policy);
    const cfg = readConfig(targetDir);
    cfg.permission = { ...(cfg.permission || {}), ...permission };
    writeConfig(targetDir, cfg);
    return {
      applied: true,
      enforced: true,
      file: join(targetDir, OPENCODE_CONFIG_FILE),
      dropped,
      note: 'mechanism verified by live experiment: a forbidden command does not execute',
    };
  }

  // Restoring the scaffolding before a turn (v1.3.0). Found by live acceptance: the agent ran
  // `git clean -fd .` — an ordinary cleanup — and wiped the untracked opencode.json and the
  // arbiter plugin, i.e. it DISARMED ITSELF and carried on working. No agent should be able to do
  // that silently, so the scaffolding is restored before every turn.
  async ensureReady({ cwd = process.cwd(), policy, safetyPath = SAFETY_MODULE_PATH,
    home = homedir() } = {}) {
    const restored = [];
    const script = buildOpenCodePluginScript(safetyPath);

    // 1. THE MAIN line of defence — the global plugin outside the agent's working directory.
    const globalPlugin = join(globalPluginDir(home), 'safety-guard.js');
    if (!existsSync(globalPlugin)) {
      mkdirSync(dirname(globalPlugin), { recursive: true });
      writeFileSync(globalPlugin, script, 'utf8');
      restored.push(globalPlugin);
    }

    // 2. A copy inside the project — for visibility; the agent can delete it, which is exactly why
    //    it is not the only one.
    const plugin = join(cwd, OPENCODE_PLUGIN_FILE);
    if (!existsSync(plugin)) {
      mkdirSync(dirname(plugin), { recursive: true });
      writeFileSync(plugin, script, 'utf8');
      restored.push(OPENCODE_PLUGIN_FILE);
    }

    // 3. Permissions are checked BY CONTENT, not by the presence of the block: the audit caught the
    //    agent leaving `permission.bash` in place while rewriting every value to "allow".
    const required = toOpenCodePermissions(policy || buildPermissionsBlock()).permission.bash;
    const current = (readConfig(cwd).permission || {}).bash || {};
    const lost = Object.entries(required)
      .filter(([pattern, decision]) => decision === 'deny' && current[pattern] !== 'deny');
    if (lost.length) {
      await this.applyPermissions({ policy: policy || buildPermissionsBlock(), targetDir: cwd });
      restored.push(`${OPENCODE_CONFIG_FILE} (denials restored: ${lost.length})`);
    }
    return { restored };
  }

  // Destructive pre-check for the supervisor's own commands — the shared core/safety.mjs.
  guardCommand(command) { return destructiveReason(command); }
}

// --- Pure helpers (exported for tests) ---

/**
 * A spending watcher that works AS THE TURN RUNS. It reads `step_finish` events straight from the
 * stream and asks for the turn to be aborted once more than the allowance has been spent. With no
 * limit set it neither interferes nor counts anything.
 *
 * HONEST ABOUT PRECISION (measured live): the cost only becomes known when a STEP completes, so
 * the guard fires at a step boundary rather than to the cent. In an experiment with a $0.002 limit
 * the turn aborted at $0.03 — meaning the mechanism prevents a RUNAWAY, but does not guarantee an
 * exact figure. For unattended operation the former is what matters.
 */
export function makeBudgetWatcher(maxBudgetUsd) {
  let spent = 0;
  let tail = '';
  const limit = Number(maxBudgetUsd);
  const active = Number.isFinite(limit) && limit > 0;
  return {
    spent: () => spent,
    onChunk(chunk) {
      if (!active) return undefined;
      tail += String(chunk);
      const lines = tail.split('\n');
      tail = lines.pop() || '';        // the last line may be incomplete
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'step_finish' && typeof ev.part?.cost === 'number') spent += ev.part.cost;
        } catch { /* not JSON — none of our business */ }
      }
      return spent >= limit ? 'abort' : undefined;
    },
  };
}

// Building the arguments. The prompt DOES NOT GO HERE — it travels through standard input.
export function buildOpenCodeArgs({ model, sessionId, autoApprove = true } = {}) {
  const args = ['run', '--format', 'json'];
  if (autoApprove) args.push('--auto');
  if (model) args.push('-m', model.includes('/') && model.startsWith(`${OPENCODE_PROVIDER}/`)
    ? model : `${OPENCODE_PROVIDER}/${model}`);
  if (sessionId) args.push('--session', sessionId);
  return args;
}

// Parsing the line-delimited event stream. The format was verified against real opencode 1.18.16 output.
export function parseOpenCodeEvents(text) {
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let output = '', costUsd = 0, sessionId, finishReason, error;
  let inputTokens = 0, outputTokens = 0, steps = 0, toolCalls = 0;
  const raw = [];
  for (const ln of lines) {
    let ev; try { ev = JSON.parse(ln); } catch { continue; }
    raw.push(ev);
    if (!sessionId && ev.sessionID) sessionId = ev.sessionID;
    const part = ev.part || {};
    switch (ev.type) {
      case 'text':
        if (typeof part.text === 'string') output += part.text;
        break;
      case 'step_finish':
        steps++;
        if (typeof part.cost === 'number') costUsd += part.cost;
        if (part.tokens) {
          inputTokens += part.tokens.input || 0;
          outputTokens += part.tokens.output || 0;
        }
        if (part.reason) finishReason = part.reason;
        break;
      case 'tool_use':
        toolCalls++;
        break;
      case 'error': {
        const name = ev.error?.name || 'error';
        const msg = ev.error?.data?.message || ev.error?.message || '';
        error = `${name}: ${msg}`.trim();
        break;
      }
      default:
        break;
    }
  }
  return {
    ok: !error, output, costUsd, sessionId, finishReason, steps, toolCalls,
    tokens: { input: inputTokens, output: outputTokens },
    ...(error ? { error } : {}),
    raw,
  };
}

// Translating our policy (Claude Code globs) into OpenCode syntax.
//
// IMPORTANT: in OpenCode the LAST matching rule wins, so the permissive `*` comes first and the
// denials follow it. Anything that could not be translated is returned in `dropped` — silently
// losing a denial is more dangerous than an explicit error, because it looks like success.
export function toOpenCodePermissions(policy = {}) {
  const dropped = [];
  const bash = { '*': 'allow' };   // order matters: the permissive rule goes first
  for (const rule of policy.deny || []) {
    const m = String(rule).match(/^Bash\((.+)\)$/);
    if (!m) { dropped.push(rule); continue; }
    let pattern = m[1].trim();
    // In our globs `rm -rf /` means "exactly this target"; OpenCode matches by prefix — we append
    // `*` so that both `rm -rf /` and `rm -rf /home` are covered.
    if (!pattern.endsWith('*')) pattern += '*';
    bash[pattern] = 'deny';
  }
  const permission = {
    bash,
    edit: 'allow', read: 'allow', glob: 'allow', grep: 'allow',
    webfetch: 'allow', websearch: 'allow', task: 'allow', todowrite: 'allow',
  };
  return { permission, dropped };
}

// Generating the arbiter plugin. The rules come from THE SAME core/safety.mjs that backs the
// Claude Code hook (DRY: one source for every engine). The OpenCode contract was verified by
// experiment: a named export of an async function → a hooks object; the command sits in
// output.args.command; throwing blocks execution.
export function buildOpenCodePluginScript(safetyAbsPath) {
  const url = pathToFileURL(safetyAbsPath).href;
  return `// safety-guard — GENERATED by the 0-CODE framework from core/safety.mjs. Do not edit by hand.
// Blocks irreversible operations: destroying the filesystem, formatting disks, mass-killing the
// agent's processes, and force-rewriting shared history.
import { destructiveReason } from ${JSON.stringify(url)};

export const SafetyGuard = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      const command = (output && output.args && (output.args.command || output.args.cmd)) || "";
      if (!command) return;
      const reason = destructiveReason(String(command));
      if (reason) {
        throw new Error("safety-guard blocked an irreversible operation: " + reason +
          ". If this was intentional, run it manually outside the autonomous loop.");
      }
    },
  };
};
`;
}

// Generating the MCP block from the secret-free manifest (skipping non-portable servers and
// connectors that need interactive setup).
export function generateOpenCodeMcp(manifest, env = process.env) {
  const servers = (manifest && Array.isArray(manifest.servers)) ? manifest.servers : [];
  const mcp = {}; const skipped = [];
  for (const s of servers) {
    if (s.source === 'claude_ai' || s.needs_setup || s.portable === false) { skipped.push(s.name); continue; }
    mcp[s.name] = {
      type: 'local',
      command: [substituteEnv(s.command || '', env), ...(s.args || []).map(a => substituteEnv(String(a), env))],
      environment: Object.fromEntries(
        Object.entries(s.env || {}).map(([k, v]) => [k, substituteEnv(String(v), env)])),
      enabled: true,
    };
  }
  return { mcp, skipped };
}

// --- Internals ---

function readConfig(targetDir) {
  const file = join(targetDir, OPENCODE_CONFIG_FILE);
  if (!existsSync(file)) return { $schema: 'https://opencode.ai/config.json' };
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return { $schema: 'https://opencode.ai/config.json' }; }
}

function writeConfig(targetDir, cfg) {
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, OPENCODE_CONFIG_FILE), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

function substituteEnv(str, env) {
  return String(str).replace(/\$\{([A-Za-z_][\w]*)(?::-([^}]*))?\}/g, (_, name, def) =>
    (env[name] !== undefined && env[name] !== '') ? env[name] : (def ?? ''));
}

export default OpenCodeBackend;
