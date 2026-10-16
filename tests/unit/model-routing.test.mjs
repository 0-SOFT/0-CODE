import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeModel, presetFromEnv, OPENROUTER_PRESET, presetForBackend, KIMI_PRESET, CODEX_PRESET, codexTurnPreset } from '../../core/model-routing.mjs';

test('routeModel: tiers by step type', () => {
  assert.equal(routeModel('research'), OPENROUTER_PRESET.high);
  assert.equal(routeModel('architecture'), OPENROUTER_PRESET.high);
  assert.equal(routeModel('audit'), OPENROUTER_PRESET.high);
  assert.equal(routeModel('plan'), OPENROUTER_PRESET.high);
  assert.equal(routeModel('implement'), OPENROUTER_PRESET.mid);
  assert.equal(routeModel('test'), OPENROUTER_PRESET.mid);
  assert.equal(routeModel('format'), OPENROUTER_PRESET.low);
  assert.equal(routeModel('lookup'), OPENROUTER_PRESET.low);
  assert.equal(routeModel('smoke'), OPENROUTER_PRESET.smoke);
});

test('routeModel: an unknown step → mid', () => {
  assert.equal(routeModel('somethingelse'), OPENROUTER_PRESET.mid);
  assert.equal(routeModel(undefined), OPENROUTER_PRESET.mid);
});

test('routeModel: a custom preset overrides', () => {
  const preset = { high: 'H', mid: 'M', low: 'L', smoke: 'S' };
  assert.equal(routeModel('research', preset), 'H');
  assert.equal(routeModel('implement', preset), 'M');
  assert.equal(routeModel('smoke', preset), 'S');
});

test('presetFromEnv: overridden from env, default otherwise', () => {
  const p = presetFromEnv({ OPENROUTER_MODEL_HIGH: 'my-high', OPENROUTER_MODEL_SMOKE: 'my-smoke' });
  assert.equal(p.high, 'my-high');
  assert.equal(p.smoke, 'my-smoke');
  assert.equal(p.mid, OPENROUTER_PRESET.mid);   // not set → default
  assert.equal(p.low, OPENROUTER_PRESET.low);
});

test('presetFromEnv: an empty env → the full default', () => {
  assert.deepEqual(presetFromEnv({}), OPENROUTER_PRESET);
});

// v1.3.0: the Kimi preset — the expensive model only for thinking, routine work on the cheap one.
test('presetForBackend: an unset route preserves each engine own model configuration', () => {
  for (const id of ['codex', 'claude', 'opencode']) {
    const preset = presetForBackend(id, {});
    for (const step of ['research', 'implement', 'smoke']) assert.equal(routeModel(step, preset), undefined);
  }
  assert.match(KIMI_PRESET.mid, /kimi-k2\.7-code/); // Named presets remain available for explicit selection.
});

test('presetForBackend: environment overrides are preserved', () => {
  const p = presetForBackend('opencode', { OPENROUTER_MODEL_HIGH: 'own/model' });
  assert.equal(p.high, 'own/model');
});

test('routeModel with the Kimi preset: thinking costs more than routine work', () => {
  const p = presetForBackend('opencode', {});
  assert.equal(routeModel('research', p), p.high);
  assert.equal(routeModel('implement', p), p.mid);
  assert.equal(routeModel('smoke', p), p.smoke);
});

test('Codex routes and named presets never insert an effort or a default model', () => {
  const preset = presetForBackend('codex', {});
  for (const step of ['implement', 'execute', 'test', 'docs', 'research', 'audit', 'unknown', undefined]) {
    assert.equal(routeModel(step, preset), undefined, String(step));
  }
  for (const step of ['format', 'lookup', 'routine', 'smoke']) {
    assert.equal(routeModel(step, preset), undefined, step);
  }
  assert.equal(CODEX_PRESET.mid, 'gpt-6.1-sol');
  assert.deepEqual(codexTurnPreset(), {});
  assert.deepEqual(codexTurnPreset('gpt-6-luna'), { model: 'gpt-6-luna' });
  assert.deepEqual(codexTurnPreset('owner-model'), { model: 'owner-model' });
});
