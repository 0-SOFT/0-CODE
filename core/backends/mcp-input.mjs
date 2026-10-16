// Public executable fields and private environment/header fields have different contracts.
import { isCloudMcpMode, isOwnerTelegramMcp, CLOUD_MCP_REFUSAL } from '../../lib/cloud-mcp-policy.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const variable = /^[A-Za-z_][A-Za-z0-9_]*$/;
const targetVariable = /^[A-Za-z0-9_]+$/;
const present = (env, key) => typeof env[key] === 'string' && env[key].trim() !== '';
const reference = /\$\{([A-Za-z_][\w]*)(?::-([^}]*))?\}/g;

export function validateMcpSource(source) {
  if (source !== undefined && (typeof source !== 'string' || !source.trim())) throw new Error('invalid source metadata');
  if (source === 'claude_ai') throw new Error('a claude.ai connector');
}

export function mcpTransport(server) {
  if (server.type !== undefined) {
    if (typeof server.type !== 'string') throw new Error('unsupported transport');
    return server.type;
  }
  return server.url && !server.command ? 'http' : 'stdio';
}

function substituteRequired(value, env, checkReference = () => {}) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('invalid MCP value');
  if (value.replace(reference, '').includes('${')) throw new Error('unsupported environment expression');
  return value.replace(reference, (_, key, fallback) => {
    checkReference(key);
    if (fallback?.includes('${')) throw new Error('unsupported environment expression');
    if (present(env, key)) return env[key];
    if (fallback !== undefined) return fallback;
    throw new Error('environment variable missing: ' + key);
  });
}

export function assertNoMcpSecret(value, env, secrets) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('invalid command, argument or URL');
  if (secrets.some(key => present(env, key) && value.includes(env[key]))) {
    throw new Error('secret cannot appear in a command, argument, URL or persisted literal');
  }
  return value;
}

export function resolvePublicMcpValue(value, env, secrets) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('invalid command, argument or URL');
  const result = substituteRequired(value, env, key => {
    if (secrets.includes(key)) throw new Error('secret cannot appear in a command, argument or URL');
  });
  if (result.includes('${')) throw new Error('unsupported environment expression');
  return assertNoMcpSecret(result, env, secrets);
}

export function substituteEnv(str, env) {
  return String(str).replace(/\$\{([A-Za-z_][\w]*)(?::-([^}]*))?\}/g, (_, key, fallback) =>
    (env[key] !== undefined && env[key] !== '') ? env[key] : (fallback ?? ''));
}

export function resolveMcpInput(server, env = process.env) {
  if (!record(server) || typeof server.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(server.name)) throw new Error('invalid server name');
  if (isCloudMcpMode(env) && isOwnerTelegramMcp(server)) throw new Error(CLOUD_MCP_REFUSAL);
  validateMcpSource(server.source);
  if (server.needs_setup) throw new Error('needs manual setup');
  if (server.portable === false) throw new Error('not portable');
  if (['portable', 'needs_setup'].some(key => server[key] !== undefined && typeof server[key] !== 'boolean')) throw new Error('invalid setup or portability flag');
  if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(value => typeof value !== 'string'))) throw new Error('expected a string argument array');
  const secrets = server.secrets ?? [];
  if (!Array.isArray(secrets) || secrets.some(key => typeof key !== 'string' || !variable.test(key))) throw new Error('invalid secret names');
  const missing = secrets.filter(key => !present(env, key));
  if (missing.length) throw new Error('secrets missing: ' + missing.join(', '));
  const publicValue = value => resolvePublicMcpValue(value, env, secrets);
  const mapping = (values = {}, headers = false) => {
    if (!record(values)) throw new Error('expected a string mapping');
    return Object.fromEntries(Object.entries(values).map(([key, value]) => {
      if (typeof value !== 'string' || value.includes('\0') || (headers ? !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) : !targetVariable.test(key))) {
        throw new Error('invalid environment or header field');
      }
      const result = substituteRequired(value, env);
      if (result.includes('\0')) throw new Error('invalid environment or header value');
      if (headers && /[\r\n]/.test(result)) throw new Error('invalid header value');
      return [key, result];
    }));
  };
  const type = mcpTransport(server);
  if (['http', 'sse', 'remote'].includes(type)) {
    if (env.CLAUDE_CODE_REMOTE === 'true') throw new Error('remote server in a cloud session — use a claude.ai connector');
    if (server.command || (server.args ?? []).length || Object.keys(server.env ?? {}).length) throw new Error('stdio fields on a remote server');
    const url = publicValue(server.url), parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('invalid HTTP URL or inline credentials');
    const headers = mapping(server.headers, true);
    return { name: server.name, type: type === 'sse' ? 'sse' : 'http', url,
      ...(Object.keys(headers).length ? { headers } : {}) };
  }
  if (type !== 'stdio') throw new Error('unsupported transport');
  if (server.url || Object.keys(server.headers ?? {}).length) throw new Error('HTTP fields on a stdio server');
  const command = publicValue(server.command);
  if (!command.trim()) throw new Error('empty command');
  return { name: server.name, type: 'stdio', command, args: (server.args ?? []).map(publicValue), env: mapping(server.env) };
}

export function generateMcpInputs(manifest, env = process.env) {
  if (!record(manifest) || !Array.isArray(manifest.servers)
    || (manifest.schema_version !== undefined && manifest.schema_version !== 1)) throw new Error('Invalid MCP manifest');
  const entries = Object.create(null), reasons = Object.create(null), skipped = [];
  const counts = new Map();
  for (const server of manifest.servers) counts.set(server?.name, (counts.get(server?.name) || 0) + 1);
  for (const server of manifest.servers) {
    const name = typeof server?.name === 'string' ? server.name : '<unnamed>';
    try {
      if (counts.get(server?.name) > 1) throw new Error('duplicate server name');
      const input = resolveMcpInput(server, env); delete input.name;
      entries[name] = input;
    } catch (error) { skipped.push(name); reasons[name] = error.message; }
  }
  return { entries, registered: Object.keys(entries), skipped, reasons };
}
