// Explicit call > environment > the engine's own config (omit the flag).
// Only operational values required by the loop have framework defaults.
export const DEFAULT_IDLE_TIMEOUT_MS = 99 * 60 * 1000;
export const DEFAULT_TURN_TIMEOUT_MS = 9999 * 60 * 60 * 1000;
export const DEFAULT_NETWORK_RETRIES = Infinity;

const VARIABLES = Object.freeze({
  codex: { model: 'CODEX_MODEL', effort: 'CODEX_REASONING_EFFORT' },
  claude: { model: 'CLAUDE_MODEL', effort: 'CLAUDE_EFFORT' },
  opencode: { model: 'OPENCODE_MODEL', effort: 'OPENCODE_VARIANT' },
});
export const ENGINE_ENV_NAMES = Object.freeze([
  ...Object.values(VARIABLES).flatMap(Object.values),
  'CLAUDE_HEADLESS_PERMISSION_MODE', 'CLAUDE_STRICT_MCP', 'CODEX_SANDBOX',
  'CODEX_HOME_MODE', 'FRAMEWORK_CODEX_HOME', 'CODEX_INSTRUCTIONS_MAX_BYTES',
  'CODEX_STRICT_VERSION', 'SAFETY_GUARD_MODE', 'SAFETY_GUARD_LOG', 'AGENT_IDLE_TIMEOUT_MS', 'AGENT_TURN_TIMEOUT_MS',
  'AGENT_NETWORK_RETRIES',
  ...['HIGH', 'MID', 'LOW', 'SMOKE'].flatMap(tier => [`CODEX_MODEL_${tier}`, `OPENROUTER_MODEL_${tier}`]),
]);

const present = value => value !== undefined && value !== null && value !== '';
const setting = (explicit, env, key, fallback) => present(explicit) ? explicit
  : key && present(env?.[key]) ? env[key] : fallback;

function milliseconds(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} needs nonnegative whole milliseconds`);
  return number;
}

export function parseDuration(value) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(value));
  if (!match) throw new Error('timeout needs a nonnegative duration, for example 99m or 9999h');
  return milliseconds(Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2] || 's']), 'timeout');
}

function boolean(value, name) {
  if ([true, 1, '1', 'true'].includes(value)) return true;
  if ([false, 0, '0', 'false'].includes(value)) return false;
  throw new Error(`${name} needs 1 or 0`);
}

export function resolveEngineSettings(backendId, opts = {}, env = process.env, projectSettings = {}) {
  // Custom Backend implementations still share the operational timeout contract.
  const variables = VARIABLES[backendId] || {};
  const configured = (key, fallback) => present(projectSettings[key]) ? projectSettings[key] : fallback;
  const retries = setting(opts.networkRetries, env, 'AGENT_NETWORK_RETRIES', configured('networkRetries', DEFAULT_NETWORK_RETRIES));
  const result = {
    model: setting(opts.model, env, variables.model, configured('model')),
    effort: setting(opts.effort, env, variables.effort, configured('effort')),
    timeoutMs: milliseconds(setting(opts.timeoutMs, env, 'AGENT_TURN_TIMEOUT_MS', configured('timeoutMs', DEFAULT_TURN_TIMEOUT_MS)), 'turn timeout'),
    idleTimeoutMs: milliseconds(setting(opts.idleTimeoutMs, env, 'AGENT_IDLE_TIMEOUT_MS', configured('idleTimeoutMs', DEFAULT_IDLE_TIMEOUT_MS)), 'idle timeout'),
    networkRetries: retries === DEFAULT_NETWORK_RETRIES ? retries : milliseconds(retries, 'network retries'),
  };
  if (backendId === 'claude') {
    result.strictMcp = boolean(setting(opts.strictMcp, env, 'CLAUDE_STRICT_MCP', configured('strictMcp', false)), 'CLAUDE_STRICT_MCP');
    result.permissionMode = setting(opts.permissionMode, env, 'CLAUDE_HEADLESS_PERMISSION_MODE', configured('permissionMode', 'bypassPermissions'));
  }
  if (backendId === 'codex') {
    result.sandbox = setting(opts.sandbox, env, 'CODEX_SANDBOX', configured('sandbox', 'danger-full-access'));
    if (!['danger-full-access', 'workspace-write', 'read-only'].includes(result.sandbox)) throw new Error('Invalid Codex sandbox');
    result.homeDir = setting(opts.homeDir, env, 'FRAMEWORK_CODEX_HOME', configured('homeDir'));
    result.homeMode = setting(opts.homeMode, env, 'CODEX_HOME_MODE', configured('homeMode', result.homeDir ? 'managed' : 'personal'));
    if (!['personal', 'managed'].includes(result.homeMode)) throw new Error('Invalid Codex home mode');
    if (result.homeDir && result.homeMode !== 'managed') throw new Error('FRAMEWORK_CODEX_HOME requires managed mode');
    const limit = setting(opts.instructionsMaxBytes ?? (opts.instructionsLimitSpecified ? 0 : undefined),
      env, 'CODEX_INSTRUCTIONS_MAX_BYTES', configured('instructionsMaxBytes'));
    result.instructionsLimitSpecified = present(limit);
    result.instructionsMaxBytes = present(limit) ? milliseconds(limit, 'instruction limit') || undefined : undefined;
    result.strictVersion = boolean(setting(opts.strictVersion, env, 'CODEX_STRICT_VERSION', configured('strictVersion', false)), 'CODEX_STRICT_VERSION');
    const config = opts.config ?? projectSettings.config;
    if (config !== undefined) result.config = config;
  }
  return result;
}
