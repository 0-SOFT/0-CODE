// Installed personal-mode guard snapshots live in .0-code/run; explicitly managed
// authentication homes stay outside writable roots. The host captures
// the detector once, before an agent can change its source, and restores these bytes.
import { existsSync, lstatSync, mkdirSync, readFileSync,
  realpathSync, statSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { buildPermissionsBlock } from '../permissions-policy.mjs';
import { compileCodexRules, buildCodexHooks } from './codex-policy.mjs';
import { buildCodexConfiguration } from './codex-config.mjs';
import { generateCodexMcp } from './codex-mcp.mjs';
import { mcpEnvironmentNames } from '../../lib/codex-env.mjs';
import { cloudMcpManifest, isCloudMcpMode, withoutOwnerTelegramEnvironment } from '../../lib/cloud-mcp-policy.mjs';
import { replaceFileSync } from '../../lib/replace-file.mjs';
import { resolveEngineSettings } from '../engine-settings.mjs';
import { resolveMode, ALLOW_ALL } from '../permission-decision.mjs';
import { findProjectRoot, loadProjectConfig } from '../project-config.mjs';

const SAFETY_SOURCE = new URL('../safety.mjs', import.meta.url);
const DECISION_SOURCE = new URL('../permission-decision.mjs', import.meta.url);
const HOOK_SOURCE = new URL('./codex-hook.mjs', import.meta.url);
const MCP_LAUNCH_SOURCE = new URL('./codex-mcp-launch.mjs', import.meta.url);
const CLI_LAUNCH_SOURCE = new URL('./cli-launch.mjs', import.meta.url);

// Resolve existing ancestors too: an absent final directory does not make a symlink
// above it invisible. A dangling link is an error, never a fresh writable directory.
export function canonicalCodexPath(path, { realpath = realpathSync.native, lstat = lstatSync } = {}) {
  let current = resolve(path);
  const suffix = [];
  for (;;) {
    try { return join(realpath(current), ...suffix.reverse()); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      try {
        if (lstat(current).isSymbolicLink()) throw new Error('Dangling Codex path link');
      } catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
      const parent = dirname(current);
      if (parent === current) throw e;
      suffix.push(relative(parent, current));
      current = parent;
    }
  }
}

function contains(root, path) {
  const tail = relative(root, path);
  return !tail || (tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail));
}

function normalFile(file, lstat = lstatSync) {
  try {
    const stat = lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`Codex managed file must be a regular, unlinked file: ${file}`);
    }
    return true;
  } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

export class CodexHome {
  #safety;
  #decision;
  #bindings = new Map();
  #pathAccess;
  #hook;
  #defaultPolicy;
  #protection = new Map();
  #executionRoots = new Map();
  #registrations = new Map();
  #mcpLauncher;
  #cliLauncher;

  constructor({ env = process.env, homeDir, homeMode, stateDir, platform = process.platform,
    userHome = homedir(), safetySource = SAFETY_SOURCE, hookSource = HOOK_SOURCE, pathAccess = {} } = {}) {
    // No disk mutation or CLI launch in the constructor, including during dry-run.
    this.env = { ...env };
    const settings = resolveEngineSettings('codex', { homeDir, homeMode }, env);
    this.homeDir = settings.homeDir;
    this.mode = settings.homeMode;
    this.stateDir = stateDir ?? (platform === 'win32'
      ? join(env.LOCALAPPDATA || join(userHome, 'AppData', 'Local'), '0-code', 'codex')
      : join(env.XDG_STATE_HOME || join(userHome, '.local', 'state'), '0-code', 'codex'));
    this.personalHome = env.CODEX_HOME || join(userHome, '.codex');
    this.reservedHomes = [...new Set([resolve(join(userHome, '.codex')), resolve(this.personalHome)])];
    this.#pathAccess = { realpath: realpathSync.native, lstat: lstatSync, ...pathAccess };
    this.#safety = readFileSync(safetySource);
    this.#decision = readFileSync(DECISION_SOURCE);
    this.#hook = readFileSync(hookSource);
    this.#mcpLauncher = readFileSync(MCP_LAUNCH_SOURCE);
    this.#cliLauncher = readFileSync(CLI_LAUNCH_SOURCE);
    this.#defaultPolicy = buildPermissionsBlock();
  }

  #canonical(path) { return canonicalCodexPath(path, this.#pathAccess); }
  #normalFile(file) { return normalFile(file, this.#pathAccess.lstat); }

  plan({ cwd = process.cwd(), writableRoots = [], dryRun = false } = {}) {
    if (!Array.isArray(writableRoots) || writableRoots.some(p => typeof p !== 'string' || !p)) {
      throw new Error('Codex writableRoots must be paths');
    }
    const project = this.#canonical(cwd);
    try { if (!statSync(project).isDirectory()) throw new Error('Codex project must be a directory'); }
    catch (e) { if (!dryRun || e.code !== 'ENOENT') throw e; }
    const identity = process.platform === 'win32' ? project.toLowerCase() : project;
    const digest = createHash('sha256').update(identity).digest('hex');
    const installation=loadProjectConfig({projectDir:findProjectRoot(project),env:this.env});
    const runtimeGuard=installation.installed&&this.mode==='personal'&&!this.homeDir;
    const configured = this.homeDir || (runtimeGuard?installation.runtimePath('codex-guard'):join(this.stateDir, digest));
    if (!isAbsolute(configured)) throw new Error('Codex home must be an absolute path');
    const roots = [project, ...writableRoots.map(p => this.#canonical(p))];
    for (const root of roots) {
      if (!runtimeGuard&&(contains(root, resolve(configured)) || contains(resolve(configured), root))) {
        throw new Error('Codex home overlaps an agent-writable root');
      }
    }
    // Reject personal paths before any realpath/stat of a requested home.
    for (const personal of this.reservedHomes) {
      if (contains(personal, resolve(configured)) || contains(resolve(configured), personal)) {
        throw new Error('Codex managed home overlaps the personal Codex home');
      }
    }
    const home = this.#canonical(configured);
    for (const path of roots) {
      if (!runtimeGuard&&(contains(path, home) || contains(home, path))) {
        throw new Error('Codex home overlaps an agent-writable root');
      }
    }
    // Reserve directory identities too: a personal path can itself be an alias.
    // Only directory metadata is resolved; no authentication file is inspected here.
    const personal = resolve(this.personalHome);
    for (const reserved of this.reservedHomes) {
      const canonical = this.#canonical(reserved);
      if (contains(canonical, home) || contains(home, canonical)) {
        throw new Error('Codex managed home overlaps the personal Codex home');
      }
    }
    if(runtimeGuard&&existsSync(home)&&!existsSync(join(home,'framework-owner.json'))&&readdirSync(home).length)
      throw new Error('Codex runtime guard has unowned files; resolve this collision first');
    const bound = this.#bindings.get(identity);
    if (bound && bound !== home) throw new Error('Codex home changed after project binding');
    this.#bindings.set(identity, home);
    const executionHome = this.mode === 'personal' ? personal : home;
    return { project, home, identity, personal, mode: this.mode, executionHome, writableRoots: roots.slice(1),
      ownerFile: join(home, 'framework-owner.json'), safetyFile: join(home, 'guard', 'safety.mjs'),
      authFile: join(executionHome, 'auth.json') };
  }

  #checkTree(home, directory) {
    if (this.#canonical(home) !== home) throw new Error('Codex home was redirected');
    const tail = relative(home, directory);
    if (!contains(home, directory)) throw new Error('Codex artifact escaped its home');
    let current = home;
    for (const part of ['', ...tail.split(sep).filter(Boolean)]) {
      current = part ? join(current, part) : current;
      if (!existsSync(current)) continue;
      const stat = this.#pathAccess.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Codex managed directory must not be a link: ${current}`);
      }
    }
  }

  #restore(file, expected, home, restored) {
    const directory = dirname(file);
    this.#checkTree(home, directory);
    const present = this.#normalFile(file);
    if (present && readFileSync(file).equals(expected)) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#checkTree(home, directory);
    const temporary = join(directory, `.framework-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, expected, { flag: 'wx', mode: 0o600 });
      replaceFileSync(temporary, file, { validate: () => {
        this.#checkTree(home, directory);
        this.#normalFile(file);
        this.#normalFile(temporary);
      } });
      if (!readFileSync(file).equals(expected)) throw new Error('Codex artifact verification failed');
      restored.push(file);
    } finally {
      // Only the exact staging file created above; no recursive or shared cleanup.
      this.#checkTree(home, directory);
      if (this.#normalFile(temporary)) unlinkSync(temporary);
    }
  }

  prepare({ cwd, writableRoots, dryRun = false, apiKey = this.env.CODEX_API_KEY } = {}) {
    const plan = this.plan({ cwd, writableRoots, dryRun });
    const { home, ownerFile, safetyFile, authFile, identity } = plan;
    this.#checkTree(home, join(home, 'guard'));
    const owner = Buffer.from(JSON.stringify({ schema: 1, project: identity }) + '\n');
    if (this.#normalFile(ownerFile) && !readFileSync(ownerFile).equals(owner)) {
      throw new Error('Codex home belongs to a different project or has a damaged owner marker');
    }
    const authPresent = this.mode === 'managed' && this.#normalFile(authFile);
    if (dryRun) return { ...plan, dryRun: true, restored: [], auth: authPresent ? 'existing' : 'uninspected' };
    const restored = [];
    this.#restore(ownerFile, owner, home, restored);
    this.#restore(safetyFile, this.#safety, home, restored);
    this.#restore(join(home, 'guard', 'permission-decision.mjs'), this.#decision, home, restored);
    let auth = this.mode === 'personal' ? 'personal' : authPresent ? 'existing' : 'missing';
    if (!authPresent && String(apiKey || '').trim()) auth = 'api-key';
    return { ...plan, restored, auth };
  }

  prepareProtection({ policy, nodePath = process.execPath, guardEnabled = true, ...opts } = {}) {
    const plan = this.plan(opts);
    let protection = this.#protection.get(plan.identity);
    if (policy !== undefined || !protection || protection.guardEnabled !== guardEnabled) {
      const compiled = compileCodexRules(policy === undefined ? this.#defaultPolicy : policy);
      const hookFile = join(plan.home, 'guard', 'backends', 'codex-hook.mjs');
      const hooksFile = join(plan.home, 'hooks.json');
      const rulesFile = join(plan.home, 'rules', 'framework.rules');
      const hooks = guardEnabled ? buildCodexHooks({ hookFile, nodePath, auditFile: join(plan.home, 'guard.log') }) : { hooks: {} };
      protection = { compiled, hookFile, hooksFile, rulesFile, hooks, guardEnabled,
        files: [[hookFile, this.#hook], [hooksFile, Buffer.from(JSON.stringify(hooks, null, 2) + '\n')],
          [rulesFile, Buffer.from(guardEnabled ? compiled.rules : '# Framework guard disabled by allow-all\n')]] };
      this.#protection.set(plan.identity, protection);
    }
    const result = this.prepare(opts);
    if (!opts.dryRun) for (const [file, bytes] of protection.files) {
      this.#restore(file, bytes, plan.home, result.restored);
    }
    const { mapping, dropped } = structuredClone(protection.compiled);
    return { ...result, applied: !opts.dryRun, mapping, dropped,
      hookFile: protection.hookFile, hooksFile: protection.hooksFile, rulesFile: protection.rulesFile,
      hooks: structuredClone(protection.hooks),
      note: 'Protection files installed; native Codex hook trust and live enforcement still require verification' };
  }

  #registration(plan) {
    let entry = this.#registrations.get(plan.identity);
    if (entry) return entry;
    const file = join(plan.home, 'framework-mcp.json');
    this.#checkTree(plan.home, plan.home);
    let manifest = { schema_version: 1, servers: [] };
    const persisted = this.#normalFile(file);
    if (persisted) {
      try { manifest = JSON.parse(readFileSync(file, 'utf8')); }
      catch { throw new Error('Invalid Codex MCP registration file'); }
      if (manifest?.schema_version !== 1 || !Array.isArray(manifest.servers)
          || (manifest.cloud_mode !== undefined && typeof manifest.cloud_mode !== 'boolean')) {
        throw new Error('Invalid Codex MCP registration schema');
      }
    }
    entry = { file, manifest, persisted };
    this.#registrations.set(plan.identity, entry);
    return entry;
  }

  cloudMode(opts = {}) {
    const plan = this.prepare({ ...opts, dryRun: true });
    return isCloudMcpMode(this.env) || this.#registration(plan).manifest.cloud_mode === true;
  }

  environmentNames(opts = {}) {
    // Use the same owned, validated snapshot as execution, never a second registry.
    const plan = this.prepare({ ...opts, dryRun: true });
    const manifest = this.#registration(plan).manifest;
    return mcpEnvironmentNames(cloudMcpManifest(manifest, isCloudMcpMode(this.env) || manifest.cloud_mode === true));
  }

  registerMcp(manifest, env = this.env, { cwd, dryRun = false, ...opts } = {}) {
    const plan = this.plan({ cwd, ...opts, dryRun });
    const launcherFile = join(plan.home, 'guard', 'backends', 'codex-mcp-launch.mjs');
    // Validate ownership before reading previous registrations; preview never imports login.
    this.prepare({ cwd, ...opts, dryRun: true });
    const existing = this.#registration(plan);
    const cloudMode = isCloudMcpMode(env) || isCloudMcpMode(this.env) || existing.manifest.cloud_mode === true;
    const incoming = generateCodexMcp(manifest, env, { launcherFile, cloudMode });
    const merged = new Map(cloudMcpManifest(existing.manifest, cloudMode).servers.map(s => [s.name, s]));
    for (const s of manifest.servers) if (typeof s?.name === 'string') merged.delete(s.name);
    for (const s of incoming.manifest.servers) merged.set(s.name, s);
    const proposed = { schema_version: 1, ...(cloudMode ? { cloud_mode: true } : {}), servers: [...merged.values()] };
    if (dryRun) return { ...plan, dryRun, registered: incoming.registered,
      skipped: incoming.skipped, reasons: incoming.reasons, restored: [] };
    this.#registrations.set(plan.identity, { file: existing.file, manifest: structuredClone(proposed), persisted: true });
    const ready = this.prepareExecution({ cwd, ...opts, apiKey: env.CODEX_API_KEY || '', mcpEnv: env });
    return { ...ready, registered: incoming.registered, skipped: incoming.skipped, reasons: incoming.reasons };
  }

  prepareExecution(opts = {}) {
    if (opts.instructionSnapshot !== undefined
        && (typeof opts.instructionSnapshot !== 'string' || !opts.instructionSnapshot.trim())) {
      throw new Error('Invalid Codex instruction snapshot');
    }
    const plan = this.plan(opts);
    const writableRoots = opts.writableRoots === undefined
      ? this.#executionRoots.get(plan.identity) || [] : plan.writableRoots;
    const guardEnabled = resolveMode(opts.mcpEnv ?? this.env).mode !== ALLOW_ALL;
    const result = this.prepareProtection({ ...opts, writableRoots, guardEnabled });
    this.#executionRoots.set(plan.identity, [...result.writableRoots]);
    const registration = this.#registration(result);
    const launcherFile = join(result.home, 'guard', 'backends', 'codex-mcp-launch.mjs');
    const cloudMode = isCloudMcpMode(opts.mcpEnv ?? this.env) || isCloudMcpMode(this.env)
      || registration.manifest.cloud_mode === true;
    const executionEnv = cloudMode ? withoutOwnerTelegramEnvironment(opts.mcpEnv ?? this.env) : (opts.mcpEnv ?? this.env);
    const mcp = generateCodexMcp(registration.manifest, executionEnv, { launcherFile, cloudMode });
    if (cloudMode && !opts.dryRun) {
      registration.manifest = { ...cloudMcpManifest(registration.manifest), cloud_mode: true };
      registration.persisted = true;
    }
    if (registration.persisted && !opts.dryRun) {
      this.#restore(registration.file, Buffer.from(JSON.stringify(registration.manifest, null, 2) + '\n'), result.home, result.restored);
      this.#restore(launcherFile, this.#mcpLauncher, result.home, result.restored);
      this.#restore(join(result.home, 'guard', 'backends', 'cli-launch.mjs'), this.#cliLauncher, result.home, result.restored);
    }
    const settings = resolveEngineSettings('codex', opts, executionEnv);
    const configuration = buildCodexConfiguration({ ...result, ...settings, env: executionEnv,
      hooks: this.mode === 'personal' || opts.ignoreUserConfig ? result.hooks : undefined,
      instructionBytes: opts.instructionBytes || 0,
      inheritInstructionBudget: opts.inheritInstructionBudget,
      ...(registration.persisted || cloudMode ? { mcpOverrides: mcp.overrides } : {}),
      ...(cloudMode && this.mode === 'managed' ? { mcpOverride: mcp.override } : {}) });
    const configFile = join(result.home, 'config.toml');
    const instructionsFile = join(result.home, 'AGENTS.override.md');
    if (!opts.dryRun) {
      if (this.mode === 'managed') this.#restore(configFile, Buffer.from(configuration.content), result.home, result.restored);
      if (this.mode === 'managed' && opts.instructionSnapshot !== undefined) {
        this.#restore(instructionsFile, Buffer.from(opts.instructionSnapshot), result.home, result.restored);
      }
    }
    return { ...result, configFile, instructionsFile, overrides: configuration.overrides, launcherFile,
      cloudMode, guardEnabled,
      mcp: { registered: mcp.registered, skipped: mcp.skipped, reasons: mcp.reasons } };
  }

  prepareInspection({ cwd, writableRoots } = {}) {
    const plan = this.prepare({ cwd, writableRoots });
    const home = join(plan.home, 'inspection');
    this.#restore(join(home, 'config.toml'), Buffer.alloc(0), plan.home, plan.restored);
    return { ...plan, inspectionHome: home };
  }
}
