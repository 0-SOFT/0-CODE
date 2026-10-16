// The host owns security settings. Per-turn options cannot add unvetted hook sources.
import { isAbsolute } from 'node:path';
import { resolveMode, ALLOW_ALL } from '../permission-decision.mjs';
import { codexMcpToml } from './codex-mcp.mjs';

export function validateCodexRuntimeOptions({ sandbox, ignoreUserConfig, bypassHookTrust, config = [],
  guardEnabled = true } = {}) {
  if (sandbox !== undefined && !['danger-full-access', 'workspace-write', 'read-only'].includes(sandbox)) {
    throw new Error('Invalid Codex sandbox');
  }
  if (guardEnabled && bypassHookTrust === false) throw new Error('Invalid Codex option: verified framework hooks must run');
  if (!Array.isArray(config) || config.some(value => typeof value !== 'string'
    || /[\r\n\0]/.test(value) || !/^\s*[^=]+\s*=/.test(value))) {
    throw new Error('Codex config overrides must be single-line key=value strings');
  }
  for (const value of config) {
    const key = value.slice(0, value.indexOf('=')).trim().replace(/["']/g, '');
    if (guardEnabled && /^(?:hooks(?:\.|$)|features\.hooks(?:\.|$)|rules(?:\.|$)|execpolicy(?:\.|$))/.test(key)) {
      throw new Error('Invalid Codex option: cannot replace framework hooks or rules while its guard is enabled');
    }
  }
  return [...config];
}

export function buildCodexConfiguration({ project, writableRoots = [], platform = process.platform,
  sandbox = 'danger-full-access', instructionBytes = 0, instructionsMaxBytes,
  hooks, mcpOverride, mcpOverrides = [], env = process.env, inheritInstructionBudget = false } = {}) {
  if (typeof project !== 'string' || !isAbsolute(project)) throw new Error('Invalid Codex project path');
  if (!Array.isArray(writableRoots) || writableRoots.some(root => typeof root !== 'string' || !isAbsolute(root))) {
    throw new Error('Invalid Codex writable roots');
  }
  // A CLI dotted key cannot quote path segments; the complete TOML map keeps dots/spaces literal.
  const projectTrust = `projects=${codexMcpToml({[project]:{trust_level:'untrusted'}})}`;
  const roots = [...new Set(writableRoots)];
  const guardEnabled = resolveMode(env).mode !== ALLOW_ALL;
  if (!['danger-full-access', 'workspace-write', 'read-only'].includes(sandbox)) throw new Error('Invalid Codex sandbox');
  const docBytes = instructionsMaxBytes ?? Math.max(32768, instructionBytes);
  const entries = [
    ...(!inheritInstructionBudget ? [`project_doc_max_bytes=${docBytes}`] : []),
    ...(sandbox !== 'danger-full-access' ? [
      'default_permissions="framework"',
      `permissions.framework.filesystem={":root"="read", ":workspace_roots"={"."=${JSON.stringify(sandbox === 'read-only' ? 'read' : 'write')}}}`,
      'permissions.framework.network.enabled=true',
      `permissions.framework.workspace_roots={${roots.map(root => `${JSON.stringify(root)}=true`).join(', ')}}`,
      projectTrust,
      ...(platform === 'win32' ? ['windows.sandbox="unelevated"'] : []),
    ] : []),
    ...(mcpOverride ? [mcpOverride] : []),
    ...mcpOverrides,
    ...(guardEnabled ? ['features.hooks=true', 'features.unified_exec=false', 'features.unified_exec_tty=false',
      ...(hooks ? [`hooks.PreToolUse=${codexMcpToml(hooks.hooks.PreToolUse)}`] : [])] : []),
  ];
  return { content: entries.join('\n') + '\n', overrides: entries };
}
