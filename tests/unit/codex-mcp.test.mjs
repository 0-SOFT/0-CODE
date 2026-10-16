import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { generateCodexMcp, codexMcpToml, cloudCodexMcpOverrides } from '../../core/backends/codex-mcp.mjs';
import { mcpServerEnvironment } from '../../core/backends/codex-mcp-launch.mjs';

const launcherFile = resolve('managed-launcher.mjs');
const compile = (servers, env = {}) => generateCodexMcp({ schema_version: 1, servers }, env, { launcherFile });

test('CLI MCP keys are literal dotted paths; unsafe account names refuse before launch',()=>{
  const result=compile([{name:'fixture-server',command:'node'}]);
  assert.match(result.overrides[0],/^mcp_servers\.fixture-server=/);
  assert.throws(()=>cloudCodexMcpOverrides(JSON.stringify([{name:'telegram.unsafe',transport:{command:'uvx',env_vars:['TELEGRAM_SESSION_STRING']}}])),/cannot be represented/);
});

test('the shipped manifest and optional transports register consistently in Codex', () => {
  const example = JSON.parse(readFileSync(new URL('../../config/mcp-manifest.example.json', import.meta.url), 'utf8'));
  const schema = JSON.parse(readFileSync(new URL('../../config/mcp-manifest.schema.json', import.meta.url), 'utf8'));
  const credential = 'fixture-example-credential';
  const generated = generateCodexMcp(example, { GITHUB_TOKEN: credential, NPM_GLOBAL_ROOT:'/fixture/global/node_modules' }, { launcherFile });
  assert.deepEqual(generated.registered, ['context7', 'playwright', 'chrome-devtools', 'sequential-thinking', 'memory', 'github']);
  assert.deepEqual(generated.skipped, ['an-oauth-connector', 'a-python-server']);
  assert.ok(!JSON.stringify(generated).includes(credential));
  const source = schema.properties.servers.items.properties.source;
  assert.equal(source.type, 'string');
  assert.ok(!source.enum || source.enum.includes(example.servers[0].source));
  const inferred = compile([{ name: 'stdio', command: 'node', source: 'custom-tool' },
    { name: 'http', url: 'https://example.test/mcp', source: 'npm' }]);
  assert.deepEqual(inferred.registered, ['stdio', 'http']);
  assert.deepEqual(inferred.manifest.servers.map(server => server.type), ['stdio', 'http']);
  for (const fields of [{ type: true }, { type: null }, { source: true }, { source: '' }]) {
    assert.deepEqual(compile([{ name: 'bad', command: 'node', ...fields }]).registered, []);
  }
});

test('stdio references and per-server remapping never serialize credentials', () => {
  const env = { FIRST: 'fixture-one-credential', SECOND: 'fixture-two-credential', DIRECT: 'fixture-direct-credential' };
  const gen = compile([
    { name: 'first', type: 'stdio', command: 'node', args: ['first.js'], env: { API_KEY: '${FIRST}', LEVEL: 'INFO' }, secrets: ['FIRST'] },
    { name: 'second', type: 'stdio', command: 'node', args: ['second.js'], env: { API_KEY: '${SECOND}' }, secrets: ['SECOND'] },
    { name: 'direct', type: 'stdio', command: 'node', env: { DIRECT: '${DIRECT}' }, secrets: ['DIRECT'] },
  ], env);
  assert.deepEqual(gen.registered, ['first', 'second', 'direct']);
  for (const value of Object.values(env)) assert.ok(!JSON.stringify(gen).includes(value));
  const first = JSON.parse(gen.mcp.first.args[1]), second = JSON.parse(gen.mcp.second.args[1]);
  assert.equal(mcpServerEnvironment(first, env).API_KEY, env.FIRST);
  assert.equal(mcpServerEnvironment(second, env).API_KEY, env.SECOND);
  assert.equal(env.API_KEY, undefined, 'the caller environment is untouched');
  assert.deepEqual(gen.mcp.first.env_vars, ['FIRST']);
  assert.equal(gen.mcp.first.env.LEVEL, 'INFO');
  assert.equal(gen.mcp.direct.command, 'node');
  assert.deepEqual(gen.mcp.direct.env_vars, ['DIRECT']);
  assert.equal(gen.mcp.direct.env, undefined);
});

test('stdio fallbacks are applied by the launcher while required secrets cannot fall back', () => {
  const gen = compile([{ name: 'optional', type: 'stdio', command: '${BIN:-node}',
    env: { PORT: '${PORT:-50419}', KEY: '${SECRET:-discard-this-default}' }, secrets: ['SECRET'] }], { SECRET: 'fixture-credential' });
  const spec = JSON.parse(gen.mcp.optional.args[1]);
  assert.equal(mcpServerEnvironment(spec, { SECRET: 'fixture-credential' }).PORT, '50419');
  assert.ok(!JSON.stringify(gen).includes('discard-this-default'));
  assert.throws(() => mcpServerEnvironment(spec, {}), /secret missing/);
  assert.deepEqual(compile(gen.manifest.servers, {}).skipped, ['optional']);
});

test('HTTP maps credentials to bearer and header environment variable names', () => {
  const gen = compile([{ name: 'remote', type: 'http', url: 'http://127.0.0.1:1234/mcp',
    headers: { Authorization: 'Bearer ${TOKEN}', 'X-Auth': '${HEADER}', Accept: 'application/json' },
    secrets: ['TOKEN', 'HEADER'] }], { TOKEN: 'fixture-token', HEADER: 'fixture-header' });
  assert.equal(gen.mcp.remote.bearer_token_env_var, 'TOKEN');
  assert.equal(gen.mcp.remote.env_http_headers['X-Auth'], 'HEADER');
  assert.equal(gen.mcp.remote.http_headers.Accept, 'application/json');
  assert.ok(!gen.override.includes('fixture-token'));
  assert.ok(!gen.override.includes('fixture-header'));
  assert.match(gen.override, /^mcp_servers=\{/);
});

test('unsupported forms and absent secrets are skipped with non-secret reasons', () => {
  const servers = [
    { name: 'missing', type: 'stdio', command: 'node', secrets: ['ABSENT'] },
    { name: 'connector', source: 'claude_ai' },
    { name: 'setup', needs_setup: true },
    { name: 'machine', portable: false },
    { name: 'unknown', type: 'sse', url: 'https://example.test' },
    { name: 'compound', type: 'http', url: 'https://example.test', headers: { 'X-Key': 'prefix ${TOKEN}' } },
    { name: 'in-command', type: 'stdio', command: 'node', args: ['${TOKEN}'], secrets: ['TOKEN'] },
    { name: 'literal', type: 'stdio', command: 'node', env: { API_KEY: 'fixture-literal-credential' } },
    { name: 'auth', type: 'http', url: 'https://example.test', headers: { Authorization: 'Bearer fixture-literal-credential' } },
  ];
  const gen = compile(servers, { TOKEN: 'fixture-token' });
  assert.deepEqual(gen.registered, []);
  assert.deepEqual(gen.skipped, servers.map(s => s.name));
  for (const name of gen.skipped) assert.ok(gen.reasons[name]);
  assert.ok(!JSON.stringify(gen).includes('fixture-literal-credential'));
});

test('names, transport fields and unresolved commands are validated', () => {
  for (const server of [null, { name: 'bad.name', type: 'stdio', command: 'node' },
    { name: 'a', type: 'stdio', command: '' }, { name: 'a', type: 'stdio', command: '${MISSING}' },
    { name: 'a', type: 'stdio', command: '${NOT-SUPPORTED}' }, { name: 'a', type: 'stdio', command: 'node', args: [1] },
    { name: 'a', type: 'stdio', command: 'node', url: 'https://example.test' },
    { name: 'a', type: 'http', url: 'file:///x' }, { name: 'a', type: 'http', url: 'https://user:pass@example.test' },
    { name: 'a', type: 'http', url: 'https://example.test', env: { A: '1' } },
    { name: 'a', type: 'http', url: 'https://example.test', headers: { 'bad header': 'x' } },
    { name: 'a', type: 'stdio', command: 'node', secrets: [1] },
    { name: 'a', type: 'stdio', command: 'node', portable: 'false' },
    { name: 'a', type: 'http', url: 'https://example.test', env: [] },
    { name: 'a', type: 'http', url: 'https://example.test', args: {} },
    { name: 'a', type: 'stdio', command: 'node', secrets: null },
    { name: 'a', type: 'http', url: 'https://example.test', http_headers: { Authorization: 'opaque' } },
    { name: 'a', type: 'stdio', command: 'node', env: { A: 1 } }]) {
    const gen = compile([server]); assert.equal(gen.registered.length, 0); assert.equal(gen.skipped.length, 1);
  }
  const duplicate = { name: 'a', type: 'stdio', command: 'node' };
  assert.equal(compile([duplicate, duplicate]).registered.length, 0);
  assert.throws(() => generateCodexMcp({ schema_version: 2, servers: [] }), /Invalid/);
  assert.equal(codexMcpToml(1), '1');
  assert.equal(codexMcpToml(false), 'false');
  assert.throws(() => codexMcpToml(null), /unsupported/);
});

test('launcher refuses malformed references and unavailable mandatory environment', () => {
  const spec = { command: 'node', args: [], required: [], refs: { API_KEY: { source: 'TOKEN' } } };
  assert.throws(() => mcpServerEnvironment(spec, {}), /environment variable missing/);
  assert.throws(() => mcpServerEnvironment(null, {}), /Invalid/);
  assert.throws(() => mcpServerEnvironment({ ...spec, refs: { 'BAD NAME': { source: 'TOKEN' } } }, {}), /Invalid/);
  const proto = { ...spec, refs: JSON.parse('{"__proto__":{"source":"TOKEN"}}') };
  assert.equal(mcpServerEnvironment(proto, { TOKEN: 'fixture-token' }).__proto__, 'fixture-token');
});

test('declared secret values cannot be serialized through aliases, literals or fallbacks', () => {
  const secret = 'fixture-private-value-with-quote"and-backslash\\';
  const env = { TOKEN: secret, PUBLIC: secret };
  const servers = [
    { name: 'arg-alias', type: 'stdio', command: 'node', args: ['${PUBLIC}'], secrets: ['TOKEN'] },
    { name: 'url-alias', type: 'http', url: 'https://example.test/mcp?key=${PUBLIC}', secrets: ['TOKEN'] },
    { name: 'arg-literal', type: 'stdio', command: 'node', args: [secret], secrets: ['TOKEN'] },
    { name: 'env-literal', type: 'stdio', command: 'node', env: { VALUE: secret }, secrets: ['TOKEN'] },
    { name: 'header-literal', type: 'http', url: 'https://example.test/mcp', headers: { 'X-Key': secret }, secrets: ['TOKEN'] },
    { name: 'fallback', type: 'stdio', command: 'node', env: { VALUE: '${MISSING:-' + secret + '}' }, secrets: ['TOKEN'] },
  ];
  const result = compile(servers, env);
  assert.deepEqual(result.registered, []);
  assert.deepEqual(result.skipped, servers.map(s => s.name));
  assert.ok(!JSON.stringify(result).includes(secret));
  for (const name of result.skipped) assert.match(result.reasons[name], /secret cannot/);
  const valid = compile([{ name: 'valid', type: 'stdio', command: '${BIN:-node}', args: ['plain'],
    env: { DEST: '${PUBLIC}', PORT: '${PORT:-50419}' }, secrets: ['TOKEN'] }], env);
  assert.deepEqual(valid.registered, ['valid']);
  assert.ok(!JSON.stringify(valid).includes(secret));
  assert.equal(mcpServerEnvironment(JSON.parse(valid.mcp.valid.args[1]), env).DEST, secret);
});
