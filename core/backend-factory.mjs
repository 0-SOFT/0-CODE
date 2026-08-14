// core/backend-factory.mjs — picks the execution backend from an EXPLICIT flag (KISS, no magic).
//
// v0.8.0, Phase 1. Where the choice comes from, in priority order:
//   1) the getBackend(id) argument
//   2) process.env.AGENT_BACKEND  (claude | opencode) ← the main, explicit switch
//   3) environment auto-detection, used only as a DEFAULT hint  ← a default, not a router
//   4) 'claude'                                                 ← safe fallback
//
// Auto-detection is deliberately minimal: if a Claude Code environment marker is present, the
// answer is 'claude'. The goal is not clever guessing but a sensible default that an explicit
// AGENT_BACKEND always overrides.

import { ClaudeBackend } from './backends/claude.mjs';
import { OpenCodeBackend } from './backends/opencode.mjs';

const SUPPORTED = ['claude', 'opencode'];

export function autodetectBackendId(env = process.env) {
  if (env.AGENT_BACKEND && SUPPORTED.includes(env.AGENT_BACKEND)) return env.AGENT_BACKEND;
  // Claude Code environment markers.
  if (env.CLAUDECODE || env.CLAUDE_PLUGIN_ROOT || env.CLAUDE_PROJECT_DIR) return 'claude';
  // OpenCode markers (v1.3.0).
  if (env.OPENCODE || env.OPENCODE_SERVER_PASSWORD) return 'opencode';
  return 'claude';
}

export function getBackend(id, { env = process.env } = {}) {
  const backendId = id || autodetectBackendId(env);
  switch (backendId) {
    case 'claude':
      return new ClaudeBackend();
    case 'opencode':
      return new OpenCodeBackend();
    default:
      throw new Error(`Unknown AGENT_BACKEND="${backendId}". Supported: ${SUPPORTED.join(', ')}.`);
  }
}

export { SUPPORTED as SUPPORTED_BACKENDS };
