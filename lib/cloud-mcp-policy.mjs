// The cloud policy excludes user-account Telegram before resolving credentials.
const ownerVariable = /^(?:TELEGRAM_SESSION_STRING|TELEGRAM_API_ID|TELEGRAM_API_HASH)$/i;
const ownerReference = /(?:^|[^A-Za-z0-9_])(?:TELEGRAM_SESSION_STRING|TELEGRAM_API_ID|TELEGRAM_API_HASH)(?:$|[^A-Za-z0-9_])/i;
const ownerCommand = /(?:^|[^A-Za-z0-9])telegram-mcp(?:$|[^A-Za-z0-9])/i;
const botReference = /(?:^|[^A-Za-z0-9_])(?:TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)(?:$|[^A-Za-z0-9_])/i;
export const CLOUD_MCP_REFUSAL = 'user-account Telegram is excluded in cloud mode';

export function isCloudMcpMode(env = process.env) { return env.FRAMEWORK_CLOUD_MODE === '1'; }
export function isOwnerTelegramVariable(name) { return ownerVariable.test(name); }

function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, entry]) => [key, ...strings(entry)]);
  return [];
}

export function isOwnerTelegramMcp(server, name = server?.name) {
  const values = strings({ command: server?.command, args: server?.args, env: server?.env,
    url: server?.url, headers: server?.headers, secrets: server?.secrets,
    npm_package: server?.npm_package, repo: server?.repo });
  if (values.some(value => ownerReference.test(value) || ownerCommand.test(value))) return true;
  const telegramName = /telegram/i.test(String(name || ''));
  // The notification bot is a separate integration; its name can contain Telegram.
  return telegramName && !values.some(value => botReference.test(value));
}

export function cloudMcpManifest(manifest, cloudMode = true) {
  if (!cloudMode) return manifest;
  return { ...manifest, servers: (manifest?.servers || []).filter(server => !isOwnerTelegramMcp(server)) };
}

export function withoutOwnerTelegramEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !ownerVariable.test(name)));
}
