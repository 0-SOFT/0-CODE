import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateMcpInputs } from './mcp-input.mjs';
import { objectConfig, readJsonConfig, writeJsonConfig } from '../../lib/json-config.mjs';

// The documented user-scope registry is the same file the CLI writes. Private fields travel
// directly to that file, never as a `claude mcp add-json` positional argument.
export function registerClaudeMcp(manifest, env = process.env, { configFile, dryRun = false } = {}) {
  const generated = generateMcpInputs(manifest, env);
  const file = configFile ?? (env.CLAUDE_CONFIG_DIR ? join(resolve(env.CLAUDE_CONFIG_DIR), '.claude.json')
    : join(homedir(), '.claude.json'));
  const config = readJsonConfig(file);
  if (config.mcpServers !== undefined && !objectConfig(config.mcpServers)) throw new Error('Invalid Claude mcpServers, original preserved');
  const mcp = { ...(config.mcpServers ?? {}) }, registered = [], skipped = [...generated.skipped];
  const reasons = Object.assign(Object.create(null), generated.reasons);
  for (const [name, entry] of Object.entries(generated.entries)) {
    if (Object.hasOwn(mcp, name)) { skipped.push(name); reasons[name] = 'already registered'; continue; }
    Object.defineProperty(mcp, name, { value: entry, enumerable: true, configurable: true, writable: true });
    registered.push(name);
  }
  if (!dryRun && registered.length) writeJsonConfig(file, { ...config, mcpServers: mcp });
  return { registered, skipped, reasons, file, dryRun };
}
