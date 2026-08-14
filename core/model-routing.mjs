// core/model-routing.mjs — routes models by step type (agent-independent, pure).
//
// v0.8.1, Phase 2. An adaptation of the cost-aware LLM pipeline idea to different providers
// (OpenRouter): the expensive model handles orchestration, architecture and audits; the mid-tier
// one handles execution; the cheap one handles routine work and smoke checks. The supervisor
// passes the selected model into Backend.runTurn({model}).
//
// NOTE: OpenRouter model ids change over time — this is a DEFAULT preset, overridable through
// config/.env (OPENROUTER_MODEL_HIGH/MID/LOW) or by argument. Check openrouter.ai/models.

export const OPENROUTER_PRESET = {
  high: 'anthropic/claude-opus-4.1',     // orchestration, architecture, audits, hard research
  mid: 'anthropic/claude-sonnet-4.6',    // routine step execution
  low: 'deepseek/deepseek-chat',         // routine work, formatting, cheap checks
  smoke: 'deepseek/deepseek-chat',       // cheap/free for smoke runs (prefer a :free variant)
};

// Preset for the OpenCode backend on Kimi models (v1.3.0). Research measurement: EVERY step costs
// about 24,700 input tokens (system prompt plus tool schemas), so the price gap between K3 and
// K2.7-code yields more than a fourfold saving on routine work.
//   kimi-k3        — $3/$15 per million, 1,048,576 context → thinking (research, architecture)
//   kimi-k2.7-code — $0.7/$3.5, 262,144 context            → doing (routine edits, tests)
// These values were chosen BY MEASUREMENT during the v1.3.0 acceptance run, not by model name:
// `kimi-k2.7-code` passed acceptance twice (found a real bug in the source, fixed it, committed,
// left the test untouched) in 155 and 227 seconds at about $0.35 per run. `kimi-k2.6` also passed
// but took twice as long. The expensive `kimi-k3` is NOT enabled by default: the measurement
// showed no need for it. If you want it, set OPENROUTER_MODEL_HIGH — no code changes required.
export const KIMI_PRESET = {
  high: 'moonshotai/kimi-k2.7-code',
  mid: 'moonshotai/kimi-k2.7-code',
  low: 'moonshotai/kimi-k2.6',
  smoke: 'cohere/north-mini-code:free',   // free — smoke checks at no cost
};

// Preset by backend id: OpenCode has its own models, everything else keeps the original set.
export function presetForBackend(backendId, env = process.env) {
  const base = backendId === 'opencode' ? KIMI_PRESET : OPENROUTER_PRESET;
  return {
    high: env.OPENROUTER_MODEL_HIGH || base.high,
    mid: env.OPENROUTER_MODEL_MID || base.mid,
    low: env.OPENROUTER_MODEL_LOW || base.low,
    smoke: env.OPENROUTER_MODEL_SMOKE || base.smoke,
  };
}

// Step classes → model tier.
const STEP_LEVEL = {
  research: 'high', architecture: 'high', audit: 'high', plan: 'high',
  implement: 'mid', execute: 'mid', test: 'mid', docs: 'mid',
  format: 'low', lookup: 'low', routine: 'low', smoke: 'smoke',
};

// Return the model id for a step type. `preset` overrides the default (e.g. from .env).
export function routeModel(stepType, preset = OPENROUTER_PRESET) {
  const level = STEP_LEVEL[stepType] || 'mid';
  return preset[level] || preset.mid;
}

// Build a preset from env (OPENROUTER_MODEL_HIGH/MID/LOW/SMOKE), falling back to the default.
export function presetFromEnv(env = process.env) {
  return {
    high: env.OPENROUTER_MODEL_HIGH || OPENROUTER_PRESET.high,
    mid: env.OPENROUTER_MODEL_MID || OPENROUTER_PRESET.mid,
    low: env.OPENROUTER_MODEL_LOW || OPENROUTER_PRESET.low,
    smoke: env.OPENROUTER_MODEL_SMOKE || OPENROUTER_PRESET.smoke,
  };
}
