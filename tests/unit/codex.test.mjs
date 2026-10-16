import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { cleanupTempDir } from '../helpers/index.mjs';
import {
  buildCodexArgs, parseCodexEvents, decodeCodexError, assessCodexVersion, resolveCodexLaunch,
  CodexBackend, CODEX_VERSION,
} from '../../core/backends/codex.mjs';
import { classifyFailure, decideRetry } from '../../core/turn-retry.mjs';
import { presetForBackend, CODEX_PRESET } from '../../core/model-routing.mjs';
import { getBackend, autodetectBackendId } from '../../core/backend-factory.mjs';
import { preflight } from '../../core/preflight.mjs';

// Recorded CLI responses still exercise real configuration restoration in owned scratch homes.
const testRoot = process.env.FRAMEWORK_TEST_TMPDIR || tmpdir();
mkdirSync(testRoot, { recursive: true });
const testBase = mkdtempSync(join(testRoot, 'codex-parser-test-'));
const testProject = join(testBase, 'project'), personal = join(testBase, 'personal');
mkdirSync(testProject); mkdirSync(personal);
after(() => cleanupTempDir(testBase));
let backendIndex = 0;
function testBackend(options = {}) {
  const backend = new CodexBackend({ ...options,
    env: { ...(options.env || process.env), CODEX_HOME: personal }, homeDir: join(testBase, 'home-' + backendIndex++) });
  const run = backend.runTurn.bind(backend), check = backend.checkEngine.bind(backend);
  backend.runTurn = opts => run({ cwd: testProject, ...opts });
  backend.checkEngine = opts => check({ cwd: testProject, ...opts });
  return backend;
}

const fixture = name => readFileSync(new URL(`../fixtures/codex/0.160.1-${name}.jsonl`, import.meta.url), 'utf8');
const okText = fixture('ok');
const ok = parseCodexEvents(okText);
// Alter real recorded events only to simulate a broken/upgraded protocol, never invent a
// happy-path event stream. Tests below fail if the parser silently loses a required field.
const alter = fn => okText.trim().split('\n').map(JSON.parse).map(fn).filter(Boolean).map(JSON.stringify).join('\n');

test('recorded Codex success: text, thread, tokens and absence of fabricated money', () => {
  assert.equal(ok.ok, true);
  assert.equal(ok.output, 'OK');
  assert.equal(ok.sessionId, '01a10ee1-a542-7ab3-94cf-2e2e8f3ba7c8');
  assert.equal(ok.usage.input_tokens, 13732);
  assert.equal(ok.usage.output_tokens, 5);
  assert.equal(ok.costUsd, undefined);
  assert.deepEqual(ok.usageTotal, ok.usage);
});

test('recorded resume: only the increase in thread totals is attributed to this turn', () => {
  const r = parseCodexEvents(fixture('resume'), { expectedSessionId: ok.sessionId,
    previous: { sessionId: ok.sessionId, usageTotal: ok.usageTotal } });
  assert.equal(r.ok, true);
  assert.equal(r.output, 'RESUMED');
  assert.deepEqual(r.usage, { input_tokens: 13751, cached_input_tokens: 13056,
    cache_write_input_tokens: 0, output_tokens: 19, reasoning_output_tokens: 10 });
});

test('a restored adapter cannot silently bill the whole resumed thread as one turn', () => {
  const r = parseCodexEvents(fixture('resume'), { expectedSessionId: ok.sessionId });
  assert.equal(r.ok, true);
  assert.equal(r.usage, undefined);
  assert.equal(r.usageUnknown, true);
  assert.match(r.warnings.join(' '), /previous thread totals/);
});

test('usage baseline must belong to the same thread and must be complete', () => {
  for (const previous of [{ sessionId: 'other', usageTotal: ok.usageTotal },
    { sessionId: ok.sessionId, usageTotal: { input_tokens: 1 } },
    { sessionId: ok.sessionId, usageTotal: { ...ok.usageTotal, input_tokens: 999999 } }]) {
    const r = parseCodexEvents(okText, { previous });
    assert.equal(r.ok, false);
    assert.equal(r.formatChanged, true);
    assert.equal(r.usage, undefined);
  }
  assert.equal(parseCodexEvents(okText, { expectedSessionId: 'other' }).ok, false);
});

test('recorded source-fix run: last agent message wins over progress messages and tools', () => {
  const text = fixture('model-fix');
  assert.doesNotMatch(text, /F:[\\/]+Projects/);
  for (const line of text.trim().split('\n')) {
    const event = JSON.stringify(JSON.parse(line));
    for (const match of event.matchAll(/C:(\\+)Users\1([^\\]+)/g)) assert.equal(match[2], 'test-user');
  }
  const r = parseCodexEvents(text);
  assert.equal(r.ok, true);
  assert.match(r.output, /f7cb8a6/);
  assert.doesNotMatch(r.output, /I’ll inspect/);
  assert.equal(r.usage.input_tokens, 72788);
  assert.equal(r.usage.output_tokens, 561);
  assert.ok(r.raw.some(e => e.item?.type === 'file_change'));
});

test('recorded unsupported model is a fatal configuration error, not a server retry', () => {
  const r = parseCodexEvents(fixture('error'));
  assert.equal(r.ok, false);
  assert.match(r.error, /not supported.*ChatGPT/);
  assert.equal(classifyFailure(r.error), 'fatal');
  assert.equal(decideRetry({ error: r.error }).retry, false);
  assert.equal(r.formatChanged, undefined);
  assert.match(r.warnings[0], /metadata/);
});

test('broken or truncated Codex protocol refuses rather than returning a successful empty turn', () => {
  const cases = ['', 'not-json', 'null', '{}', '[]', '42',
    alter(e => e.type === 'thread.started' ? { ...e, thread_id: null } : e),
    alter(e => e.type === 'thread.started' ? null : e),
    alter(e => e.type === 'turn.started' ? null : e),
    alter(e => e.type === 'turn.completed' ? null : e),
    alter(e => e.type === 'turn.completed' ? { ...e, usage: { input_tokens: 1 } } : e),
    alter(e => e.type === 'turn.completed' ? { ...e, usage: { ...e.usage, output_tokens: -1 } } : e),
    alter(e => e.type === 'item.completed' ? { ...e, item: { type: 'agent_message', text: 42 } } : e),
    alter(e => e.type === 'item.completed' ? { ...e, item: {} } : e),
    alter(e => e.type === 'item.completed' ? { ...e, item: { ...e.item, text: ' ' } } : e),
    okText + '{"type":"thread.started","thread_id":"other"}\n',
  ];
  for (const text of cases) {
    const r = parseCodexEvents(text);
    assert.equal(r.ok, false, text);
    assert.equal(r.formatChanged, true);
    assert.equal(classifyFailure(r.error), 'fatal');
  }
  assert.equal(parseCodexEvents(okText.replaceAll('\n', '\r\n')).ok, true);
});

test('Codex arguments: closed stdin, explicit resume, compatible sandbox override', () => {
  const args = buildCodexArgs({ model: 'gpt-6-luna', ignoreUserConfig: true });
  assert.equal(args[0], 'exec');
  assert.equal(args.at(-1), '-');
  assert.ok(args.includes('--json'));
  assert.ok(args.includes('sandbox_mode="danger-full-access"'));
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(!args.includes('--full-auto'));
  assert.ok(!args.includes('--yolo'));
  assert.ok(!args.includes('--dangerously-bypass-hook-trust'));
  const resume = buildCodexArgs({ sessionId: ok.sessionId, config: ['windows.sandbox="unelevated"'], bypassHookTrust: true });
  assert.deepEqual(resume.slice(0, 3), ['exec', 'resume', ok.sessionId]);
  assert.ok(resume.includes('--dangerously-bypass-hook-trust'));
  assert.ok(!resume.includes('-s'), 'exec resume has no -s flag');
  assert.throws(() => buildCodexArgs({ sessionId: '--last' }));
  assert.throws(() => buildCodexArgs({ sessionId: '' }));
  assert.throws(() => buildCodexArgs({ sandbox: 'typo' }));
  assert.throws(() => buildCodexArgs({ config: ['broken'] }));
});

test('version compatibility: pinned and newer require real protocol; older/unknown refuse', () => {
  assert.equal(CODEX_VERSION, '0.162.0');
  assert.equal(assessCodexVersion('codex-cli 0.162.0\r\n').ok, true);
  assert.deepEqual(assessCodexVersion('codex-cli 0.162.0').notes, []);
  assert.equal(assessCodexVersion('codex-cli 0.163.0').notes.length, 1);
  assert.equal(assessCodexVersion('codex-cli 1.0.0').ok, true);
  for (const v of ['0.159.9', '0.160.0', '0.160.1']) {
    assert.equal(assessCodexVersion(`codex-cli ${v}`).ok, true);
    assert.equal(assessCodexVersion(`codex-cli ${v}`, { strict: true }).ok, false);
  }
  const formerlyPinned = assessCodexVersion('codex-cli 0.161.0', { strict: true });
  assert.equal(formerlyPinned.ok, false);
  assert.match(formerlyPinned.error, /0\.162\.0/);
  assert.equal(assessCodexVersion('unrecognised').ok, false);
});

test('Windows CLI resolution uses native argv instead of cmd.exe', () => {
  const dir = join('root', 'npm');
  const entry = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const files = new Set([join(dir, 'codex.cmd'), entry]);
  const r = resolveCodexLaunch({ env: { PATH: dir }, platform: 'win32', execPath: 'node-exe', exists: p => files.has(p) });
  assert.deepEqual(r, { bin: 'node-exe', args: [entry] });
  files.add(join(dir, 'codex.exe'));
  assert.deepEqual(resolveCodexLaunch({ env: { Path: dir }, platform: 'win32', exists: p => files.has(p) }),
    { bin: join(dir, 'codex.exe'), args: [] });
  const localBin = join('root', 'node_modules', '.bin');
  const localEntry = join('root', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  assert.equal(resolveCodexLaunch({ env: { PATH: localBin }, platform: 'win32',
    exists: p => p === join(localBin, 'codex.cmd') || p === localEntry }).args[0], localEntry);
  assert.throws(() => resolveCodexLaunch({ env: {}, platform: 'win32', exists: () => false }), /not found/);
  assert.deepEqual(resolveCodexLaunch({ platform: 'linux' }), { bin: 'codex', args: [] });
});

test('Codex factory and routing are explicit and independent of OpenRouter variables', () => {
  assert.equal(getBackend('codex').id, 'codex');
  assert.equal(getBackend(undefined, { env: { AGENT_BACKEND: 'codex' } }).id, 'codex');
  assert.equal(autodetectBackendId({ AGENT_BACKEND: 'codex', CLAUDECODE: '1' }), 'codex');
  assert.throws(() => autodetectBackendId({ AGENT_BACKEND: 'codeex' }));
  assert.equal(presetForBackend('codex', { OPENROUTER_MODEL_MID: 'wrong/provider' }).mid, undefined);
  assert.equal(presetForBackend('codex', { CODEX_MODEL_HIGH: 'chosen' }).high, 'chosen');
  assert.equal(presetForBackend('codex', { CODEX_MODEL_MID: 'chosen' }).mid, 'chosen');
});

test('Codex subscription usage exhaustion is a pause, even if the message says try again', () => {
  for (const message of ['usage_limited: try again later', 'usage_limit_reached: 429',
    'You have hit your usage limit. Try again tomorrow.']) {
    assert.equal(classifyFailure(message), 'usage_limited');
    assert.equal(decideRetry({ error: message }).retry, false);
    assert.match(decideRetry({ error: message }).reason, /paused until reset/);
  }
  assert.equal(classifyFailure('429 Too many requests'), 'transient');
  const nested = decodeCodexError({ error: { type: 'usage_limited', resets_at: 2000000000, message: 'try again' } });
  assert.equal(nested.kind, 'usage_limited');
  assert.equal(nested.retryAt, 2000000000);
});

test('preflight accepts saved subscription login and verifies newer CLI using the recorded protocol', async () => {
  const calls = [];
  const backend = testBackend({ command: { bin: 'recorded-cli', args: [] }, env: {},
    inspect: (_, args) => { calls.push(args); return { status: 0, stdout: args.includes('--version') ? 'codex-cli 0.163.0' : '' }; },
    launch: async () => ({ status: 0, stdout: okText }),
  });
  const r = await preflight({ backend, cwd: testProject });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2, 'version then login status; no API key required');
  assert.equal(r.engineVersion, '0.163.0');
  assert.match(r.notes.join(' '), /verified.*tokens, not USD/);
});

test('preflight does not spend a turn if engine version or login check fails', async () => {
  let turns = 0;
  for (const kind of ['old', 'formerly-pinned', 'absent', 'logout', 'version-format']) {
    const backend = testBackend({ command: { bin: 'recorded-cli', args: [] }, env: {},
      inspect: (_, args) => args.includes('--version')
        ? { status: kind === 'absent' ? 1 : 0,
          stdout: kind === 'old' ? 'codex-cli 0.150.0' : kind === 'formerly-pinned' ? 'codex-cli 0.161.0'
            : kind === 'version-format' ? 'new version schema' : 'codex-cli 0.162.0' }
        : { status: 1 },
      launch: async () => { turns++; return { status: 0, stdout: okText }; },
    });
    assert.equal((await preflight({ backend })).ok, false, kind);
  }
  assert.equal(turns, 0);
});

test('API key login bypasses only login status, never protocol validation', async () => {
  const calls = [];
  const backend = testBackend({ command: { bin: 'recorded-cli', args: [] }, env: { CODEX_API_KEY: 'test-value-not-a-credential' },
    inspect: (_, args) => { calls.push(args); return { status: 0, stdout: 'codex-cli 0.162.0' }; },
    launch: async () => ({ status: 0, stdout: alter(e => e.type === 'turn.completed' ? { ...e, usage: {} } : e) }),
  });
  assert.equal((await preflight({ backend })).ok, false);
  assert.equal(calls.length, 1);
});

test('Codex launch consumes stdin and preserves per-thread usage across runTurn/resume', async () => {
  const calls = [];
  const backend = testBackend({ command: { bin: 'node', args: ['official-codex.js'] },
    launch: async (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return { status: 0, stdout: calls.length === 1 ? okText : fixture('resume') };
    },
  });
  const first = await backend.runTurn({ prompt: 'closed stdin', model: 'gpt-6-luna', cwd: testProject });
  const second = await backend.runTurn({ prompt: 'resume', sessionId: first.sessionId });
  assert.equal(second.usage.output_tokens, 19);
  assert.equal(calls[0].opts.shell, false);
  assert.equal(calls[0].opts.input, 'closed stdin');
  assert.ok(calls[0].opts.timeoutMs > calls[0].opts.idleTimeoutMs);
  assert.equal(calls[0].args[0], 'official-codex.js');
  assert.ok(!calls[0].args.includes('closed stdin'));
  assert.ok(calls[1].args.includes('resume'));
});

test('Codex launch refuses empty input, invalid options and a dollar guard without spawning', async () => {
  let calls = 0;
  const backend = testBackend({ command: { bin: 'unused', args: [] }, launch: async () => { calls++; } });
  for (const opts of [{}, { prompt: ' ' }, { prompt: 'x', sandbox: 'bad' }, { prompt: 'x', maxBudgetUsd: 1 }]) {
    const r = await backend.runTurn(opts);
    assert.equal(r.ok, false);
  }
  assert.equal(calls, 0);
  assert.equal(backend.guardCommand('git status'), null);
  assert.ok(backend.guardCommand('git push --force'));
});

test('exit failure, timeout and capture overflow remain explicit even after a successful event', async () => {
  for (const result of [null, { status: 1, stdout: fixture('error') },
    { status: 0, stdout: okText, timedOut: true }, { status: 0, stdout: okText, truncated: true },
    { status: 2, stdout: okText, stderr: 'launch failed' }]) {
    const backend = testBackend({ command: { bin: 'recorded', args: [] }, launch: async () => result });
    assert.equal((await backend.runTurn({ prompt: 'x' })).ok, false);
  }
});

test('an interrupted process preserves transport and subscription errors after partial JSONL', async () => {
  const partials = [okText.trim().split('\n').slice(0, 2).join('\n'),
    okText.slice(0, Math.floor(okText.length * 0.8))];
  for (const partial of partials) {
    for (const [stderr, kind] of [['ECONNRESET: connection reset by peer', 'transient'],
      ['usage_limited: You have hit your usage limit. Try again tomorrow.', 'usage_limited']]) {
      const backend = testBackend({ command: { bin: 'recorded', args: [] },
        launch: async () => ({ status: 1, stdout: partial, stderr }) });
      const result = await backend.runTurn({ prompt: 'x' });
      assert.equal(result.ok, false);
      assert.equal(classifyFailure(result.error), kind);
      assert.equal(decideRetry({ error: result.error }).retry, kind === 'transient');
    }
    const successful = testBackend({ command: { bin: 'recorded', args: [] },
      launch: async () => ({ status: 0, stdout: partial, stderr: 'ECONNRESET' }) });
    assert.equal(classifyFailure((await successful.runTurn({ prompt: 'x' })).error), 'fatal');
  }
  const malformed = testBackend({ command: { bin: 'recorded', args: [] },
    launch: async () => ({ status: 1, stdout: alter(e => e.type === 'turn.completed'
      ? { ...e, usage: {} } : e), stderr: 'ECONNRESET' }) });
  assert.equal(classifyFailure((await malformed.runTurn({ prompt: 'x' })).error), 'fatal');
});

test('a later turn cannot reuse the answer or completion of an earlier recorded turn', () => {
  const start = JSON.stringify({ type: 'turn.started' }) + '\n';
  const completion = okText.trim().split('\n').at(-1) + '\n';
  for (const suffix of [start, start + completion]) {
    const result = parseCodexEvents(okText + suffix);
    assert.equal(result.ok, false);
    assert.equal(result.output, '');
    assert.equal(result.formatChanged, true);
  }
  // A Stop hook can continue inside exec: all turns must be complete, the latest answer wins.
  const continued = parseCodexEvents(okText + fixture('resume').split('\n').slice(1).join('\n'));
  assert.equal(continued.ok, true);
  assert.equal(continued.output, 'RESUMED');
  assert.equal(continued.usageTotal.output_tokens, 24);
  const events = okText.trim().split('\n');
  assert.equal(parseCodexEvents([events[0], events[3], events[1], events[2]].join('\n')).ok, false);
});

test('malformed failure events cannot erase a known fatal reason or become retriable unknown', () => {
  const recorded = fixture('error').trim().split('\n').map(JSON.parse);
  const variants = [recorded.map((e, i) => i === recorded.length - 1 ? { type: 'turn.failed' } : e),
    recorded.map(e => e.type === 'error' ? { type: 'error', reason: e.message }
      : e.type === 'turn.failed' ? { type: 'turn.failed', reason: e.error } : e),
    recorded.map(e => e.type === 'turn.failed' ? { ...e, error: {} } : e)];
  for (const events of variants) {
    const result = parseCodexEvents(events.map(JSON.stringify).join('\n'));
    assert.equal(result.ok, false);
    assert.equal(result.formatChanged, true);
    assert.equal(classifyFailure(result.error), 'fatal');
    assert.equal(decideRetry({ error: result.error }).retry, false);
  }
});

test('every completion in one exec must preserve monotone thread totals', () => {
  const first = okText.trim().split('\n').map(JSON.parse);
  const next = fixture('resume').trim().split('\n').map(JSON.parse).slice(1);
  for (const key of Object.keys(ok.usageTotal)) {
    const events = structuredClone([...first, ...next]);
    const initial = events.find(e => e.type === 'turn.completed');
    initial.usage[key] = Math.max(initial.usage[key], 2);
    events.at(-1).usage[key] = initial.usage[key] - 1;
    const result = parseCodexEvents(events.map(JSON.stringify).join('\n'));
    assert.equal(result.ok, false, key);
    assert.equal(result.formatChanged, true);
    assert.equal(result.usage, undefined);
  }
});

test('explicit request-error type outranks words in the message, including an invalid model name', () => {
  const original = "The '0-code-no-such-model' model is not supported when using Codex with a ChatGPT account.";
  for (const stream of [fixture('error').replaceAll('0-code-no-such-model', 'usage_limited'),
    fixture('error').replaceAll(original, 'Invalid value for request parameter reasoning.effort')]) {
    const result = parseCodexEvents(stream);
    assert.equal(result.ok, false);
    assert.match(result.error, /^invalid_request_error:/);
    assert.equal(classifyFailure(result.error), 'fatal');
    assert.equal(decideRetry({ error: result.error }).retry, false);
  }
  const limited = parseCodexEvents(fixture('error').replaceAll('invalid_request_error', 'usage_limited')
    .replaceAll(original, 'You have hit your usage limit. Details mention invalid_request_error.'));
  assert.equal(classifyFailure(limited.error), 'usage_limited');
});

test('JSON-encoded blank terminal failures never become successful turns', () => {
  const recorded = fixture('error').trim().split('\n').map(JSON.parse);
  for (const blank of ['', ' \t\n']) {
    for (const message of [JSON.stringify(blank), JSON.stringify(JSON.stringify(blank)),
      JSON.stringify({ message: blank }), JSON.stringify({ type: [], message: blank }),
      JSON.stringify({ type: { toString: 'not-a-function' }, message: blank }),
      JSON.stringify({ type: ' ', message: blank })]) {
      for (const types of [['error'], ['turn.failed'], ['error', 'turn.failed']]) {
        const events = structuredClone(recorded).filter(e =>
          !['error', 'turn.failed'].includes(e.type) || types.includes(e.type));
        for (const e of events) {
          if (e.type === 'error') e.message = message;
          if (e.type === 'turn.failed') e.error.message = message;
        }
        const result = parseCodexEvents(events.map(JSON.stringify).join('\n'));
        assert.equal(result.ok, false, `${types}: ${message}`);
        assert.equal(result.formatChanged, true);
        assert.ok(result.error.trim(), 'a refusal must explain why');
        assert.equal(classifyFailure(result.error), 'fatal');
        assert.equal(result.usage, undefined);
      }
    }
  }
});

test('intermediate error before turn.completed with exit 0 remains a warning', async () => {
  const events = okText.trim().split('\n');
  const message = 'Reconnecting... 1/5 (stream disconnected before completion: ECONNRESET)';
  events.splice(2, 0, JSON.stringify({ type: 'error', message }));
  const stdout = events.join('\n') + '\n';
  const backend = testBackend({ command: { bin: 'recorded', args: [] },
    launch: async () => ({ status: 0, stdout, stderr: '' }) });
  const result = await backend.runTurn({ prompt: 'x' });
  assert.equal(result.ok, true);
  assert.equal(result.output, ok.output);
  assert.deepEqual(result.usage, ok.usage);
  assert.deepEqual(result.warnings, [message]);
  assert.equal(result.error, undefined);
  const failed = testBackend({ command: { bin: 'recorded', args: [] },
    launch: async () => ({ status: 1, stdout, stderr: '' }) });
  assert.equal((await failed.runTurn({ prompt: 'x' })).ok, false);
  const terminal = stdout + JSON.stringify({ type: 'turn.failed', error: { message: 'terminal failure' } }) + '\n';
  backend.launch = async () => ({ status: 0, stdout: terminal, stderr: '' });
  assert.match((await backend.runTurn({ prompt: 'x' })).error, /terminal failure/);
  backend.launch = async () => ({ status: 0,
    stdout: events.slice(0, 3).join('\n') + '\n', stderr: '' });
  assert.equal((await backend.runTurn({ prompt: 'x' })).ok, false, 'a warning does not replace completion');
});

test('runTurn preserves malformed terminal refusals and a known usage type survives an empty description', async () => {
  const events = fixture('error').trim().split('\n').map(JSON.parse);
  for (const e of events) {
    if (e.type === 'error') e.message = JSON.stringify('');
    if (e.type === 'turn.failed') e.error.message = JSON.stringify('');
  }
  const stdout = events.map(JSON.stringify).join('\n');
  for (const status of [1, 0]) {
    const backend = testBackend({ command: { bin: 'recorded', args: [] },
      launch: async () => ({ status, stdout, stderr: 'ECONNRESET' }) });
    const result = await backend.runTurn({ prompt: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.formatChanged, true);
    assert.equal(classifyFailure(result.error), 'fatal');
    assert.equal(decideRetry({ error: result.error }).retry, false);
  }
  const original = "The '0-code-no-such-model' model is not supported when using Codex with a ChatGPT account.";
  const emptyTyped = fixture('error').replaceAll(original, '');
  for (const [stream, kind] of [[emptyTyped, 'fatal'],
    [emptyTyped.replaceAll('invalid_request_error', 'usage_limited'), 'usage_limited']]) {
    const result = parseCodexEvents(stream);
    assert.equal(result.ok, false);
    assert.equal(result.formatChanged, undefined, 'a known wire error type still carries a refusal');
    assert.ok(result.error.trim());
    assert.equal(classifyFailure(result.error), kind);
    assert.equal(decideRetry({ error: result.error }).retry, false);
  }
});
