// core/turn-retry.mjs — telling transient failures apart from real errors (v1.5.0).
//
// WHY. Before this version ANY failed turn stopped the whole loop (`turn_failed`). For unattended
// operation that is fatal: one random network error kills the run until a human shows up. That is
// exactly how the first v1.3.0 acceptance run died — the engine returned
// "UnknownError: Unexpected server error" and the loop simply ended, although a retry would have
// gone through.
//
// HOW WE SPLIT THEM (from first principles, not from a list of folklore):
//   - **transient** — REPEATING THE SAME ACTION has a chance of succeeding: the network blinked,
//     the server is overloaded, a rate limit was hit, a wait expired;
//   - **real** — repeating is pointless because nothing will change: an invalid key, an unknown
//     model, no money left, an empty prompt. Retrying only burns time and budget;
//   - **unknown** — not recognised. In unattended mode such an error is more often transient than
//     fatal, so we retry but FEWER times: the cost one way is a lost turn, the cost the other way
//     is budget burned for nothing.
//
// The module is pure: no I/O and no sleeping. The caller (the supervisor) performs the pause, and
// tests substitute it — otherwise the resilience test itself would be slow and flaky.
import { DEFAULT_NETWORK_RETRIES } from './engine-settings.mjs';

// Retrying makes sense: the state on the other side may change by itself.
const TRANSIENT = [
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ERR_NAME_NOT_RESOLVED)\b/i,
  /no such host is known|\bos error\s*(?:11001|11004)\b/i,
  /socket hang up|network error|fetch failed|connection (?:reset|closed|aborted)/i,
  /\b(?:408|429|500|502|503|504|509|520|521|522|523|524)\b/,
  /rate.?limit|too many requests|quota.*(?:per|minute|second)|throttl/i,
  /overloaded|server error|internal error|service unavailable|bad gateway|gateway timeout/i,
  /timed? ?out|timeout|aborted by timeout/i,
  /temporar|try again|retry/i,
  /unknownerror/i,          // the real v1.3.0 case: "UnknownError: Unexpected server error"
];

// Retrying is useless: without human intervention nothing will change.
const REAL_STATUS = /\b(?:401|403|404)\b/;
const REAL = [
  REAL_STATUS,
  /invalid.*(?:api.?key|token|credential)|unauthorized|authentication|not authenticated/i,
  /no such model|model not found|unknown model|unsupported model|no endpoints found/i,
  /model.*(?:not supported|not found)|Codex event format|Codex config overrides|Invalid Codex|cannot enforce maxBudgetUsd/i,
  /insufficient (?:credit|funds|balance)|\b402\b|payment required/i,
  /permission denied|not permitted/i,
  /empty prompt/i,
  /ENOENT|command not found|is not recognized/i,   // the engine is not installed — retrying will not help
];

/**
 * Classify an error text as 'transient' | 'fatal' | 'unknown' | 'usage_limited'.
 * Real errors are checked FIRST: a string like "401 rate limit" must stop the loop instead of
 * spinning through pointless retries.
 */
export function classifyFailure(error) {
  const text = String(error && error.message ? error.message : error || '');
  if (!text.trim()) return 'unknown';
  if (/^\s*Child cleanup refused:/i.test(text)) return 'fatal';
  if (/^\s*Invalid Codex protection:/i.test(text)) return 'fatal';
  // Codex preserves the wire type as a prefix. A wrong model called "usage_limited" must not
  // turn an explicit invalid request into a subscription pause by matching its arbitrary text.
  if (/^\s*invalid_request_error(?:\s*:|\s*$)/i.test(text)) return 'fatal';
  if (/usage_limited|usage_limit_reached|(?:hit|reached|exceeded) (?:your |the )?usage limit/i.test(text)) return 'usage_limited';
  // A proxy's HTML 403 is transport failure, whereas a provider's JSON 403 remains fatal.
  // Explicit credentials/model/payment errors still outrank an attached proxy page.
  const proxyPage = /\b403\b/.test(text) && /<!doctype\s+html|<html(?:\s|>)/i.test(text)
    && !/\b(?:401|402|404)\b/.test(text);
  for (const p of REAL) if (p.test(text) && !(p === REAL_STATUS && proxyPage)) return 'fatal';
  if (proxyPage) return 'transient';
  for (const p of TRANSIENT) if (p.test(text)) return 'transient';
  return 'unknown';
}

// How many attempts each kind of failure is allowed (the first attempt is not a retry).
export const ATTEMPTS = Object.freeze({ transient: DEFAULT_NETWORK_RETRIES, unknown: 2, fatal: 0, usage_limited: 0 });

export function maxRetries(kind, limits = ATTEMPTS) {
  if (kind === 'fatal' || kind === 'usage_limited') return 0;
  return limits[kind] ?? 0;
}

/**
 * Pause before the next attempt: doubling with a ceiling.
 * Jitter exists so that several loops that failed at the same moment do not all come back within
 * the same second. Tests switch jitter off through the parameter.
 */
export function backoffMs(attempt, { baseMs = 5000, maxMs = 300000, jitter = 0 } = {}) {
  const n = Math.max(1, Number(attempt) || 1);
  const growth = Math.min(baseMs * 2 ** (n - 1), maxMs);
  return Math.min(maxMs, Math.round(growth * (1 + jitter)));
}

/**
 * Decision about a failed turn: retry or stop.
 * @returns {{retry: boolean, kind: string, attempt: number, delayMs: number, reason: string}}
 */
export function decideRetry({ error, attempt = 1, limits = ATTEMPTS, backoff = {} } = {}) {
  const kind = classifyFailure(error);
  const limit = maxRetries(kind, limits);
  const text = String(error && error.message ? error.message : error || 'no description').slice(0, 200);
  if (kind === 'usage_limited') return { retry: false, kind, attempt, delayMs: 0,
    reason: `subscription usage limit reached — paused until reset: ${text}` };

  if (attempt > limit) {
    return {
      retry: false, kind, attempt, delayMs: 0,
      reason: limit === 0
        ? `real error (a retry will not help): ${text}`
        : `transient failure did not clear within ${limit} retries: ${text}`,
    };
  }
  const delayMs = backoffMs(attempt, backoff);
  return {
    retry: true, kind, attempt, delayMs,
    reason: `${kind === 'transient' ? 'transient failure' : 'unrecognised failure'}, attempt ${attempt}${Number.isFinite(limit) ? ` of ${limit}` : ' without a retry limit'}, pausing ${Math.round(delayMs / 1000)} s: ${text}`,
  };
}

export const NETWORK_NOTICE_AFTER_MS = 10 * 60 * 1000;

// One notification per uninterrupted network outage, shared by startup and working retries.
export function networkOutage(previous, { kind = 'transient', now = Date.now() } = {}) {
  if (kind !== 'transient') return { ...previous, notify: false };
  const startedAt = previous?.startedAt ?? now;
  const notify = !previous?.notified && now - startedAt >= NETWORK_NOTICE_AFTER_MS;
  return { startedAt, notified: Boolean(previous?.notified || notify), notify };
}
