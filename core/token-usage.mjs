// core/token-usage.mjs — how many tokens the work actually took, and what share of the plan limit
// that was.
//
// WHY: a subscription (Pro / Max) publishes its limits as "N times Pro", never as a number of
// tokens, and the only live measure Claude Code exposes is a percentage of the 5-hour and weekly
// windows. A financial model cannot be built on "20x of something unknown". Both halves of the
// missing number are already on disk, though:
//   * the transcript carries exact token counts for every API response;
//   * the status line receives `rate_limits.*.used_percentage` and `cost.total_cost_usd` (Claude
//     Code's own list-price estimate of the session).
// Recording the second next to the first turns the limit into a measured quantity: dollars of
// list-price work per 1 % of the window, and through the real token mix, tokens per 1 %.
//
// No price table lives here on purpose (see the note in core/gates.mjs): money comes from Claude
// Code itself, this module only counts and divides.
//
// Everything below is pure — the file reading lives in lib/token-report.mjs and
// hooks/usage-statusline.mjs.

export const TOKEN_KINDS = ['input', 'cache_write', 'cache_read', 'output'];

// The plan-share history, under docs/logs/. Named here because both its writer (the status line,
// which runs on every message) and its reader (lib/token-report.mjs) need it, and the writer should
// not load the whole report CLI to learn a file name.
export const LIMITS_FILE = 'limits.jsonl';

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const zero = () => ({ requests: 0, input: 0, cache_write: 0, cache_read: 0, output: 0 });

export function parseJsonl(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line while the session writes */ }
  }
  return out;
}

export function totalTokens(t) {
  return TOKEN_KINDS.reduce((s, k) => s + num(t && t[k]), 0);
}

function addInto(acc, t) {
  acc.requests += num(t.requests);
  for (const k of TOKEN_KINDS) acc[k] += num(t[k]);
  return acc;
}

// One API response is written to the transcript once per content block (thinking, text, each
// tool call), and every copy carries the same `usage`. Measured on a live session: 2 to 4 copies
// per response. Summing lines therefore overstates usage two- to four-fold — the response id is
// what makes a request count once.
export function sumUsage(records) {
  const seen = new Set();
  const models = {};
  let first = null, last = null;
  for (const r of records || []) {
    const msg = r && r.message;
    const u = msg && msg.usage;
    if (!u || typeof u !== 'object') continue;
    const model = msg.model || 'unknown';
    if (model === '<synthetic>') continue; // local placeholders, never sent to the API
    const key = msg.id || r.requestId || r.uuid;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const acc = models[model] || (models[model] = zero());
    addInto(acc, {
      requests: 1,
      input: u.input_tokens,
      cache_write: u.cache_creation_input_tokens,
      cache_read: u.cache_read_input_tokens,
      output: u.output_tokens,
    });
    if (r.timestamp) {
      if (!first || r.timestamp < first) first = r.timestamp;
      if (!last || r.timestamp > last) last = r.timestamp;
    }
  }
  const total = Object.values(models).reduce(addInto, zero());
  return { models, total, first, last };
}

// Several usage summaries (sessions, days) folded into one.
export function mergeUsage(list) {
  const models = {};
  for (const u of list || []) {
    for (const [m, t] of Object.entries((u && u.models) || {})) addInto(models[m] || (models[m] = zero()), t);
  }
  return { models, total: Object.values(models).reduce(addInto, zero()) };
}

export function formatTokens(n) {
  const v = num(n);
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

export function usageTable(usage) {
  const rows = [['model', 'requests', 'input', 'cache write', 'cache read', 'output', 'total']];
  const line = (name, t) => [name, String(num(t.requests)),
    ...TOKEN_KINDS.map(k => formatTokens(t[k])), formatTokens(totalTokens(t))];
  for (const [m, t] of Object.entries(usage.models || {}).sort()) rows.push(line(m, t));
  if (Object.keys(usage.models || {}).length > 1) rows.push(line('**all**', usage.total || zero()));
  const md = r => `| ${r.join(' | ')} |`;
  return [md(rows[0]), md(rows[0].map(() => '---')), ...rows.slice(1).map(md)].join('\n');
}

// --- plan limits, as seen by the status line ---

// The status line payload → one snapshot, or null when there is nothing about limits in it
// (API-key sessions, or before the first response of a session).
export function snapshotFromStatus(payload, now = new Date()) {
  const rl = payload && payload.rate_limits;
  if (!rl || (!rl.five_hour && !rl.seven_day)) return null;
  const pct = w => (w && Number.isFinite(Number(w.used_percentage)) ? Number(w.used_percentage) : null);
  const reset = w => (w && Number.isFinite(Number(w.resets_at)) ? Number(w.resets_at) : null);
  return {
    ts: new Date(now).toISOString(),
    session: payload.session_id || null,
    model: (payload.model && (payload.model.id || payload.model.display_name)) || null,
    cost_usd: Math.round(num(payload.cost && payload.cost.total_cost_usd) * 10000) / 10000,
    h5: pct(rl.five_hour), h5_reset: reset(rl.five_hour),
    d7: pct(rl.seven_day), d7_reset: reset(rl.seven_day),
  };
}

// The status line reruns on every message, permission-mode change and timer; recording only what
// moved keeps the log proportional to the work instead of to the refresh rate.
export function snapshotChanged(prev, next) {
  if (!next) return false;
  if (!prev) return true;
  return prev.cost_usd !== next.cost_usd || prev.h5 !== next.h5 || prev.d7 !== next.d7
    || prev.d7_reset !== next.d7_reset || prev.h5_reset !== next.h5_reset;
}

const WINDOWS = { d7: 'd7_reset', h5: 'h5_reset' };

// Dollars of list-price work per 1 % of a plan window.
//
// Within one window (same reset time) the percentage only grows. Spend inside the window is the
// sum of each session's cost increments between its own consecutive snapshots — sessions run in
// parallel, so a single global counter does not exist. A window is reported only when the
// percentage moved at least `minDeltaPct`: the percentage arrives rounded, and a 1-point move
// carries up to 50 % rounding error.
//
// What it cannot see and why that is safe: the percentage also counts claude.ai chat and other
// machines, the spend does not. Foreign usage makes the measured capacity SMALLER than the real one
// — the error errs on the conservative side of a financial model.
//
// `sessionStarts` (session id → ISO time of its first API response, from the .usage.json files)
// closes the one case that would err HIGH: a session already running when recording began — the
// day the status line was installed — whose first snapshot carries days of earlier spend. Such a
// session is not "born inside the window", and its first snapshot only sets the baseline. Without
// the map the old rule applies, so a report over snapshots alone still works.
export function calibrate(snapshots, { window = 'd7', minDeltaPct = 5, sessionStarts = null } = {}) {
  const resetKey = WINDOWS[window];
  if (!resetKey) throw new Error(`unknown window "${window}" (expected d7 or h5)`);
  const groupOf = s => (s[resetKey] == null ? null : Math.round(s[resetKey] / 3600));
  const snaps = (snapshots || []).filter(s => s && s[window] != null && groupOf(s) != null)
    .slice().sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const startOf = id => (sessionStarts && typeof sessionStarts.get === 'function' ? sessionStarts.get(id) : null);
  const bornBefore = (id, from) => { const t = startOf(id); return t != null && Date.parse(t) < Date.parse(from); };
  const groups = new Map();
  const lastBySession = new Map();
  for (const s of snaps) {
    const g = groupOf(s);
    let grp = groups.get(g);
    if (!grp) {
      grp = { resets_at: s[resetKey], from: s.ts, to: s.ts, pct_from: s[window], pct_to: s[window], spend_usd: 0, snapshots: 0 };
      groups.set(g, grp);
    }
    const prev = lastBySession.get(s.session);
    let inc = 0;
    if (prev && groupOf(prev) === g) {
      inc = s.cost_usd >= prev.cost_usd ? s.cost_usd - prev.cost_usd : s.cost_usd; // a drop = /clear
    } else if (!prev && s.ts > grp.from && !bornBefore(s.session, grp.from)) {
      inc = s.cost_usd; // a session born inside the window
    }
    grp.spend_usd += inc;
    grp.snapshots += 1;
    grp.to = s.ts;
    grp.pct_from = Math.min(grp.pct_from, s[window]);
    grp.pct_to = Math.max(grp.pct_to, s[window]);
    lastBySession.set(s.session, s);
  }
  const out = [];
  for (const grp of groups.values()) {
    const delta = Math.round((grp.pct_to - grp.pct_from) * 100) / 100;
    if (delta < minDeltaPct || grp.spend_usd <= 0) continue;
    const perPct = grp.spend_usd / delta;
    out.push({ ...grp, spend_usd: Math.round(grp.spend_usd * 100) / 100, delta_pct: delta,
      usd_per_pct: Math.round(perPct * 1000) / 1000, capacity_usd: Math.round(perPct * 100 * 100) / 100 });
  }
  return out;
}

// Tokens of each kind per list-price dollar, from sessions seen by BOTH sides (a transcript and
// the status line). Multiplying a capacity in dollars by it answers "how many tokens is a week" for
// the mix this project really has — a mix, not a constant: cache reads are a tenth of the price of
// fresh input, so a different workload gives a different token count for the same dollars.
export function tokensPerUsd(sessionUsages, snapshots) {
  const finalCost = new Map();
  for (const s of snapshots || []) {
    if (s && s.session) finalCost.set(s.session, Math.max(finalCost.get(s.session) || 0, num(s.cost_usd)));
  }
  let usd = 0;
  const tokens = zero();
  for (const u of sessionUsages || []) {
    const c = finalCost.get(u && u.session);
    if (!c) continue;
    usd += c;
    addInto(tokens, u.total || zero());
  }
  if (usd <= 0) return null;
  const per = { usd: Math.round(usd * 100) / 100 };
  for (const k of TOKEN_KINDS) per[k] = tokens[k] / usd;
  per.total = totalTokens(tokens) / usd;
  return per;
}

export function median(values) {
  const v = (values || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// The one line the status bar shows. Short on purpose: it shares the row with nothing, but a
// terminal is narrow.
export function statusLine(payload, now = new Date()) {
  const p = payload || {};
  const parts = [];
  const model = p.model && (p.model.display_name || p.model.id);
  if (model) parts.push(`[${model}]`);
  const isNum = v => v !== null && v !== undefined && Number.isFinite(Number(v));
  const ctx = p.context_window && p.context_window.used_percentage;
  if (isNum(ctx)) parts.push(`ctx ${Math.round(ctx)}%`);
  const rl = p.rate_limits || {};
  const left = at => {
    const s = Math.max(0, Math.round(num(at) - new Date(now).getTime() / 1000));
    if (s >= 86400) return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
    return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  };
  const win = (label, w) => {
    if (!w || w.used_percentage == null) return;
    parts.push(`${label} ${Math.round(w.used_percentage)}%` + (w.resets_at ? ` (${left(w.resets_at)})` : ''));
  };
  win('5h', rl.five_hour);
  win('week', rl.seven_day);
  const cost = p.cost && p.cost.total_cost_usd;
  if (isNum(cost)) parts.push(`$${Number(cost).toFixed(2)} list`);
  return parts.join(' · ');
}
