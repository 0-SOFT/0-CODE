import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeModel, presetFromEnv, OPENROUTER_PRESET, presetForBackend, KIMI_PRESET } from '../../core/model-routing.mjs';

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
test('presetForBackend: opencode gets the Kimi models, the rest keep the originals', () => {
  const kimi = presetForBackend('opencode', {});
  assert.match(kimi.high, /kimi-k2/, 'the default is the cheap model proven by measurement, not k3');
  assert.match(kimi.mid, /kimi-k2\.7-code/);
  assert.match(kimi.smoke, /:free$/, 'smoke checks must be free of charge');
  assert.notEqual(presetForBackend('claude', {}).high, kimi.high);
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
