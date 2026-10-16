// Load credential sources without allowing a project file to reconfigure the host.
import { readFileSync } from 'node:fs';
import { isCloudMcpMode, isOwnerTelegramVariable, withoutOwnerTelegramEnvironment } from './cloud-mcp-policy.mjs';
import { ENGINE_ENV_NAMES } from '../core/engine-settings.mjs';

const variable = /^[A-Za-z_][A-Za-z0-9_]*$/;
const reserved = /^(?:PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|TEMP|TMP|TMPDIR|NODE_.*|NPM_.*|CODEX_HOME|CODEX_BIN|CODEX_CLI_.*|FRAMEWORK_.*|XDG_.*|AGENT_BACKEND|SAFETY_GUARD_MODE|LD_.*|DYLD_.*|PYTHON.*|BASH_ENV|ENV|SHELL)$/i;
// NPM_GLOBAL_ROOT is a manifest path, not an option to the npm executable.
const loadable = name => variable.test(name) && (name === 'NPM_GLOBAL_ROOT' || !reserved.test(name));

// Read only the documented settings; never execute .env as shell source.
export function loadEngineSettingsEnvironment(files = [], env = process.env) {
  return loadCodexEnvironment(files, env, ENGINE_ENV_NAMES, { settings: true });
}

export function mcpEnvironmentNames(manifest) {
  const names = new Set(['CODEX_API_KEY']);
  for (const server of manifest?.servers || []) {
    for (const name of Array.isArray(server?.secrets) ? server.secrets : []) {
      if (typeof name === 'string' && loadable(name)) names.add(name);
    }
    const strings = [server?.command, server?.url, ...(Array.isArray(server?.args) ? server.args : []),
      ...Object.values(server?.env || {}), ...Object.values(server?.headers || {})];
    for (const value of strings) if (typeof value === 'string') {
      for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) {
        if (loadable(match[1])) names.add(match[1]);
      }
    }
  }
  return [...names];
}

export function loadCodexEnvironment(files, env, names = ['CODEX_API_KEY'], { settings = false } = {}) {
  const cloudMode = isCloudMcpMode(env);
  const result = Object.assign(Object.create(null), cloudMode ? withoutOwnerTelegramEnvironment(env) : env);
  const allowed = new Set(names.filter(name => (loadable(name) || (settings && ENGINE_ENV_NAMES.includes(name)))
    && (!cloudMode || !isOwnerTelegramVariable(name))));
  // Windows environment names are case-insensitive, including already exported ones.
  const occupied = new Set(Object.keys(result).filter(name => result[name] !== undefined)
    .map(name => process.platform === 'win32' ? name.toUpperCase() : name));
  for (const file of files) {
    let text;
    try { text = readFileSync(file, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') continue; throw new Error('Could not read Codex environment file', { cause: e }); }
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || !allowed.has(match[1])) continue;
      const name = match[1], identity = process.platform === 'win32' ? name.toUpperCase() : name;
      if (occupied.has(identity)) continue;
      let value = match[2];
      if (value.startsWith('"') || value.startsWith("'")) {
        const quote = value[0], end = value.lastIndexOf(quote);
        if (end === 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) throw new Error(`Invalid quoted Codex environment variable: ${name}`);
        value = value.slice(1, end);
      } else value = value.replace(/\s+#.*$/, '').trimEnd();
      if (value.includes('\0')) throw new Error(`Invalid Codex environment variable: ${name}`);
      result[name] = value;
      occupied.add(identity);
    }
  }
  return result;
}
