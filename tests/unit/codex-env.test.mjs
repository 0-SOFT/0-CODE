import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupTempDir } from '../helpers/index.mjs';
import { mcpEnvironmentNames, loadCodexEnvironment } from '../../lib/codex-env.mjs';

const scratch = process.env.FRAMEWORK_TEST_TMPDIR || tmpdir();
function fixture(t) {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'codex-env-test-'));
  t.after(() => cleanupTempDir(dir));
  return dir;
}

test('environment sources include secrets, public placeholders and HTTP headers', () => {
  const names = mcpEnvironmentNames({ servers: [{ command: '${COMMAND}', args: ['${NPM_GLOBAL_ROOT}/tool', '${PORT:-42}'],
    url: 'https://${HOST}', env: { KEY: '${TOKEN}' }, headers: { Authorization: 'Bearer ${HTTP_KEY}' },
    secrets: ['MISSING', 'invalid-name', 1] }, {}] });
  assert.deepEqual(new Set(names), new Set(['CODEX_API_KEY', 'COMMAND', 'NPM_GLOBAL_ROOT', 'PORT', 'HOST', 'TOKEN', 'HTTP_KEY', 'MISSING']));
  assert.deepEqual(mcpEnvironmentNames(), ['CODEX_API_KEY']);
});

test('host launch controls cannot be imported even when a manifest references them', t => {
  const dir = fixture(t), file = join(dir, '.env');
  const controls = ['NODE_OPTIONS', 'node_options', 'PATH', 'Path', 'CODEX_HOME', 'FRAMEWORK_CODEX_HOME', 'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES', 'XDG_STATE_HOME', 'AGENT_BACKEND', 'BASH_ENV', 'TEMP', 'NPM_CONFIG_PREFIX'];
  writeFileSync(file, controls.map(name => `${name}=host-control-fixture`).join('\n') + '\nNPM_GLOBAL_ROOT=public-module-path\nTOKEN=fixture-token');
  const names = mcpEnvironmentNames({ servers: [{ secrets: [...controls, 'TOKEN'], env: { GLOBAL: '${NPM_GLOBAL_ROOT}' } }] });
  const env = loadCodexEnvironment([file], {}, [...names, ...controls]);
  for (const name of controls) assert.equal(env[name], undefined);
  assert.equal(env.TOKEN, 'fixture-token');
  assert.equal(env.NPM_GLOBAL_ROOT, 'public-module-path');
});

test('exported values then config env then root env have priority without modifying the parent', t => {
  const dir = fixture(t), first = join(dir, 'config.env'), second = join(dir, '.env');
  writeFileSync(first, 'A=file\nB=first\nC="quoted # value" # comment\nexport D=plain # comment\nIGNORED=secret-fixture\n');
  writeFileSync(second, "B=second\nE='literal $(echo x) ${A}'\nF=value#suffix\n__proto__=opaque\n");
  const parent = { A: 'exported', UNRELATED: 'preserved' };
  const env = loadCodexEnvironment([join(dir, 'missing'), first, second], parent, ['A', 'B', 'C', 'D', 'E', 'F', '__proto__']);
  assert.equal(env.A, 'exported'); assert.equal(env.B, 'first'); assert.equal(env.C, 'quoted # value');
  assert.equal(env.D, 'plain'); assert.equal(env.E, 'literal $(echo x) ${A}'); assert.equal(env.F, 'value#suffix');
  assert.equal(env.__proto__, 'opaque'); assert.equal(Object.getPrototypeOf(env), null);
  assert.equal(env.IGNORED, undefined); assert.equal(env.UNRELATED, 'preserved');
  assert.deepEqual(parent, { A: 'exported', UNRELATED: 'preserved' });
});

test('empty exported credentials stay empty and unrelated or invalid lines are ignored', t => {
  const dir = fixture(t), file = join(dir, '.env');
  writeFileSync(file, '# heading\nnot an assignment\nBAD="unterminated\nTOKEN=file-value\nCODEX_API_KEY=file-key\n');
  const env = loadCodexEnvironment([file], { TOKEN: '', CODEX_API_KEY: undefined }, ['TOKEN', 'CODEX_API_KEY']);
  assert.equal(env.TOKEN, ''); assert.equal(env.CODEX_API_KEY, 'file-key');
});

test('invalid selected values fail without reporting credentials and unreadable files differ from absence', t => {
  const dir = fixture(t), file = join(dir, '.env');
  for (const value of ['"secret-fixture', '"secret-fixture" trailing', 'secret\0fixture']) {
    writeFileSync(file, `TOKEN=${value}`);
    assert.throws(() => loadCodexEnvironment([file], {}, ['TOKEN']), e => !e.message.includes('secret-fixture') && /Invalid/.test(e.message));
  }
  assert.throws(() => loadCodexEnvironment([dir], {}, ['TOKEN']), /Could not read Codex environment file/);
  assert.equal(loadCodexEnvironment([join(dir, 'absent')], {}).CODEX_API_KEY, undefined);
});
