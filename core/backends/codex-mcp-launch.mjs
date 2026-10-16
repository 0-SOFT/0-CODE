// Kept in the managed home. Stdio credentials are remapped only for this server.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliLaunch } from './cli-launch.mjs';

export function mcpServerEnvironment(spec, env) {
  if (!spec || typeof spec.command !== 'string' || !spec.command.trim()
    || !Array.isArray(spec.args) || spec.args.some(s => typeof s !== 'string')
    || !spec.refs || typeof spec.refs !== 'object' || Array.isArray(spec.refs)
    || !Array.isArray(spec.required) || spec.required.some(s => typeof s !== 'string')) {
    throw new Error('Invalid MCP launcher specification');
  }
  const present = name => typeof env[name] === 'string' && env[name].trim() !== '';
  for (const name of spec.required) if (!present(name)) throw new Error(`MCP secret missing: ${name}`);
  const result = Object.assign(Object.create(null), env);
  for (const [key, ref] of Object.entries(spec.refs)) {
    if (!/^[A-Za-z0-9_]+$/.test(key) || !ref || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.source)
      || (ref.fallback !== undefined && typeof ref.fallback !== 'string')) {
      throw new Error('Invalid MCP environment reference');
    }
    if (!present(ref.source) && ref.fallback === undefined) throw new Error(`MCP environment variable missing: ${ref.source}`);
    result[key] = present(ref.source) ? env[ref.source] : ref.fallback;
  }
  return result;
}

export function launchMcp(spec, { env = process.env, launch = spawn } = {}) {
  const serverEnv = mcpServerEnvironment(spec, env);
  const command = resolveCliLaunch(spec.command, spec.args, { env: serverEnv });
  const child = launch(command.command, command.args, { env: serverEnv,
    shell: false, stdio: 'inherit', windowsHide: true });
  const handlers = new Map();
  const detach = () => { for (const [signal, handler] of handlers) process.removeListener(signal, handler); };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => { child.kill(signal); };
    handlers.set(signal, handler); process.once(signal, handler);
  }
  child.once('error', () => { detach(); process.stderr.write('MCP server could not be started\n'); process.exitCode = 1; });
  child.once('exit', (code) => { detach(); process.exitCode = Number.isInteger(code) ? code : 1; });
  return child;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { launchMcp(JSON.parse(process.argv[2])); }
  catch { process.stderr.write('MCP launcher configuration or environment is invalid\n'); process.exitCode = 1; }
}
