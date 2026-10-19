// A session overlay grants no project-native Claude write locations.
import { projectRelativePath } from './project-config.mjs';

export const isIsolatedClaude = config => Boolean(config.engines?.includes('claude')
  && config.instructions?.claude === 'session-hook'
  && config.instructions?.claude_settings === '.0-code/claude/settings.json');

export function projectAllowedPaths(config, { relocation } = {}) {
  if (!isIsolatedClaude(config)) return null;
  const paths = [{ path: '.0-code', recursive: true }];
  const allow = (path, recursive = false) => paths.push({ path: projectRelativePath(path, { allowFramework: true }), recursive });
  // File roles authorize those files, never their surrounding document directories.
  for (const document of Object.values(config.documents || {})) if (!document.name) allow(document.path);
  if (config.engines.includes('codex')) {
    allow('AGENTS.md');allow('.agents/skills', true);allow('.codex/agents', true);allow('.codex/config.toml');
  }
  if (config.engines.includes('opencode')) {
    allow('AGENTS.md');allow('.agents/skills', true);allow('.opencode/agents', true);allow('.opencode/commands', true);
    allow('.opencode/plugins/0-code-safety-guard.js');allow('opencode.json');allow('opencode.jsonc');
  }
  // Only reviewed relocation entries authorize removal of their external sources.
  for (const path of relocation?.files || []) allow(path);
  for (const move of relocation?.moves || []) { allow(move.from);allow(move.to); }
  for (const update of relocation?.updates || []) allow(update.to);
  for (const path of relocation?.cycleLockPaths || []) allow(path);
  return paths;
}
