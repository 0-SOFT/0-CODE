import assert from 'node:assert/strict';
import { probeEngine, engineCommandFiles } from './lifecycle-doctor.mjs';

const expected = process.argv[2];
assert.ok(['present', 'absent'].includes(expected), 'usage: node tests/helpers/check-engines.mjs present|absent');
for (const engine of ['claude', 'codex', 'opencode']) {
  if (expected === 'absent') assert.equal(engineCommandFiles(engine).length, 0, `${engine} command/shim is still on PATH`);
  const probe = probeEngine(engine);
  console.log(JSON.stringify({ engine, ...probe }));
  assert.equal(probe.available, expected === 'present', `${engine}: expected ${expected}`);
}
