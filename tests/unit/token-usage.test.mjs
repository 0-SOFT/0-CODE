import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJsonl, sumUsage, mergeUsage, totalTokens, formatTokens, usageTable,
  snapshotFromStatus, snapshotChanged, calibrate, tokensPerUsd, median, statusLine,
} from '../../core/token-usage.mjs';

// v1.22.0. A subscription states its limits as "N times Pro" and shows only a percentage, so a
// financial model had nothing to stand on. The transcript has exact tokens, the status line has the
// percentage and Claude Code's own list-price cost — these tests pin the arithmetic joining them.

const resp = (id, usage, extra = {}) => ({
  type: 'assistant', timestamp: extra.ts || '2026-09-01T10:00:00Z',
  message: { id, model: extra.model || 'claude-x', usage },
});

test('a response written once per content block is counted once', () => {
  const u = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 };
  // Measured on a live transcript: the same message id with the same usage, 2 to 4 times.
  const records = [resp('m1', u), resp('m1', u), resp('m1', u), resp('m2', u, { ts: '2026-09-01T10:05:00Z' })];
  const s = sumUsage(records);
  assert.equal(s.total.requests, 2, 'summing lines would triple-count m1');
  assert.equal(s.total.output, 100);
  assert.equal(s.total.cache_read, 2000);
  assert.equal(s.first, '2026-09-01T10:00:00Z');
  assert.equal(s.last, '2026-09-01T10:05:00Z');
});

test('models are kept apart, synthetic placeholders and usage-less lines are ignored', () => {
  const s = sumUsage([
    resp('a', { input_tokens: 1, output_tokens: 1 }, { model: 'opus' }),
    resp('b', { input_tokens: 1, output_tokens: 3 }, { model: 'haiku' }),
    resp('c', { input_tokens: 0, output_tokens: 0 }, { model: '<synthetic>' }),
    { type: 'user', message: { content: 'hi' } },
    null,
  ]);
  assert.deepEqual(Object.keys(s.models).sort(), ['haiku', 'opus']);
  assert.equal(s.total.output, 4);
});

test('a record with no id at all still counts (older transcripts)', () => {
  const s = sumUsage([{ message: { usage: { output_tokens: 7 } } }, { message: { usage: { output_tokens: 7 } } }]);
  assert.equal(s.total.requests, 2);
  assert.equal(s.models.unknown.output, 14);
});

test('parseJsonl skips a torn last line instead of failing the whole log', () => {
  assert.equal(parseJsonl('{"a":1}\n\n{"b":2}\n{"c":').length, 2);
  assert.deepEqual(parseJsonl(undefined), []);
});

test('mergeUsage folds sessions per model', () => {
  const a = sumUsage([resp('1', { output_tokens: 1 }, { model: 'x' })]);
  const b = sumUsage([resp('2', { output_tokens: 2 }, { model: 'x' }), resp('3', { output_tokens: 4 }, { model: 'y' })]);
  const m = mergeUsage([a, b, null]);
  assert.equal(m.models.x.output, 3);
  assert.equal(m.total.output, 7);
  assert.equal(m.total.requests, 3);
});

test('formatting: compact numbers and a markdown table with a total row only when useful', () => {
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(2_500_000), '2.50M');
  assert.equal(formatTokens(3_000_000_000), '3.00B');
  assert.equal(formatTokens('junk'), '0');
  const one = usageTable(sumUsage([resp('1', { output_tokens: 1 })]));
  assert.match(one, /^\| model \|/);
  assert.match(one, /\| --- \|/);
  assert.doesNotMatch(one, /\*\*all\*\*/);
  const two = usageTable(sumUsage([resp('1', { output_tokens: 1 }, { model: 'a' }), resp('2', { output_tokens: 1 }, { model: 'b' })]));
  assert.match(two, /\*\*all\*\*/);
  assert.equal(totalTokens({ input: 1, cache_write: 2, cache_read: 3, output: 4 }), 10);
});

const payload = (extra = {}) => ({
  session_id: 's1', model: { id: 'opus', display_name: 'Opus' },
  cost: { total_cost_usd: 1.23456 },
  context_window: { used_percentage: 41.6 },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1_000_000 + 7200 },
    seven_day: { used_percentage: 41, resets_at: 1_000_000 + 3 * 86400 + 3600 },
  },
  ...extra,
});

test('a snapshot keeps the share, the reset times and the list-price cost', () => {
  const s = snapshotFromStatus(payload(), new Date('2026-09-01T10:00:00Z'));
  assert.equal(s.session, 's1');
  assert.equal(s.model, 'opus');
  assert.equal(s.cost_usd, 1.2346);
  assert.equal(s.h5, 23.5);
  assert.equal(s.d7, 41);
  assert.equal(s.ts, '2026-09-01T10:00:00.000Z');
});

test('no snapshot without plan limits (API key, or before the first response)', () => {
  assert.equal(snapshotFromStatus({ session_id: 's' }), null);
  assert.equal(snapshotFromStatus({ rate_limits: {} }), null);
  assert.equal(snapshotFromStatus(null), null);
  const half = snapshotFromStatus({ rate_limits: { seven_day: { used_percentage: 'x' } } });
  assert.equal(half.d7, null, 'a malformed share is recorded as unknown, not as zero');
  assert.equal(half.h5, null);
});

test('only a moved share or cost is worth a line', () => {
  const a = snapshotFromStatus(payload());
  assert.equal(snapshotChanged(null, a), true);
  assert.equal(snapshotChanged(a, { ...a, ts: 'later' }), false, 'a timer refresh adds nothing');
  assert.equal(snapshotChanged(a, { ...a, cost_usd: 2 }), true);
  assert.equal(snapshotChanged(a, { ...a, d7: 42 }), true);
  assert.equal(snapshotChanged(a, null), false);
});

const snap = (ts, session, cost, d7, d7_reset = 5000 * 3600) => ({ ts, session, cost_usd: cost, d7, d7_reset, h5: null, h5_reset: null });

test('calibration: dollars per 1 % from parallel sessions inside one weekly window', () => {
  const s = [
    snap('2026-09-01T10:00Z', 'a', 1, 10),
    snap('2026-09-01T10:10Z', 'b', 2, 11),   // born inside the window: its whole cost counts
    snap('2026-09-01T11:00Z', 'a', 11, 16),  // +10
    snap('2026-09-01T12:00Z', 'b', 12, 20),  // +10
    snap('2026-09-01T12:30Z', 'b', 3, 22),   // /clear: the cost restarted, +3
  ];
  const [w] = calibrate(s);
  assert.equal(w.pct_from, 10);
  assert.equal(w.pct_to, 22);
  assert.equal(w.delta_pct, 12);
  assert.equal(w.spend_usd, 25);
  assert.equal(w.usd_per_pct, 2.083);
  assert.equal(w.capacity_usd, 208.33);
});

test('calibration: a session already running when recording began only sets its baseline', () => {
  // 'old' first appears with $40 of spend from days before the status line was installed; counting
  // it would inflate the window to $45 for 10 points and the capacity with it — the error the
  // report promises never to make.
  const s = [
    snap('2026-09-01T10:00Z', 'a', 1, 10),
    snap('2026-09-01T10:30Z', 'old', 40, 12),
    snap('2026-09-01T11:00Z', 'a', 6, 20),   // +5
  ];
  const starts = new Map([['old', '2026-08-28T09:00:00Z'], ['a', '2026-09-01T09:59:00Z']]);
  assert.equal(calibrate(s, { sessionStarts: starts })[0].spend_usd, 5);
  assert.equal(calibrate(s)[0].spend_usd, 45, 'without start times the old rule stands');
  const born = new Map([['old', '2026-09-01T10:20:00Z']]);
  assert.equal(calibrate(s, { sessionStarts: born })[0].spend_usd, 45, 'born inside the window: counted');
});

test('calibration: windows are kept apart and a small move is not reported', () => {
  const s = [
    snap('2026-09-01T10:00Z', 'a', 0, 0, 100 * 3600),
    snap('2026-09-01T11:00Z', 'a', 50, 4, 100 * 3600),     // 4 points: rounding would dominate
    snap('2026-09-08T10:00Z', 'a', 60, 1, 268 * 3600),     // a new week: the carried-over session is not counted
    snap('2026-09-08T11:00Z', 'a', 80, 11, 268 * 3600 + 20), // resets_at jitter of seconds is the same window
  ];
  const out = calibrate(s);
  assert.equal(out.length, 1);
  assert.equal(out[0].spend_usd, 20);
  assert.equal(out[0].delta_pct, 10);
  assert.equal(calibrate(s, { minDeltaPct: 1 }).length, 2);
});

test('calibration of the 5-hour window, and an unknown window is an error', () => {
  const s = [
    { ts: '1', session: 'a', cost_usd: 0, h5: 0, h5_reset: 3600 },
    { ts: '2', session: 'a', cost_usd: 5, h5: 50, h5_reset: 3600 },
  ];
  assert.equal(calibrate(s, { window: 'h5' })[0].capacity_usd, 10);
  assert.deepEqual(calibrate(s), [], 'no weekly data, no weekly answer');
  assert.throws(() => calibrate(s, { window: 'month' }), /unknown window/);
  assert.deepEqual(calibrate(null), []);
});

test('tokens per dollar come only from sessions both sides saw', () => {
  const usages = [
    { session: 'a', total: { requests: 1, input: 10, cache_write: 0, cache_read: 1000, output: 90 } },
    { session: 'ghost', total: { requests: 1, input: 1e9, cache_write: 0, cache_read: 0, output: 0 } },
  ];
  const per = tokensPerUsd(usages, [snap('1', 'a', 1, 0), snap('2', 'a', 2, 1), null]);
  assert.equal(per.usd, 2);
  assert.equal(per.output, 45);
  assert.equal(per.total, 550);
  assert.equal(tokensPerUsd(usages, []), null);
});

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median(null), null);
});

test('the status line shows model, context, both windows with time to reset, and cost', () => {
  const line = statusLine(payload(), new Date(1_000_000 * 1000));
  assert.equal(line, '[Opus] · ctx 42% · 5h 24% (2h00m) · week 41% (3d1h) · $1.23 list');
  assert.equal(statusLine({}), '');
  assert.equal(statusLine(null), '');
  assert.equal(statusLine({ context_window: { used_percentage: null }, rate_limits: { five_hour: { used_percentage: 5 } } }), '5h 5%');
});
