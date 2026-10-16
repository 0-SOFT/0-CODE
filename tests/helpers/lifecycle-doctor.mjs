import assert from 'node:assert/strict';
import { runCli } from '../../core/backends/spawn-cli.mjs';
import { resolveCodexLaunch } from '../../core/backends/codex.mjs';
import { lstatSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

export function engineCommandFiles(engine, { env = process.env, cwd = process.cwd() } = {}) {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
  const roots = [...(process.platform === 'win32' ? [cwd] : []), ...(env[pathKey] || '').split(delimiter)];
  const extensions = process.platform === 'win32' ? ['', '.exe', '.com', '.cmd', '.bat', '.ps1'] : [''];
  const candidates = roots.flatMap(root => extensions.map(ext => join(resolve(cwd, root.replace(/^"|"$/g, '') || '.'), engine + ext)));
  return [...new Set(candidates)].filter(file => {
    try { const stat = lstatSync(file); return stat.isFile() || stat.isSymbolicLink(); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
  });
}

// Probe the actual CLI independently of the report. A broken installed CLI is a failure,
// rather than an arbitrary engine error that can be accepted as "not installed".
export function probeEngine(engine, { cwd, env = process.env } = {}) {
  let launch;
  try { launch = engine === 'codex' ? resolveCodexLaunch({ env }) : { bin: engine, args: [] }; }
  catch (error) {
    assert.match(error.message, /^Codex command not found: /);
    assert.equal(engineCommandFiles(engine, { cwd, env }).length, 0, `${engine} has a command file but cannot be resolved`);
    return { available: false };
  }
  const result = runCli(launch.bin, [...launch.args, '--version'], { cwd, env, encoding: 'utf8', timeoutMs: 10000 });
  if (result.error?.code === 'ENOENT') {
    assert.equal(engineCommandFiles(engine, { cwd, env }).length, 0, `${engine} has a command file but cannot be started`);
    return { available: false };
  }
  assert.equal(result.status, 0, `${engine} --version failed: ${result.stderr || result.error?.message || result.signal}`);
  const version = String(result.stdout || '').trim().split(/\r?\n/)[0];
  assert.ok(version, `${engine} --version returned no version`);
  return { available: true, version };
}

export function assertLifecycleDoctor(report, { cwd, env = process.env, engines, status } = {}) {
  assert.ok(Array.isArray(engines) && engines.length > 0, 'expected engines must be explicit');
  const engineChecks = report.checks.filter(check => check.id.startsWith('engine-'));
  assert.deepEqual(engineChecks.map(check => check.id).sort(), engines.map(engine => `engine-${engine}`).sort());
  for (const id of ['config', 'receipt', 'owned-files', 'state', 'runtime-ignore', ...engines.map(engine => `guard-${engine}`)]) {
    assert.equal(report.checks.find(check => check.id === id)?.ok, true, `${id} must be present and successful`);
  }
  for (const check of report.checks.filter(check => !check.id.startsWith('engine-'))) {
    assert.equal(check.ok, true, `${check.id}: ${check.reason}`);
  }
  const probes = engines.map(engine => {
    const probe = probeEngine(engine, { cwd, env });
    if (['present', 'absent'].includes(env.ZERO_CODE_TEST_ENGINES)) {
      assert.equal(probe.available, env.ZERO_CODE_TEST_ENGINES === 'present', `${engine}: expected ${env.ZERO_CODE_TEST_ENGINES}`);
    }
    const check = engineChecks.find(check => check.id === `engine-${engine}`);
    assert.equal(check.ok, probe.available, `${check.id}: ${check.reason || check.detail}`);
    if (probe.available) assert.equal(check.detail, probe.version.slice(0, 120));
    else assert.match(check.reason, engine === 'codex' && process.platform === 'win32'
      ? /^(?:Engine is unavailable or --version failed|Codex command not found: .+)$/
      : /^Engine is unavailable or --version failed$/);
    return { engine, ...probe };
  });
  assert.equal(report.ok, probes.every(probe => probe.available));
  if (status !== undefined) assert.equal(status, report.ok ? 0 : 1);
  return probes;
}
