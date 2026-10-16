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
//
// v1.10.0 made that last sentence true. It had been false for the one case that matters: a MISSPELT
// AGENT_BACKEND overrode nothing — the value failed the supported-list test quietly and step 3 took
// over, so `AGENT_BACKEND=opencodee` ran Claude without a word. Now a value that is set but not
// supported is refused rather than ignored; only an unset variable reaches auto-detection.

import { ClaudeBackend } from './backends/claude.mjs';
import { OpenCodeBackend } from './backends/opencode.mjs';
import { CodexBackend } from './backends/codex.mjs';

const SUPPORTED = ['claude', 'opencode', 'codex'];

export function autodetectBackendId(env = process.env) {
  // v1.10.0. This used to read `if (AGENT_BACKEND && SUPPORTED.includes(...)) return it` — so a
  // typo failed the test QUIETLY and fell through to auto-detection. Setting AGENT_BACKEND=opencodee
  // got you Claude: a different engine, a different price, a different behaviour, and not a word
  // anywhere. The comment at the top of this file promised that an explicit AGENT_BACKEND always
  // overrides; for a typo it overrode nothing.
  //
  // Why this refuses instead of warning, unlike SAFETY_GUARD_MODE which keeps its safe default:
  // there is no safe default for "which engine". Falling back is not degrading gracefully, it is
  // silently running a different product. getBackend() has always thrown on an unknown explicit id;
  // the same mistake now gets the same answer wherever it arrives from.
  if (env.AGENT_BACKEND) {
    if (SUPPORTED.includes(env.AGENT_BACKEND)) return env.AGENT_BACKEND;
    throw new Error(
      `Unknown AGENT_BACKEND="${env.AGENT_BACKEND}". Supported: ${SUPPORTED.join(', ')}. ` +
      'Unset the variable to fall back to auto-detection.');
  }
  // Claude Code environment markers.
  if (env.CLAUDECODE || env.CLAUDE_PLUGIN_ROOT || env.CLAUDE_PROJECT_DIR) return 'claude';
  // OpenCode markers (v1.3.0).
  if (env.OPENCODE || env.OPENCODE_SERVER_PASSWORD) return 'opencode';
  return 'claude';
}

export function getBackend(id, { env = process.env, envFiles } = {}) {
  const backendId = id || autodetectBackendId(env);
  switch (backendId) {
    case 'claude':
      return new ClaudeBackend({ env, envFiles });
    case 'opencode':
      return new OpenCodeBackend({ env, envFiles });
    case 'codex':
      return new CodexBackend({ env, envFiles });
    default:
      throw new Error(`Unknown AGENT_BACKEND="${backendId}". Supported: ${SUPPORTED.join(', ')}.`);
  }
}

export { SUPPORTED as SUPPORTED_BACKENDS };
