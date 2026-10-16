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

import { readFileSync, writeFileSync, existsSync, mkdirSync, lstatSync, unlinkSync } from 'node:fs';
import { join, dirname, relative, resolve, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Backend } from './Backend.mjs';
import { guardReason } from '../permission-decision.mjs';
import { buildPermissionsBlock, LEGACY_FRAMEWORK_DENY } from '../permissions-policy.mjs';
import { runCli, runCliAsync } from './spawn-cli.mjs';
import { generateMcpInputs } from './mcp-input.mjs';
import { readJsonConfig, writeJsonConfig } from '../../lib/json-config.mjs';
import { replaceFileSync } from '../../lib/replace-file.mjs';
import { resolveEngineSettings, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS } from '../engine-settings.mjs';
import { loadEngineSettingsEnvironment } from '../../lib/codex-env.mjs';
import { publishProjectInstructions } from '../../lib/project-instructions.mjs';
import { loadProjectConfig } from '../project-config.mjs';
import { readInstallationReceipt } from '../project-installation.mjs';
import { InstallationPlan, applyInstallationPlan, fileSnapshot, hashBytes } from '../installation-transaction.mjs';
import { parseJsonc } from '../../lib/jsonc.mjs';
import { PROJECT_PLUGIN_PATH, PROJECT_PLUGIN_ENTRY } from './project-opencode-plugin.mjs';

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
export const OPENCODE_IDLE_TIMEOUT_MS = DEFAULT_IDLE_TIMEOUT_MS;
export const OPENCODE_TURN_TIMEOUT_MS = DEFAULT_TURN_TIMEOUT_MS;

// Path to the shared rule detector — the arbiter plugin is generated from it.
export const SAFETY_MODULE_PATH = fileURLToPath(new URL('../safety.mjs', import.meta.url));
const DECISION_MODULE_PATH = new URL('../permission-decision.mjs', import.meta.url);

// The GLOBAL OpenCode plugin directory — OUTSIDE the agent's working directory (v1.4.0).
//
// WHY: an audit showed that the agent deletes a plugin living inside the project — with an
// ordinary cleanup or a direct `rm` — and rewrites the configuration to "allow everything".
// The global plugin fires even when the project contains neither plugin nor configuration
// (verified live). Its location survives project cleanup; the host restores trusted bytes before
// each turn. Location alone does not restrict an agent running with full OS permissions.
export function globalPluginDir(home = homedir()) {
  return join(home, '.config', 'opencode', 'plugins');
}

export class OpenCodeBackend extends Backend {
  #safetyPath;
  #safety;
  #decision;
  #hostGuard;

  constructor({ safetyPath = SAFETY_MODULE_PATH, env = process.env, envFiles = [] } = {}) {
    super();
    // Capture before a turn; restoring trusted bytes is separate from discovering native files.
    // Installed projects keep the snapshot in ignored runtime, legacy callers in their guard home.
    this.#safetyPath = resolve(safetyPath);
    this.#safety = readFileSync(this.#safetyPath);
    this.#decision = readFileSync(DECISION_MODULE_PATH);
    this.env = loadEngineSettingsEnvironment(envFiles, env);
  }

  get id() { return 'opencode'; }

  // One agent turn. The prompt goes ONLY through standard input (see point 1 in the header).
  async runTurn({ prompt, cwd = process.cwd(), model, effort, sessionId, autoApprove = true,
    env = this.env, timeoutMs, idleTimeoutMs, maxBudgetUsd } = {}) {
    if (!prompt) return { ok: false, output: '', error: 'empty prompt' };
    if(this.#hostGuard) {
      const tail=relative(this.#hostGuard.root,resolve(cwd));
      if(!isAbsolute(tail)&&tail!=='..'&&!tail.startsWith('..'+sep)) {
        guardDirectory(cwd,this.#hostGuard.root);
        env=openCodeHostGuardEnvironment({...this.#hostGuard.environment,...env},this.#hostGuard.plugin,this.#hostGuard.denials);
      }
    }

    // Spending guard INSIDE the turn (v1.5.0). Cost used to be counted only on completion, so on
    // half-hour turns the cap was powerless: an overrun was discovered after the fact. Now step
    // costs are read from the event stream on the fly, and the turn aborts once the remaining
    // allowance is exceeded.
    const watcher = makeBudgetWatcher(maxBudgetUsd);
    const settings = resolveEngineSettings(this.id, { model, effort, timeoutMs, idleTimeoutMs }, env);
    const args = buildOpenCodeArgs({ ...settings, sessionId, autoApprove }, env);
    const res = await runCliAsync('opencode', args, {
      cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
      input: prompt,              // closes standard input → the process does not hang
      timeoutMs: settings.timeoutMs, idleTimeoutMs: settings.idleTimeoutMs,
      onChunk: watcher.onChunk,
    });
    if (res?.cleanupRefused) return { ok: false, output: res.stdout || '', cleanupRefused: true,
      error: `Child cleanup refused: ${res.stderr || 'process ownership could not be proved'}` };
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
    if (cfg.mcp !== undefined && (!cfg.mcp || typeof cfg.mcp !== 'object' || Array.isArray(cfg.mcp))) throw new Error('Project MCP block must be an object');
    const merged = { ...cfg.mcp }, registered = [], preserved = [];
    for (const [name, server] of Object.entries(gen.mcp)) {
      if (Object.hasOwn(merged, name)) { preserved.push(name); gen.reasons[name] = 'Project MCP definition takes precedence'; }
      else { merged[name] = server; registered.push(name); }
    }
    // Absence of a secret proves no ownership of an existing entry. Never delete it.
    if (registered.length) { cfg.mcp = merged; writeConfig(targetDir, cfg); }
    return { registered, preserved, skipped: [...new Set([...gen.skipped, ...preserved])], reasons: gen.reasons };
  }

  // Agent instructions → AGENTS.md (OpenCode reads it first; the text comes from a single source).
  async installInstructions({ targetDir, content }) {
    return publishProjectInstructions({ targetDir, filename: 'AGENTS.md', content });
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
  async ensureReady({ cwd = process.cwd(), policy, safetyPath = this.#safetyPath,
    home = homedir() } = {}) {
    if (resolve(safetyPath) !== this.#safetyPath) {
      throw new Error('OpenCode safety source cannot change after the host snapshot was captured');
    }
    const project=loadProjectConfig({projectDir:cwd,env:this.env});
    if(project.installed) {
      const receipt=readInstallationReceipt(project.projectDir);
      if(!receipt) throw new Error('OpenCode project has no ownership receipt');
      for(const [path,bytes] of [['.0-code/core/safety.mjs',this.#safety],['.0-code/core/permission-decision.mjs',this.#decision]]) {
        if(receipt.files.find(entry=>entry.path===path)?.hash!==hashBytes(bytes)) throw new Error('OpenCode host snapshot differs from the installed kernel; upgrade first');
      }
      const pointer=PROJECT_PLUGIN_PATH,pointerBytes=Buffer.from(PROJECT_PLUGIN_ENTRY);
      if(receipt.files.find(entry=>entry.path===pointer)?.hash!==hashBytes(pointerBytes)) throw new Error('OpenCode native plugin ownership cannot be verified');
      const directory=project.runtimePath('opencode-guard'),safetyFile=join(directory,'safety.mjs'),decisionFile=join(directory,'permission-decision.mjs');
      const plugin=join(directory,'plugin.mjs');
      const artifacts=new Map([[safetyFile,this.#safety],[decisionFile,this.#decision],[plugin,Buffer.from(buildOpenCodePluginScript(decisionFile))]]);
      const group=prepareGuardArtifacts(project.projectDir,artifacts,join(directory,'ownership.json'));
      const plan=new InstallationPlan(project.projectDir);
      for(const entry of group.entries) plan.change(entry.path,entry.expected,{overwrite:true});
      plan.change(pointer,pointerBytes,{overwrite:true});
      plan.assertReady();
      const translated=toOpenCodePermissions(policy||{});
      if(translated.dropped.length) throw new Error('OpenCode cannot preserve all explicit permission rules');
      const denials=Object.fromEntries(Object.entries(translated.permission.bash).filter(([,value])=>value==='deny'));
      // Validate the owner's inline configuration before writing a runtime byte.
      openCodeHostGuardEnvironment(this.env,plugin,denials);
      const result=applyInstallationPlan(plan);
      this.#hostGuard={root:project.projectDir,plugin,denials,environment:project.guardEnvironment};
      return {restored:result.changed?plan.summary().map(entry=>entry.path):[],safetyFile,decisionFile,hostPlugin:plugin};
    }
    this.#hostGuard=undefined;
    const restored = [];
    const safetyFile = join(home, '.config', 'opencode', '0-code-guard', 'safety.mjs');
    const decisionFile = join(dirname(safetyFile), 'permission-decision.mjs');
    const script = Buffer.from(buildOpenCodePluginScript(decisionFile));
    const globalPlugin = join(globalPluginDir(home), 'safety-guard.js');
    const plugin = join(cwd, OPENCODE_PLUGIN_FILE);
    const cfg = readConfig(cwd); // Invalid native config must fail before any guard file is written.
    const groups=[
      prepareGuardArtifacts(home,new Map([[safetyFile,this.#safety],[decisionFile,this.#decision],[globalPlugin,script]]),join(dirname(safetyFile),'ownership.json')),
      prepareGuardArtifacts(cwd,new Map([[plugin,script]]),join(cwd,'.opencode','0-code-guard-ownership.json')),
    ];
    for(const group of groups) for(const entry of group.entries) assertGuardSnapshot(entry);
    for(const group of groups) for(const entry of group.entries) restoreGuardFile(entry.file,entry.expected,group.root,restored,entry.path,entry.before);

    // 3. Permissions are checked BY CONTENT, not by the presence of the block: the audit caught the
    //    agent leaving `permission.bash` in place while rewriting every value to "allow".
    const current = (cfg.permission || {}).bash || {};
    let migrated = false;
    for (const rule of LEGACY_FRAMEWORK_DENY) {
      const original = /^Bash\((.+)\)$/.exec(rule)[1];
      for (const pattern of [original, original.endsWith('*') ? original : original + '*']) {
        if (current[pattern] === 'deny') { delete current[pattern]; migrated = true; }
      }
    }
    if (migrated) { writeConfig(cwd, cfg); restored.push(`${OPENCODE_CONFIG_FILE} (legacy framework denials removed)`); }
    const required = toOpenCodePermissions(policy || buildPermissionsBlock()).permission.bash;
    const lost = Object.entries(required)
      .filter(([pattern, decision]) => decision === 'deny' && current[pattern] !== 'deny');
    if (lost.length) {
      await this.applyPermissions({ policy: policy || buildPermissionsBlock(), targetDir: cwd });
      restored.push(`${OPENCODE_CONFIG_FILE} (denials restored: ${lost.length})`);
    }
    return { restored, safetyFile, decisionFile };
  }

  // Destructive pre-check for the supervisor's own commands — the shared core/safety.mjs.
  guardCommand(command) { return guardReason(command, this.env); }
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
export function buildOpenCodeArgs({ model, effort, sessionId, autoApprove = true } = {}, env = process.env) {
  const settings = resolveEngineSettings('opencode', { model, effort }, env);
  model = settings.model;
  const args = ['run', '--format', 'json'];
  if (autoApprove) args.push('--auto');
  if (model) args.push('-m', model.includes('/') && model.startsWith(`${OPENCODE_PROVIDER}/`)
    ? model : `${OPENCODE_PROVIDER}/${model}`);
  if (settings.effort) args.push('--variant', settings.effort);
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
    // Preserve an owner's exact rule; broadening '/' into '/*' forbids project subdirectories.
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
export function buildOpenCodePluginScript(decisionAbsPath) {
  const url = pathToFileURL(decisionAbsPath).href;
  return `// safety-guard — GENERATED from the shared permission decision. Do not edit by hand.
import { decidePermission, resolveMode } from ${JSON.stringify(url)};
import { guardAuditRecord } from ${JSON.stringify(url)};
import { appendFileSync } from "node:fs";

export const SafetyGuard = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      const command = (output && output.args && (output.args.command || output.args.cmd)) || "";
      if (!command) return;
      const report = resolveMode(process.env);
      if (!report.recognised) console.error("safety-guard: unknown mode; using " + report.mode);
      const event = {tool_name: input?.tool || "Bash", tool_input: {command: String(command)}};
      const result = decidePermission(event, report);
      const verdict = result?.hookSpecificOutput;
      try {
        const entry = guardAuditRecord(event, result, report);
        if (entry) appendFileSync(process.env.SAFETY_GUARD_LOG || ${JSON.stringify(join(dirname(decisionAbsPath), 'guard.log'))}, JSON.stringify(entry)+"\\n");
      } catch { /* an unavailable audit log does not change enforcement */ }
      if (verdict?.permissionDecision === "deny") throw new Error(verdict.permissionDecisionReason);
      if (verdict && (/ rule confirmed by the agent /.test(verdict.permissionDecisionReason) || report.mode === "allow-all")) {
        console.error(verdict.permissionDecisionReason);
      }
    },
  };
};
`;
}

// Generating the MCP block from the secret-free manifest (skipping non-portable servers and
// connectors that need interactive setup).
//
// v1.24.0 — the generator knows two transports. It used to write every server as `type: local`
// with `command: [s.command]`, so a remote server (a `url`, no command) became `command: [""]` and
// OpenCode refused it: "The argument 'file' cannot be empty" (measured with `opencode mcp list`).
// A remote server is `{ type: 'remote', url, headers }` — checked live against a local echo server.
// A server whose declared secret is absent is skipped WITH the reason, instead of being registered
// with an empty key to fail on start. See docs/decisions/1.24.0_opencode-mcp.md for why secrets are
// still written as values rather than `{env:VAR}` references.
export const REMOTE_TRANSPORTS = new Set(['http', 'sse', 'remote']);

export function generateOpenCodeMcp(manifest, env = process.env) {
  const generated = generateMcpInputs(manifest, env);
  const mcp = Object.fromEntries(Object.entries(generated.entries).map(([name, entry]) => [name,
    entry.type === 'stdio' ? { type: 'local', command: [entry.command, ...entry.args], environment: entry.env, enabled: true }
      : { type: 'remote', url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}), enabled: true }]));
  return { mcp, skipped: generated.skipped, reasons: generated.reasons };
}

function guardDirectory(directory, root) {
  const base = resolve(root), tail = relative(base, resolve(directory));
  if (isAbsolute(tail) || tail === '..' || tail.startsWith(`..${sep}`)) {
    throw new Error('OpenCode guard artifact escaped its root');
  }
  let current = base;
  for (const part of ['', ...tail.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`OpenCode guard directory must be an ordinary directory: ${current}`);
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

function ordinaryGuardFile(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`OpenCode guard must be a regular, unlinked file: ${file}`);
    }
    return true;
  } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

function assertGuardSnapshot(entry) {
  if(hashBytes(ordinaryGuardFile(entry.file)?readFileSync(entry.file):null)!==entry.before) throw new Error('OpenCode guard changed during preparation');
}
function prepareGuardArtifacts(root,artifacts,ownerFile) {
  root=resolve(root);const paths=[...artifacts.keys()].map(file=>relative(root,file).replaceAll('\\','/'));
  guardDirectory(dirname(ownerFile),root);
  let previous;
  const ownerBefore=ordinaryGuardFile(ownerFile)?readFileSync(ownerFile):null;
  if(ownerBefore) {
    try {previous=JSON.parse(ownerBefore.toString('utf8'));}
    catch {throw new Error('OpenCode guard ownership is not valid JSON');}
    if(previous?.schema_version!==1||!Array.isArray(previous.files)||previous.files.length>paths.length
      ||previous.files.some(entry=>!paths.includes(entry.path)||!/^[a-f0-9]{64}$/.test(entry.hash))
      ||new Set(previous.files.map(entry=>entry.path)).size!==previous.files.length) throw new Error('OpenCode guard ownership cannot be verified');
  }
  const entries=[];
  for(const [file,expected] of artifacts) {
    guardDirectory(dirname(file),root);
    const path=relative(root,file).replaceAll('\\','/'),bytes=ordinaryGuardFile(file)?readFileSync(file):null;
    const owned=previous?.files.some(entry=>entry.path===path);
    // Identical trusted framework bytes can be adopted without changing a byte; other files need a receipt.
    if(bytes&&!owned&&!bytes.equals(expected)) throw new Error('Unowned OpenCode guard artifact; original preserved: '+path);
    entries.push({path,file,expected,before:hashBytes(bytes)});
  }
  const owner=Buffer.from(JSON.stringify({schema_version:1,files:entries.map(entry=>({path:entry.path,hash:hashBytes(entry.expected)}))},null,2)+'\n');
  entries.push({path:relative(root,ownerFile).replaceAll('\\','/'),file:ownerFile,expected:owner,before:hashBytes(ownerBefore)});
  return {root,entries};
}
export function openCodeHostGuardEnvironment(env,plugin,denials={}) {
  let config;try {config=env.OPENCODE_CONFIG_CONTENT?parseJsonc(env.OPENCODE_CONFIG_CONTENT):{};}catch {throw new Error('OpenCode inline configuration is invalid; original preserved');}
  if(!config||typeof config!=='object'||Array.isArray(config)||(config.plugin!==undefined&&(!Array.isArray(config.plugin)||config.plugin.some(value=>typeof value!=='string'))))
    throw new Error('OpenCode inline plugin configuration is invalid; original preserved');
  const url=pathToFileURL(plugin).href,plugins=[...(config.plugin||[])];if(!plugins.includes(url)) plugins.push(url);
  const merged={...config,plugin:plugins};
  if(Object.keys(denials).length) {
    if(config.permission!==undefined&&(!config.permission||typeof config.permission!=='object'||Array.isArray(config.permission))) throw new Error('OpenCode inline permissions cannot be extended safely');
    const bash=config.permission?.bash;
    if(bash!==undefined&&(!bash||typeof bash!=='object'||Array.isArray(bash))) throw new Error('OpenCode inline Bash permissions cannot be extended safely');
    merged.permission={...config.permission,bash:{...bash,...denials}};
  }
  return {...env,OPENCODE_CONFIG_CONTENT:JSON.stringify(merged)};
}
function restoreGuardFile(file, expected, root, restored, label = file, expectedBefore) {
  const directory = dirname(file);
  guardDirectory(directory, root);
  if(expectedBefore!==undefined) assertGuardSnapshot({file,before:expectedBefore});
  if (ordinaryGuardFile(file) && readFileSync(file).equals(expected)) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  guardDirectory(directory, root);
  const temporary = join(directory, `.safety-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, expected, { flag: 'wx', mode: 0o600 });
    replaceFileSync(temporary, file, { validate: () => {
      guardDirectory(directory, root);
      ordinaryGuardFile(file);
      ordinaryGuardFile(temporary);
      if(expectedBefore!==undefined) assertGuardSnapshot({file,before:expectedBefore});
    } });
    if (!readFileSync(file).equals(expected)) throw new Error('OpenCode guard restoration failed verification');
    restored.push(label);
  } finally {
    guardDirectory(directory, root);
    if (ordinaryGuardFile(temporary)) unlinkSync(temporary);
  }
}

function readConfig(targetDir) {
  return readJsonConfig(join(targetDir, OPENCODE_CONFIG_FILE), { $schema: 'https://opencode.ai/config.json' });
}

function writeConfig(targetDir, cfg) {
  writeJsonConfig(join(targetDir, OPENCODE_CONFIG_FILE), cfg);
}

export default OpenCodeBackend;
