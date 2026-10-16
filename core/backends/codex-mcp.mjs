import { isOwnerTelegramMcp, isCloudMcpMode, CLOUD_MCP_REFUSAL } from '../../lib/cloud-mcp-policy.mjs';
import { assertNoMcpSecret, resolvePublicMcpValue, validateMcpSource, mcpTransport } from './mcp-input.mjs';
// Translate the secret-free manifest. Credentials remain environment references.
const variable = /^[A-Za-z_][A-Za-z0-9_]*$/;
const targetVariable = /^[A-Za-z0-9_]+$/;
const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}$/;
const serverFields = new Set(['name', 'type', 'command', 'args', 'env', 'url', 'headers',
  'secrets', 'portable', 'needs_setup', 'source', 'linux_setup', 'note', 'description',
  'npm_package', 'repo', 'version', 'setup']);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const present = (env, name) => typeof env[name] === 'string' && env[name].trim() !== '';
// CLI dotted paths split literally: quotes become part of the key, unlike TOML table headers.
function overrideName(name) {
  if(!/^[A-Za-z0-9_-]+$/.test(name))throw new Error('Codex MCP name cannot be represented as a CLI override');
  return name;
}

// Inspect the engine's effective MCP list in memory; never persist its configuration/credentials.
export function cloudCodexMcpOverrides(stdout) {
  let servers;
  try { servers = JSON.parse(stdout); } catch { throw new Error('Could not inspect effective Codex MCP configuration'); }
  if (!Array.isArray(servers) || servers.some(server => typeof server?.name !== 'string' || !server.name)) {
    throw new Error('Could not inspect effective Codex MCP configuration');
  }
  return servers.filter(server => {
    const config = server.transport || server.config || server;
    return isOwnerTelegramMcp({ ...config, headers: config.env_http_headers || config.http_headers,
      secrets: [...(Array.isArray(config.env_vars) ? config.env_vars : []), config.bearer_token_env_var || ''] }, server.name);
  }).map(server => `mcp_servers.${overrideName(server.name)}.enabled=false`);
}

function strings(value) {
  if (!record(value) || Object.values(value).some(v => typeof v !== 'string' || v.includes('\0'))) {
    throw new Error('expected a string mapping');
  }
  return value;
}

// JSON string quoting is also valid for TOML basic strings used here.
export function codexMcpToml(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(codexMcpToml).join(', ')}]`;
  if (record(value)) return `{${Object.entries(value).map(([k, v]) =>
    `${JSON.stringify(k)}=${codexMcpToml(v)}`).join(', ')}}`;
  throw new Error('unsupported MCP configuration value');
}

export function generateCodexMcp(manifest, env = process.env, { launcherFile, nodePath = process.execPath, cloudMode = isCloudMcpMode(env) } = {}) {
  if (!record(manifest) || !Array.isArray(manifest.servers)
    || (manifest.schema_version !== undefined && manifest.schema_version !== 1)) {
    throw new Error('Invalid Codex MCP manifest');
  }
  const mcp = Object.create(null), reasons = Object.create(null), skipped = [], servers = [];
  const names = manifest.servers.map(s => s?.name);
  for (const server of manifest.servers) {
    const name = typeof server?.name === 'string' ? server.name : '<unnamed>';
    try {
      if (!record(server) || !/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('invalid server name');
      if (names.filter(n => n === name).length > 1) throw new Error('duplicate server name');
      if (Object.keys(server).some(key => !serverFields.has(key))) throw new Error('unsupported server field');
      if (['portable', 'needs_setup'].some(key => server[key] !== undefined && typeof server[key] !== 'boolean')) {
        throw new Error('invalid portability or setup flag');
      }
      if (['command', 'url'].some(key => server[key] !== undefined && typeof server[key] !== 'string')) {
        throw new Error('invalid command or URL type');
      }
      if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(v => typeof v !== 'string'))) {
        throw new Error('expected a string argument array');
      }
      for (const key of ['env', 'headers']) if (server[key] !== undefined) strings(server[key]);
      if (cloudMode && isOwnerTelegramMcp(server)) throw new Error(CLOUD_MCP_REFUSAL);
      validateMcpSource(server.source);
      if (server.portable === false) throw new Error('not portable');
      if (server.needs_setup) throw new Error('needs manual setup');
      const secrets = server.secrets === undefined ? [] : server.secrets;
      if (!Array.isArray(secrets) || secrets.some(s => typeof s !== 'string' || !variable.test(s))) {
        throw new Error('invalid secret variable names');
      }
      const missing = secrets.filter(s => !present(env, s));
      if (missing.length) throw new Error(`secrets missing: ${missing.join(', ')}`);
      const type = mcpTransport(server);
      const saved = { name, type, secrets: [...secrets] };
      if (type === 'stdio') {
        if (server.url || Object.keys(server.headers ?? {}).length) throw new Error('HTTP fields on a stdio server');
        const command = resolvePublicMcpValue(server.command, env, secrets);
        if (!command.trim()) throw new Error('empty command');
        const args = (server.args ?? []).map(v => resolvePublicMcpValue(v, env, secrets));
        const values = Object.create(null), refs = Object.create(null), templates = Object.create(null);
        for (const [key, value] of Object.entries(strings(server.env ?? {}))) {
          if (!targetVariable.test(key)) throw new Error('invalid destination variable name');
          const match = value.match(reference);
          if (match) {
            const source = match[1];
            const fallback = secrets.includes(source) ? undefined : match[2];
            if (fallback !== undefined) assertNoMcpSecret(fallback, env, secrets);
            if (!present(env, source) && fallback === undefined) throw new Error(`environment variable missing: ${source}`);
            refs[key] = { source, ...(fallback !== undefined ? { fallback } : {}) };
            templates[key] = fallback === undefined ? `\${${source}}` : `\${${source}:-${fallback}}`;
          } else {
            if (value.includes('${')) throw new Error('unsupported stdio environment expression');
            if (secrets.includes(key) || /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:$|_)/i.test(key)) {
              throw new Error(`inline credential forbidden: ${key}`);
            }
            values[key] = assertNoMcpSecret(value, env, secrets); templates[key] = value;
          }
        }
        const sources = [...new Set([...secrets, ...Object.values(refs).map(r => r.source)])];
        const needsLauncher = Object.entries(refs).some(([key, r]) => key !== r.source || r.fallback !== undefined);
        if (needsLauncher && !launcherFile) throw new Error('stdio remapping requires the managed launcher');
        mcp[name] = needsLauncher ? { command: nodePath,
          args: [launcherFile, JSON.stringify({ command, args, refs, required: secrets })], env_vars: sources }
          : { command, args, env_vars: sources };
        if (Object.keys(values).length) mcp[name].env = values;
        Object.assign(saved, { command, args, env: templates });
      } else if (type === 'http') {
        if (server.command || (server.args ?? []).length || Object.keys(server.env ?? {}).length) {
          throw new Error('stdio fields on an HTTP server');
        }
        const url = resolvePublicMcpValue(server.url, env, secrets);
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
          throw new Error('invalid HTTP URL or inline URL credentials');
        }
        const headers = strings(server.headers ?? {}), literals = Object.create(null), references = Object.create(null);
        const entry = { url };
        for (const [key, value] of Object.entries(headers)) {
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) throw new Error('invalid header name');
          const bearer = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/i.exec(value);
          const direct = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
          if (key.toLowerCase() === 'authorization' && bearer) {
            if (!present(env, bearer[1])) throw new Error(`environment variable missing: ${bearer[1]}`);
            entry.bearer_token_env_var = bearer[1];
          } else if (direct) {
            if (!present(env, direct[1])) throw new Error(`environment variable missing: ${direct[1]}`);
            references[key] = direct[1];
          } else {
            if (value.includes('${') || key.toLowerCase() === 'authorization') throw new Error('unrepresentable HTTP authentication header');
            if (/[\r\n]/.test(value)) throw new Error('invalid header value');
            literals[key] = assertNoMcpSecret(value, env, secrets);
          }
        }
        if (Object.keys(literals).length) entry.http_headers = literals;
        if (Object.keys(references).length) entry.env_http_headers = references;
        mcp[name] = entry;
        Object.assign(saved, { url, headers: { ...headers } });
      } else throw new Error('unsupported transport');
      servers.push(saved);
    } catch (e) { skipped.push(name); reasons[name] = e.message; }
  }
  return { mcp, registered: Object.keys(mcp), skipped, reasons,
    manifest: { schema_version: 1, servers }, override: `mcp_servers=${codexMcpToml(mcp)}`,
    overrides: Object.entries(mcp).map(([name, entry]) => `mcp_servers.${overrideName(name)}=${codexMcpToml(entry)}`) };
}
