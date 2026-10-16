// Codex CLI adapter. Genuine recordings: 0.160.1, 0.161.0 and 0.162.0; totals belong to a THREAD.
// No price table: absence of USD is represented by absence of costUsd, never a fabricated zero.
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Backend } from './Backend.mjs';
import { guardReason } from '../permission-decision.mjs';
import { runCli, runCliAsync } from './spawn-cli.mjs';
import { CodexHome } from './codex-home.mjs';
import { validateCodexRuntimeOptions } from './codex-config.mjs';
import { resolveMode, ALLOW_ALL } from '../permission-decision.mjs';
import { cloudCodexMcpOverrides } from './codex-mcp.mjs';
import { inspectCodexInstructionConfig } from './codex-instruction-config.mjs';
import { loadCodexEnvironment, loadEngineSettingsEnvironment } from '../../lib/codex-env.mjs';
import { withoutOwnerTelegramEnvironment } from '../../lib/cloud-mcp-policy.mjs';
import { resolveEngineSettings, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS } from '../engine-settings.mjs';
import { publishProjectInstructions } from '../../lib/project-instructions.mjs';
import { loadProjectConfig } from '../project-config.mjs';

export const CODEX_VERSION = '0.162.0';
export const CODEX_IDLE_TIMEOUT_MS = DEFAULT_IDLE_TIMEOUT_MS;
export const CODEX_TURN_TIMEOUT_MS = DEFAULT_TURN_TIMEOUT_MS;
export const CODEX_INSTRUCTIONS_MAX_BYTES = 32768;

// Mirror agents_md.rs: nearest .git ancestor, one preferred file per directory,
// a shared raw-byte budget from root to cwd. Refuse only for an explicit limit.
export function validateCodexInstructions(cwd, { maxBytes, personalHome, fallbackFilenames = [], rootMarkers = ['.git'] } = {}) {
  const current = resolve(cwd), ancestors = [current];
  let cursor = current, rooted = false;
  for (;;) {
    if (rootMarkers.some(marker => existsSync(resolve(cursor, marker)))) { rooted = true; break; }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    ancestors.push(parent); cursor = parent;
  }
  const directories = rooted ? ancestors.reverse() : [current];
  const files = [], entries = [];
  let bytes = 0;
  for (const directory of directories) {
    for (const name of [...new Set(['AGENTS.override.md', 'AGENTS.md', ...fallbackFilenames, 'CLAUDE.md'])]) {
      const file = resolve(directory, name);
      let data;
      try {
        if (!statSync(file).isFile()) continue;
        data = readFileSync(file);
        bytes += data.length;
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        throw new Error('Could not read Codex project instructions', { cause: e });
      }
      files.push(file);
      if (data.toString('utf8').trim()) entries.push(`Source: ${file}\n\n${data.toString('utf8')}`);
      break;
    }
  }
  let personalBytes = 0;
  if (personalHome) for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
    const file = join(personalHome, name);
    try {
      if (!statSync(file).isFile()) continue;
      const data = readFileSync(file);
      if (!data.toString('utf8').trim()) continue;
      personalBytes = data.length; break;
    } catch (e) { if (e.code !== 'ENOENT') throw new Error('Could not read personal Codex instructions', { cause: e }); }
  }
  if (maxBytes !== undefined && bytes + personalBytes > maxBytes) {
    throw new Error(`Codex instructions exceed the configured limit of ${maxBytes} bytes`);
  }
  // Retained only for explicitly managed homes; personal instructions are loaded natively.
  // Keep this header nonempty: an empty home override falls through to AGENTS.md.
  const content = [`Project instructions for directory ${current}.`,
    ...entries].join('\n\n') + '\n';
  return { files, bytes, personalBytes, totalBytes: bytes + personalBytes, content };
}
const USAGE_KEYS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens'];

// Use the official npm entrypoint through Node on Windows. The shim would run via cmd.exe,
// which cannot safely carry compound TOML arguments. Keep child tracking in runCliAsync.
export function resolveCodexLaunch({ env = process.env, platform = process.platform,
  execPath = process.execPath, exists = existsSync } = {}) {
  if (platform !== 'win32') return { bin: 'codex', args: [] };
  const dirs = String(env.PATH || env.Path || '').split(';').filter(Boolean);
  for (const dir of dirs) {
    const native = join(dir, 'codex.exe');
    if (exists(native)) return { bin: native, args: [] };
    if (!exists(join(dir, 'codex.cmd'))) continue;
    const candidates = [join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
      join(dirname(dir), '@openai', 'codex', 'bin', 'codex.js')];
    for (const entry of candidates) if (exists(entry)) return { bin: execPath, args: [entry] };
  }
  throw new Error(`Codex command not found: install @openai/codex@${CODEX_VERSION} or put codex.exe on PATH`);
}

// stdin must be closed. No prompt in argv, --full-auto, --last or implicit thread selection.
export function buildCodexArgs({ model, sessionId, sandbox = 'danger-full-access',
  config = [], ignoreUserConfig = false, bypassHookTrust = false } = {}) {
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) {
    throw new Error(`Invalid Codex sandbox: ${sandbox}`);
  }
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.trim()
      || sessionId.startsWith('-'))) throw new Error('Invalid Codex sessionId');
  if (!Array.isArray(config) || config.some(c => typeof c !== 'string' || !c.includes('='))) {
    throw new Error('Codex config overrides must be key=value strings');
  }
  const args = ['exec'];
  if (sessionId) args.push('resume', sessionId);
  args.push('--json');
  // resume has no -s option; -c is accepted by both subcommands.
  args.push('-c', `sandbox_mode=${JSON.stringify(sandbox)}`);
  if (model) args.push('-m', model);
  if (ignoreUserConfig) args.push('--ignore-user-config');
  if (bypassHookTrust) args.push('--dangerously-bypass-hook-trust');
  for (const c of config) args.push('-c', c);
  args.push('-');
  return args;
}

export function decodeCodexError(value) {
  let current = value;
  let kind, retryAt;
  for (let depth = 0; depth < 6; depth++) {
    if (typeof current === 'string') {
      try { current = JSON.parse(current); continue; } catch { break; }
    }
    if (!current || typeof current !== 'object') break;
    const type = typeof current.type === 'string' ? current.type.trim() : '';
    if (type && type !== 'error') kind = type;
    retryAt = current.resets_at ?? current.reset_at ?? retryAt;
    if (current.error !== undefined) { current = current.error; continue; }
    if (current.message !== undefined) { current = current.message; continue; }
    break;
  }
  const message = typeof current === 'string' ? current : JSON.stringify(current) || 'Codex error';
  const emptyMessage = !message.trim();
  return { message: emptyMessage ? 'Codex error: decoded message is empty' : message,
    ...(emptyMessage ? { emptyMessage: true } : {}), ...(kind ? { kind } : {}),
    ...(retryAt !== undefined ? { retryAt } : {}) };
}

function validUsage(usage) {
  return usage && typeof usage === 'object' && USAGE_KEYS.every(k =>
    Number.isSafeInteger(usage[k]) && usage[k] >= 0);
}

// 'previous' is explicitly scoped to a thread. A missing resume baseline must never masquerade
// as this turn's usage: the caller can still use the text, but receives usageUnknown.
export function parseCodexEvents(text, { previous, expectedSessionId, exitCode } = {}) {
  const raw = [], problems = [], missing = [], warnings = [];
  let output = '', sessionId, usageTotal, lastCompletedUsage, started = false, completed = false, errorInfo;
  let reportedError;
  const stream = String(text || ''), lines = stream.split(/\r?\n/);
  const recordFailure = (value, type) => {
    errorInfo = decodeCodexError(value);
    // A known wire type still identifies the failure without explanatory text. An untyped,
    // empty decoded payload is a malformed error, even if the outer JSON string was nonempty.
    if (errorInfo.emptyMessage && !errorInfo.kind) problems.push(`${type} decoded error message is empty`);
  };
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch {
      if (index === lines.length - 1 && !stream.endsWith('\n')) missing.push('last JSONL event is incomplete');
      else problems.push('invalid JSONL event');
      continue;
    }
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') {
      problems.push('event has no type'); continue;
    }
    raw.push(ev);
    if (ev.type === 'thread.started') {
      if (typeof ev.thread_id !== 'string' || !ev.thread_id.trim()) problems.push('thread_id is missing');
      else if (sessionId && sessionId !== ev.thread_id) problems.push('thread_id changed within a turn');
      else sessionId = ev.thread_id;
    } else if (ev.type === 'turn.started') {
      if (!sessionId) problems.push('turn.started precedes thread.started');
      if (started && !completed && !errorInfo) problems.push('turn.started precedes prior turn completion');
      started = true;
      completed = false;
      output = '';
      usageTotal = undefined;
    }
    else if (ev.type === 'turn.completed') {
      if (!started || completed) problems.push('turn.completed is out of order');
      if (!output.trim()) problems.push('completed turn has no agent_message');
      completed = true;
      if (!validUsage(ev.usage)) problems.push('turn.completed usage schema changed');
      else {
        usageTotal = Object.fromEntries(USAGE_KEYS.map(k => [k, ev.usage[k]]));
        if (lastCompletedUsage && USAGE_KEYS.some(k => usageTotal[k] < lastCompletedUsage[k])) {
          problems.push('thread usage totals decreased within the event stream');
        }
        lastCompletedUsage = usageTotal;
      }
    } else if (ev.type === 'turn.failed') {
      if (!ev.error || typeof ev.error.message !== 'string' || !ev.error.message.trim()) {
        problems.push('turn.failed error schema changed');
      } else recordFailure(ev.error, ev.type);
    } else if (ev.type === 'error') {
      if (typeof ev.message !== 'string' || !ev.message.trim()) problems.push('error message schema changed');
      else {
        // Codex also emits error before its own retry of a transient failure.
        reportedError = decodeCodexError(ev.message);
        if (reportedError.emptyMessage && !reportedError.kind) problems.push('error decoded error message is empty');
        warnings.push([reportedError.kind, reportedError.message].filter(Boolean).join(': '));
      }
    }
    else if (ev.type === 'item.completed') {
      if (!ev.item || typeof ev.item.type !== 'string') problems.push('completed item has no type');
      else if (ev.item.type === 'agent_message') {
        if (!started || completed) problems.push('agent_message is outside an active turn');
        if (typeof ev.item.text !== 'string') problems.push('agent_message text schema changed');
        else output = ev.item.text;
      } else if (ev.item.type === 'error') warnings.push(decodeCodexError(ev.item.message).message);
    }
  }
  // Only turn.failed or an unsuccessful exit turns an error message into a failure.
  // Without an exit code, standalone parsing of an unfinished recording preserves its reason.
  if (!errorInfo && reportedError && exitCode !== 0 && (exitCode !== undefined || !completed)) {
    errorInfo = reportedError;
  }
  if (expectedSessionId && sessionId && expectedSessionId !== sessionId) problems.push('resume returned a different thread_id');
  if (!errorInfo) {
    if (!sessionId) missing.push('thread.started is missing');
    if (!started) missing.push('turn.started is missing');
    if (!completed) missing.push('turn.completed is missing');
    if (!output.trim()) missing.push('final agent_message is missing or empty');
  }
  let usage;
  let usageUnknown = false;
  if (usageTotal) {
    if (previous) {
      if (previous.sessionId !== sessionId) problems.push('usage baseline belongs to a different thread');
      else if (!validUsage(previous.usageTotal)) problems.push('invalid previous usage baseline');
      else {
        usage = Object.fromEntries(USAGE_KEYS.map(k => [k, usageTotal[k] - previous.usageTotal[k]]));
        if (!validUsage(usage)) problems.push('thread usage totals decreased');
      }
    } else if (expectedSessionId) {
      usageUnknown = true;
      warnings.push('resume usage cannot be derived without previous thread totals');
    } else usage = { ...usageTotal };
  }
  const incomplete = !errorInfo && !problems.length && missing.length > 0;
  problems.push(...missing);
  const error = problems.length ? `Codex event format changed: ${problems.join('; ')}`
    : errorInfo ? [errorInfo.kind, errorInfo.message].filter(Boolean).join(': ') : undefined;
  // Success follows the absence of failures, never the truthiness of their descriptions.
  return { ok: !problems.length && !errorInfo, output, sessionId, raw, ...(usageTotal ? { usageTotal } : {}),
    ...(usage && !problems.length ? { usage } : {}), ...(usageUnknown ? { usageUnknown } : {}),
    ...(warnings.length ? { warnings } : {}), ...(problems.length ? { formatChanged: true } : {}),
    ...(incomplete ? { incomplete: true } : {}),
    ...(error ? { error } : {}), ...(errorInfo?.retryAt !== undefined ? { retryAt: errorInfo.retryAt } : {}) };
}

export function assessCodexVersion(text, { strict = false } = {}) {
  const match = String(text || '').trim().match(/^codex-cli (\d+)\.(\d+)\.(\d+)$/);
  if (!match) return { ok: false, error: 'Codex version output is unrecognised' };
  const version = match.slice(1).join('.');
  const got = match.slice(1).map(Number), pinned = CODEX_VERSION.split('.').map(Number);
  let comparison = 0;
  for (let i = 0; i < 3 && comparison === 0; i++) comparison = Math.sign(got[i] - pinned[i]);
  if (comparison < 0 && strict) return { ok: false, engineVersion: version,
    error: `Codex ${version} is older than verified ${CODEX_VERSION}` };
  return { ok: true, engineVersion: version, notes: comparison !== 0
    ? [`Codex ${version} differs from verified ${CODEX_VERSION}; live event-schema validation is required`] : [] };
}

export class CodexBackend extends Backend {
  constructor({ env = process.env, launch = runCliAsync, inspect = runCli, command,
    homeDir, homeMode, stateDir, envFiles = [] } = {}) {
    super();
    this.env = loadEngineSettingsEnvironment(envFiles, env);
    this.launch = launch;
    this.inspect = inspect;
    this.command = command;
    this.envFiles = [...envFiles];
    this.home = new CodexHome({ env: this.env, homeDir, homeMode, stateDir });
    this.usageTotals = new Map();
  }
  get id() { return 'codex'; }
  executable(env = this.env) { return this.command || resolveCodexLaunch({ env }); }

  executionEnvironment(cwd, env = this.env, writableRoots) {
    if (!this.envFiles.length) return env;
    const names = this.home.environmentNames({ cwd, writableRoots });
    return loadCodexEnvironment(this.envFiles, env, names);
  }

  // Inspect or prepare ownership, detector and login without launching the CLI.
  // Execution entrypoints use ensureReady for the complete protected configuration.
  prepareHome(opts = {}) { return this.home.prepare(opts); }

  async registerMcp(manifest, env = this.env, { targetDir = process.cwd(), ...opts } = {}) {
    const result = this.home.registerMcp(manifest, env, { cwd: targetDir, ...opts });
    if (!opts.dryRun) this.env = { ...this.env, ...env };
    return result;
  }

  async applyPermissions({ policy, targetDir = process.cwd(), dryRun = false,
    writableRoots } = {}) {
    const env = this.executionEnvironment(targetDir, this.env, writableRoots);
    return this.home.prepareExecution({ policy, cwd: targetDir, dryRun, writableRoots,
      apiKey: env.CODEX_API_KEY || '', mcpEnv: env });
  }

  async ensureReady({ cwd = process.cwd(), env = this.env, ...opts } = {}) {
    try {
      env = this.executionEnvironment(cwd, env, opts.writableRoots);
      const settings = resolveEngineSettings(this.id, opts, env);
      const instructions = validateCodexInstructions(cwd, { maxBytes: settings.instructionsMaxBytes,
        fallbackFilenames: opts.fallbackFilenames, rootMarkers: opts.rootMarkers,
        ...(this.home.mode === 'personal' ? { personalHome: this.home.personalHome } : {}) });
      const instructionBytes = instructions.totalBytes + (this.home.mode === 'managed' ? Buffer.byteLength(instructions.content) : 0);
      return { ...this.home.prepareExecution({ cwd, ...opts, ...settings, instructionSnapshot: instructions.content,
        instructionBytes, apiKey: env.CODEX_API_KEY || '', mcpEnv: env }), instructions };
    }
    catch (e) { throw new Error(`Invalid Codex protection: ${e.message}`, { cause: e }); }
  }

  async checkEngine({ cwd = process.cwd(), env = this.env, writableRoots } = {}) {
    let ready;
    try {
      env = this.executionEnvironment(cwd, env, writableRoots);
      ready = await this.ensureReady({ cwd, writableRoots, env });
    }
    catch (e) { return { ok: false, error: e.message, protectionFailed: true }; }
    const launchEnv = { ...(ready.cloudMode ? withoutOwnerTelegramEnvironment(env) : env), CODEX_HOME: ready.executionHome };
    const command = this.executable(launchEnv);
    const opts = { cwd, env: launchEnv, shell: false, encoding: 'utf8', timeoutMs: 10000 };
    const versionResult = this.inspect(command.bin, [...command.args, '--version'], opts);
    if (versionResult?.status !== 0) return { ok: false, error: 'Codex version check failed: CLI unavailable or timed out' };
    const version = assessCodexVersion(versionResult.stdout, { strict: resolveEngineSettings(this.id, {}, env).strictVersion });
    if (!version.ok) return version;
    if (String(env.CODEX_API_KEY || '').trim()) return { ...version, auth: 'api-key' };
    try { validateCodexInstructions(cwd); }
    catch (e) { return { ...version, ok: false, error: e.message, protectionFailed: true }; }
    const login = this.inspect(command.bin, [...command.args, 'login', 'status'], opts);
    if (login?.status !== 0) {
      const bashHome = "'" + ready.home.replaceAll("'", "'\\''") + "'";
      const powershellHome = "'" + ready.home.replaceAll("'", "''") + "'";
      const supervisor = join(loadProjectConfig({projectDir:cwd}).frameworkDir, 'core', 'supervisor.mjs');
      const bashSupervisor = "'" + supervisor.replaceAll("'", "'\\''") + "'";
      const powershellSupervisor = "'" + supervisor.replaceAll("'", "''") + "'";
      return { ...version, ok: false,
        error: ready.mode === 'personal' ? 'Codex is not logged in for its personal home; run codex login on this device.'
          : 'Codex is not logged in for its managed home. Scope CODEX_HOME to login only and restore its previous value before the supervisor. '
          + `Bash: CODEX_HOME=${bashHome} codex login. `
          + 'PowerShell: $previousCodexHome = $env:CODEX_HOME; '
          + `try { $env:CODEX_HOME = ${powershellHome}; codex login } finally { `
          + 'if ($null -eq $previousCodexHome) { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue } '
          + 'else { $env:CODEX_HOME = $previousCodexHome } }. '
          + `Bash supervisor: FRAMEWORK_CODEX_HOME=${bashHome} node ${bashSupervisor} --backend codex. `
          + `PowerShell supervisor: $env:FRAMEWORK_CODEX_HOME = ${powershellHome}; node ${powershellSupervisor} --backend codex. `
          + 'CODEX_API_KEY is also supported.' };
    }
    return { ...version, auth: 'saved-login' };
  }

  async prepareTurn({ prompt, cwd = process.cwd(), model, effort, sessionId,
    env = this.env, timeoutMs, idleTimeoutMs,
    sandbox, config, ignoreUserConfig, bypassHookTrust, maxBudgetUsd, writableRoots, instructionsMaxBytes } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, output: '', error: 'empty prompt' };
    // No USD is reported by Codex; never silently accept a spending guard we cannot enforce.
    if (Number(maxBudgetUsd) > 0) return { ok: false, output: '',
      error: 'Codex cannot enforce maxBudgetUsd: exec reports tokens, not USD', unsupportedBudget: true };
    const explicitModel = model;
    let command, args, launchEnv;
    try {
      const guardEnabled = resolveMode(env).mode !== ALLOW_ALL;
      const allowedConfig = validateCodexRuntimeOptions({ sandbox, config, ignoreUserConfig, bypassHookTrust, guardEnabled });
      const override = key => {
        const value = allowedConfig.findLast(value => value.slice(0, value.indexOf('=')).trim().replace(/["']/g, '') === key);
        return value?.slice(value.indexOf('=') + 1).trim();
      };
      const configuredSandbox = override('sandbox_mode')?.replace(/^["']|["']$/g, '');
      const rawInstructionBudget = override('project_doc_max_bytes');
      let settings = resolveEngineSettings(this.id, { model, effort, timeoutMs, idleTimeoutMs,
        sandbox: sandbox ?? configuredSandbox, instructionsMaxBytes: instructionsMaxBytes
          ?? (rawInstructionBudget !== undefined ? 0 : undefined) }, env);
      model = settings.model;
      if (!explicitModel && override('model')) model = undefined;
      sandbox = settings.sandbox;
      for (let i = allowedConfig.length - 1; i >= 0; i--) {
        if (allowedConfig[i].slice(0, allowedConfig[i].indexOf('=')).trim().replace(/["']/g, '') === 'sandbox_mode') allowedConfig.splice(i, 1);
      }
      timeoutMs = settings.timeoutMs;
      idleTimeoutMs = settings.idleTimeoutMs;
      if (settings.effort && (effort || !override('model_reasoning_effort'))) {
        for (let i = allowedConfig.length - 1; i >= 0; i--) {
          if (allowedConfig[i].slice(0, allowedConfig[i].indexOf('=')).trim().replace(/["']/g, '') === 'model_reasoning_effort') allowedConfig.splice(i, 1);
        }
        allowedConfig.push(`model_reasoning_effort=${JSON.stringify(settings.effort)}`);
      }
      // Validate the protocol arguments before writing managed files.
      buildCodexArgs({ model, sessionId, sandbox, config: allowedConfig });
      env = this.executionEnvironment(cwd, env, writableRoots);
      let ready = await this.ensureReady({ cwd, writableRoots, env, ...settings, ignoreUserConfig,
        ...(this.home.mode === 'personal' ? { dryRun: true, instructionsMaxBytes: 0 } : {}),
        inheritInstructionBudget: rawInstructionBudget !== undefined && instructionsMaxBytes === undefined });
      launchEnv = { ...(ready.cloudMode ? withoutOwnerTelegramEnvironment(env) : env), CODEX_HOME: ready.executionHome };
      command = this.executable(launchEnv);
      let cloudOverrides = [];
      if (ready.cloudMode && ready.mode === 'personal') {
        const inspectArgs = [...allowedConfig, ...ready.overrides].flatMap(value => ['-c', value]);
        const inspected = this.inspect(command.bin, [...command.args, ...inspectArgs, 'mcp', 'list', '--json'],
          { cwd, env: launchEnv, encoding: 'utf8', timeoutMs: 10000 });
        if (inspected?.status !== 0) throw new Error('Invalid Codex protection: could not inspect cloud MCP configuration');
        cloudOverrides = cloudCodexMcpOverrides(inspected.stdout);
      }
      if (ready.mode === 'personal') {
        let inspectionEnv = launchEnv;
        if (ignoreUserConfig) {
          const inspection = this.home.prepareInspection({ cwd, writableRoots });
          inspectionEnv = { ...launchEnv, CODEX_HOME: inspection.inspectionHome };
          delete inspectionEnv.CODEX_API_KEY; delete inspectionEnv.OPENAI_API_KEY;
        }
        const inspected = await inspectCodexInstructionConfig({ command, cwd, env: inspectionEnv,
          config: [...allowedConfig, ...ready.overrides.filter(value => !value.startsWith('project_doc_max_bytes=')), ...cloudOverrides,
            `sandbox_mode=${JSON.stringify(sandbox)}`,
            ...(instructionsMaxBytes !== undefined ? [`project_doc_max_bytes=${settings.instructionsMaxBytes ?? Number.MAX_SAFE_INTEGER}`] : [])] });
        // Native -c can use TOML integers (65_536, 0x10000) and quoted keys. Let the CLI
        // parse them; an explicit native budget wins over the environment without rewriting it.
        if (instructionsMaxBytes === undefined && inspected.inlineInstructionBudget) {
          settings = resolveEngineSettings(this.id, { ...settings, instructionsMaxBytes: 0 }, env);
        }
        ready = await this.ensureReady({ cwd, writableRoots, env, ...settings, ignoreUserConfig,
          fallbackFilenames: inspected.fallbackFilenames, rootMarkers: inspected.rootMarkers,
          inheritInstructionBudget: instructionsMaxBytes === undefined && (inspected.inlineInstructionBudget
            || (inspected.inheritedInstructionBudget && !settings.instructionsLimitSpecified)) });
      }
      const overrides = [...allowedConfig, ...ready.overrides, ...cloudOverrides];
      args = buildCodexArgs({ model, sessionId, sandbox, config: overrides,
        bypassHookTrust: bypassHookTrust ?? ready.guardEnabled, ignoreUserConfig });
      if (ready.mode === 'personal' && ready.instructions.files.some(file => file.endsWith('CLAUDE.md'))) {
        prompt = `${ready.instructions.content}\nTask:\n${prompt}`;
      }
    } catch (e) { return { ok: false, output: '', error: e.message }; }
    return { ok: true, command, args, env: launchEnv, prompt, cwd, timeoutMs, idleTimeoutMs };
  }

  async runTurn(options = {}) {
    const prepared = await this.prepareTurn(options);
    if (!prepared.ok) return prepared;
    const { command, args, env: launchEnv, prompt, cwd, timeoutMs, idleTimeoutMs } = prepared;
    const { sessionId, previousUsage } = options;
    const res = await this.launch(command.bin, [...command.args, ...args], {
      cwd, env: launchEnv, shell: false, encoding: 'utf8', input: prompt,
      timeoutMs, idleTimeoutMs, maxBuffer: 64 * 1024 * 1024,
    });
    if (res?.cleanupRefused) return { ok: false, output: res.stdout || '', cleanupRefused: true,
      error: `Child cleanup refused: ${res.stderr || 'process ownership could not be proved'}` };
    const baseline = sessionId ? previousUsage || this.usageTotals.get(sessionId) : undefined;
    const parsed = parseCodexEvents(res?.stdout, {
      expectedSessionId: sessionId,
      exitCode: res?.status,
      ...(baseline ? { previous: { sessionId, usageTotal: baseline } } : {}),
    });
    if (parsed.usageTotal && parsed.sessionId && !parsed.formatChanged) {
      this.usageTotals.set(parsed.sessionId, parsed.usageTotal);
    }
    if (res?.timedOut) return { ...parsed, ok: false, timedOut: true,
      error: `Codex turn timed out (silence limit ${idleTimeoutMs} ms, overall ${timeoutMs} ms)` };
    if (res?.truncated) return { ...parsed, ok: false, formatChanged: true,
      error: 'Codex event format unavailable: output exceeded capture buffer' };
    if (!res || res.status !== 0) return { ...parsed, ok: false,
      // Missing events after a failed process are interruption evidence, not a schema change.
      // Invalid fields/order still refuse loudly even when stderr happens to mention a network.
      error: (parsed.incomplete && String(res?.stderr || '').trim() ? res.stderr
        : String(res?.stdout || '').trim() ? parsed.error : res?.stderr)
        || parsed.error || res?.stderr || `Codex exited ${res?.status}` };
    return parsed;
  }

  async installInstructions({ targetDir, content, dryRun = false, instructionsMaxBytes } = {}) {
    const limit = resolveEngineSettings(this.id, { instructionsMaxBytes }, this.env).instructionsMaxBytes;
    if (typeof content !== 'string' || (limit !== undefined && Buffer.byteLength(content, 'utf8') > limit)) {
      throw new Error('Codex instructions are not text or exceed the configured limit');
    }
    return publishProjectInstructions({ targetDir, filename: 'AGENTS.md', content, dryRun, maxBytes: limit });
  }
  guardCommand(command) { return guardReason(command, this.env); }
}
