import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeBackend, OPENCODE_CONFIG_FILE } from '../../core/backends/opencode.mjs';
import { buildPermissionsBlock } from '../../core/permissions-policy.mjs';

function tmp() { return mkdtempSync(join(tmpdir(), 'opencode-')); }
const readCfg = d => JSON.parse(readFileSync(join(d, OPENCODE_CONFIG_FILE), 'utf8'));

test('applyPermissions → opencode.json carrying denials from the shared policy', async () => {
  const d = tmp();
  try {
    const r = await new OpenCodeBackend().applyPermissions({ policy: buildPermissionsBlock(), targetDir: d });
    const cfg = readCfg(d);
    assert.equal(r.applied, true, 'the OpenCode mechanism genuinely works — we state the truth');
    assert.deepEqual(r.dropped, [], 'no rule may be lost in translation');
    assert.equal(cfg.permission.bash['*'], 'allow');
    const denials = Object.entries(cfg.permission.bash).filter(([, v]) => v === 'deny');
    assert.ok(denials.length >= 5, `there must be several denials, got ${denials.length}`);
    assert.ok(denials.some(([k]) => k.startsWith('rm -rf /')));
    assert.ok(denials.some(([k]) => k.startsWith('git push --force')));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('applyPermissions preserves unrelated configuration keys', async () => {
  const d = tmp();
  try {
    writeFileSync(join(d, OPENCODE_CONFIG_FILE), JSON.stringify({ model: 'own/model', instructions: ['x.md'] }));
    await new OpenCodeBackend().applyPermissions({ policy: buildPermissionsBlock(), targetDir: d });
    const cfg = readCfg(d);
    assert.equal(cfg.model, 'own/model', 'unrelated settings must not be overwritten');
    assert.deepEqual(cfg.instructions, ['x.md']);
    assert.ok(cfg.permission, 'our block was added');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('installInstructions → AGENTS.md', async () => {
  const d = tmp();
  try {
    const r = await new OpenCodeBackend().installInstructions({ targetDir: d, content: 'LOOP RULES' });
    assert.equal(readFileSync(join(d, 'AGENTS.md'), 'utf8'), 'LOOP RULES');
    assert.ok(r.written[0].endsWith('AGENTS.md'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('registerMcp → an mcp block in opencode.json, non-portable servers skipped', async () => {
  const d = tmp();
  try {
    const manifest = { servers: [
      { name: 'a', command: 'cmd', args: ['${X}'], env: { K: '${Y}' } },
      { name: 'connector', source: 'claude_ai' },
      { name: 'ns', needs_setup: true },
    ] };
    const r = await new OpenCodeBackend().registerMcp(manifest, { X: 'xx', Y: 'yy' }, { targetDir: d });
    const cfg = readCfg(d);
    assert.deepEqual(r.registered, ['a']);
    assert.ok(r.skipped.includes('connector') && r.skipped.includes('ns'));
    assert.deepEqual(cfg.mcp.a.command, ['cmd', 'xx']);
    assert.equal(cfg.mcp.a.environment.K, 'yy');
    assert.equal(cfg.mcp.connector, undefined);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('guardCommand and id: the Backend port contract is honoured', async () => {
  const b = new OpenCodeBackend();
  assert.equal(b.id, 'opencode');
  assert.ok(b.guardCommand('rm -rf /'));
  assert.equal(b.guardCommand('git status'), null);
  const r = await b.runTurn({ prompt: '' });
  assert.equal(r.ok, false, 'an empty prompt is an honest error, not a process launch');
});

// Found by the LIVE v1.3.0 acceptance run: the agent ran `git clean -fd .` — an ordinary cleanup —
// and wiped the untracked opencode.json and the arbiter plugin, i.e. it disarmed itself and kept
// working. Protection that can be silently deleted is not protection.
test('ensureReady restores a wiped arbiter plugin', async () => {
  const d = tmp();
  try {
    const b = new OpenCodeBackend();
    await b.ensureReady({ cwd: d });                       // the initial install
    const plugin = join(d, '.opencode', 'plugins', 'safety-guard.js');
    assert.ok(existsSync(plugin), 'the plugin must appear');
    rmSync(plugin);                                        // simulate `git clean -fd`
    const r = await b.ensureReady({ cwd: d });
    assert.ok(existsSync(plugin), 'the plugin must be restored before the turn');
    assert.ok(r.restored.some(x => x.includes('safety-guard')));
    const text = readFileSync(plugin, 'utf8');
    assert.match(text, /destructiveReason/, 'the rules come from the shared detector');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('ensureReady restores a wiped permission configuration', async () => {
  const d = tmp();
  try {
    const b = new OpenCodeBackend();
    await b.ensureReady({ cwd: d });
    rmSync(join(d, OPENCODE_CONFIG_FILE));
    const r = await b.ensureReady({ cwd: d });
    const cfg = JSON.parse(readFileSync(join(d, OPENCODE_CONFIG_FILE), 'utf8'));
    assert.equal(cfg.permission.bash['*'], 'allow');
    assert.ok(Object.values(cfg.permission.bash).includes('deny'), 'the denials must come back');
    assert.ok(r.restored.some(x => x.includes(OPENCODE_CONFIG_FILE)));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('ensureReady is idempotent: it touches nothing when everything is in place', async () => {
  const d = tmp();
  try {
    const b = new OpenCodeBackend();
    await b.ensureReady({ cwd: d });
    const r = await b.ensureReady({ cwd: d });
    assert.deepEqual(r.restored, [], 'a repeated call must restore nothing');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// The v1.4.0 audit caught two holes at once: the agent deleted the plugin FROM THE PROJECT and
// rewrote the permission.bash values to allow while leaving the block itself in place — the old
// check missed that because it looked at the presence of the block rather than its contents.
test('ensureReady installs the plugin GLOBALLY — beyond the reach of the agent', async () => {
  const d = tmp(); const home = tmp();
  try {
    const r = await new OpenCodeBackend().ensureReady({ cwd: d, home });
    const globalPlugin = join(home, '.config', 'opencode', 'plugins', 'safety-guard.js');
    assert.ok(existsSync(globalPlugin), 'the main line of defence lives outside the working directory');
    assert.ok(r.restored.some(x => x.includes('safety-guard')));
    assert.match(readFileSync(globalPlugin, 'utf8'), /destructiveReason/);
  } finally { for (const p of [d, home]) rmSync(p, { recursive: true, force: true }); }
});

test('ensureReady restores denials after the agent rewrote them to allow', async () => {
  const d = tmp(); const home = tmp();
  try {
    const b = new OpenCodeBackend();
    await b.ensureReady({ cwd: d, home });
    // simulate disarming: the block is in place but every value says allow
    const cfg = JSON.parse(readFileSync(join(d, OPENCODE_CONFIG_FILE), 'utf8'));
    for (const k of Object.keys(cfg.permission.bash)) cfg.permission.bash[k] = 'allow';
    writeFileSync(join(d, OPENCODE_CONFIG_FILE), JSON.stringify(cfg, null, 2));
    const r = await b.ensureReady({ cwd: d, home });
    const after = JSON.parse(readFileSync(join(d, OPENCODE_CONFIG_FILE), 'utf8')).permission.bash;
    assert.ok(Object.values(after).includes('deny'), 'the denials must come back');
    assert.ok(r.restored.some(x => x.includes(OPENCODE_CONFIG_FILE)));
  } finally { for (const p of [d, home]) rmSync(p, { recursive: true, force: true }); }
});

// v1.5.0 — the spending guard INSIDE a turn. A deferred limitation from the report: the cost was
// only counted once the turn finished, so on half-hour turns the cap was powerless and an
// overrun was discovered after the fact. Now the cost is read from the stream on the fly.
test('spending watcher: accumulates step costs and asks to abort once the limit is passed', async () => {
  const { makeBudgetWatcher } = await import('../../core/backends/opencode.mjs');
  const watcher = makeBudgetWatcher(1.0);
  const step = (c) => JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', cost: c } }) + '\n';
  assert.equal(watcher.onChunk(step(0.3)), undefined, 'within the limit the turn is left alone');
  assert.equal(watcher.onChunk(step(0.4)), undefined);
  assert.ok(Math.abs(watcher.spent() - 0.7) < 1e-9);
  assert.equal(watcher.onChunk(step(0.5)), 'abort', 'exceeding the limit must abort the turn');
});

test('spending watcher: with no limit it counts nothing and interferes with nothing', async () => {
  const { makeBudgetWatcher } = await import('../../core/backends/opencode.mjs');
  for (const limit of [undefined, null, 0, -5]) {
    const watcher = makeBudgetWatcher(limit);
    assert.equal(watcher.onChunk(JSON.stringify({ type: 'step_finish', part: { cost: 99 } }) + '\n'), undefined);
    assert.equal(watcher.spent(), 0);
  }
});

test('spending watcher: an incomplete line in the stream does not break parsing', async () => {
  const { makeBudgetWatcher } = await import('../../core/backends/opencode.mjs');
  const watcher = makeBudgetWatcher(1.0);
  const full = JSON.stringify({ type: 'step_finish', part: { cost: 0.6 } }) + '\n';
  watcher.onChunk(full.slice(0, 20));          // the first half of the event
  assert.equal(watcher.spent(), 0, 'while a line is incomplete there is nothing to count');
  watcher.onChunk(full.slice(20));             // the remainder
  assert.ok(Math.abs(watcher.spent() - 0.6) < 1e-9, 'a reassembled line must be counted');
});
