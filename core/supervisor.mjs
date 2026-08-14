#!/usr/bin/env node
// core/supervisor.mjs — the external Ralph Loop supervisor (an agent-independent loop driver).
//
// v0.8.0. WHY: external engines have no Stop hook forcing continuation, so the loop is driven FROM
// THE OUTSIDE. The supervisor reads STATE.md → core/gates.decideContinuation →
// backend.runTurn(next_step_prompt) → atomically updates STATE (iteration++) → repeat; on a stop
// gate it sends an alert and exits.
//
// For the 'claude' backend the supervisor is an ALTERNATIVE to the Stop hook (inactive by default:
// the current loop lives on the Stop hook, so there is no regression). For 'opencode' it is the
// primary driver.
//
// Run:     AGENT_BACKEND=opencode node core/supervisor.mjs [--state docs/STATE.md] [--max N]
//                                              [--dry-run] [--no-preflight]
// Import:  import { runLoop } from './core/supervisor.mjs'

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseYaml } from '../lib/yaml-mini.mjs';
import { decideContinuation } from './gates.mjs';
import { acquireLock, refreshLock, releaseLock } from './loop-lock.mjs';
import { decideRetry } from './turn-retry.mjs';
import { preflight, explainFailure } from './preflight.mjs';
import { setChildRegistryFile, sweepStaleChildren, killAllChildren } from './backends/spawn-cli.mjs';
import { getBackend } from './backend-factory.mjs';
import { routeModel, presetForBackend } from './model-routing.mjs';
import { captureSnapshot, assessProgress, escalationDirective } from './progress.mjs';
import { noticeAfterTurn } from './secret-notice.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // framework root (../ from core/)

function readState(stateFile) {
  if (!existsSync(stateFile)) throw new Error(`STATE not found: ${stateFile}`);
  const raw = readFileSync(stateFile, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) throw new Error('STATE has no YAML frontmatter');
  return parseYaml(m[1]);
}

function writeStatePatch(stateFile, patch) {
  const res = spawnSync(process.execPath, [join(ROOT, 'lib', 'update-state.mjs'), stateFile],
    { input: JSON.stringify(patch), encoding: 'utf8' });
  return res && res.status === 0;
}

function notify(subject, body) {
  const tns = join(ROOT, 'lib', 'telegram-notify.sh');
  if (existsSync(tns) && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    try { spawnSync('bash', [tns, subject, body], { stdio: 'ignore', timeout: 15000 }); } catch { /* not critical */ }
  }
}

// The main loop. Returns the reason it finished.
export async function runLoop({
  stateFile = join(ROOT, 'docs', 'STATE.md'),
  backendId,
  cwd = process.cwd(),
  model,
  maxLoops = Infinity,
  dryRun = false,
  sessionId = `supervisor-${process.pid}`,
  backend = null,   // Backend injection (for tests / DI); defaults to the factory by backendId
  useLock = true,   // v1.5.0: the loop lock; disabled in tests that only care about turn logic
  usePreflight = true,  // v1.5.0: engine self-check before the loop; --no-preflight disables it
  retryLimits,      // v1.5.0: retry limits per failure kind (for tests)
  retryBackoff,     // v1.5.0: pause parameters (for tests — so they do not really wait)
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  backend = backend || getBackend(backendId);
  // v1.3.0: if no model was given explicitly, take it from the routing table for this backend.
  // PREVIOUSLY, without --model no model was passed at all and the external engine fell back to
  // its own default; on OpenCode that produced "no endpoints found for tools", while the
  // OPENROUTER_MODEL_* variables were silently ignored. A gap in the core, not an engine quirk.
  if (!model) model = routeModel('implement', presetForBackend(backend.id, process.env));

  // v1.5.0 — THE LOOP LOCK. Found in practice: two supervisors on the same docs/STATE.md competed
  // for writes, and the iteration counter and commits got mixed up. A live owner → an honest
  // refusal; a dead or hung one → take-over, because a crashed process must not stop autonomy
  // forever.
  const projectDir = dirname(dirname(stateFile));
  let lockHeld = false;
  if (useLock) {
    const lock = acquireLock({ projectDir, engine: 'supervisor', sessionId });
    if (!lock.acquired) {
      process.stderr.write(`[supervisor] launch refused: ${lock.reason}\n`);
      return { stopped: 'locked', loops: 0, reason: lock.reason };
    }
    lockHeld = true;
    if (lock.takenOver) process.stdout.write(`[supervisor] ${lock.reason}\n`);

    // v1.5.0, line of defence 2 against orphans: an on-disk child registry. When the parent is
    // killed HARD (`kill -9`, `taskkill /F`) exit handlers do not run at all — proven by
    // experiment. So we finish off whatever the predecessor left and keep our own registry.
    setChildRegistryFile(join(projectDir, 'docs', '.loop-children'));
    const swept = sweepStaleChildren();
    if (swept > 0) process.stdout.write(`[supervisor] orphaned engine processes killed: ${swept}\n`);
    // Release the lock on any exit, signals included: otherwise an abandoned lock would hold the
    // project until its time-to-live expired.
    const release = () => {
      killAllChildren();                       // line 1: our children leave together with us
      if (lockHeld) { releaseLock({ projectDir }); lockHeld = false; }
    };
    process.once('exit', release);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.once(signal, () => { release(); process.exit(130); });
    }
  }

  const finish = (result) => {
    if (useLock && lockHeld) { releaseLock({ projectDir }); lockHeld = false; }
    return result;
  };

  // v1.5.0 — ENGINE SELF-CHECK. One tiny turn is cheaper than a loop spinning for nothing.
  // It catches two classes of trouble at once: a changed response format (turns "succeed" but come
  // back empty) and a misconfiguration (model or key) that would otherwise masquerade as a
  // transient failure and cost 75 seconds of retries — measured during development.
  if (usePreflight && !dryRun) {
    const probe = await preflight({ backend, model, cwd });
    if (!probe.ok) {
      process.stderr.write(`${explainFailure({
        problems: probe.problems, backendId: backend.id, model,
      })}\n`);
      notify('Supervisor: preflight failed', probe.problems.join('; '));
      return finish({ stopped: 'preflight_failed', loops: 0, problems: probe.problems });
    }
    for (const note of probe.notes) process.stderr.write(`[supervisor] self-check note: ${note}\n`);
    process.stdout.write(`[supervisor] engine self-check passed in ${Math.round(probe.ms / 1000)} s\n`);
  }

  let loops = 0;
  let stagnantTurns = 0;   // v1.1.0: consecutive turns without measurable progress
  for (;;) {
    if (loops >= maxLoops) return finish({ stopped: 'max_loops', loops });
    const state = readState(stateFile);
    const decision = decideContinuation(state, { sessionId });

    if (decision.action === 'stop') {
      if (decision.notify) notify(decision.notify.subject, decision.notify.body);
      return finish({ stopped: decision.stopCause, loops });
    }

    if (dryRun) {
      // Dry run: show what would be executed, touch neither the filesystem nor the agent.
      process.stdout.write(`[dry-run] backend=${backend.id} iter→${decision.next.iteration} prompt="${decision.reason.slice(0, 80)}..."\n`);
      return finish({ stopped: 'dry_run', loops, wouldRun: decision.reason });
    }

    // v1.1.0 Phase 2: after 2 empty turns in a row, add an escalation directive to the prompt.
    let prompt = decision.reason;
    if (stagnantTurns >= 2) prompt = escalationDirective(prompt, stagnantTurns);

    // v1.5.0: confirm the loop is still ours and refresh the heartbeat.
    if (useLock && lockHeld && !refreshLock({ projectDir })) {
      process.stderr.write('[supervisor] the loop lock was taken over by another process — stopping\n');
      lockHeld = false;
      return { stopped: 'lock_lost', loops };
    }

    // v1.3.0: before every turn the backend restores its scaffolding. Found by live acceptance:
    // the agent wiped the guard plugin with an ordinary `git clean -fd .` and carried on without it.
    if (typeof backend.ensureReady === 'function') {
      try {
        const r = await backend.ensureReady({ cwd });
        if (r && r.restored && r.restored.length) {
          process.stdout.write(`[supervisor] backend scaffolding restored: ${r.restored.join(', ')}\n`);
        }
      } catch (e) { process.stderr.write(`[supervisor] could not restore scaffolding: ${e.message}\n`); }
    }

    // One agent turn on the selected backend (plus the per-turn spending guard when a cap is set).
    //
    // v1.5.0 — RESILIENCE TO FAILURES. Previously any failed turn stopped the whole loop, and one
    // random network error killed an unattended run until a human arrived (a real case: the v1.3.0
    // acceptance run died on "UnknownError: Unexpected server error"). Now transient failures are
    // survived with retries and a growing pause, while real errors still stop immediately:
    // retrying them is pointless and only wastes time and budget.
    const before = captureSnapshot({ cwd, stateFile });
    let turn = null;
    for (let attempt = 1; ; attempt++) {
      turn = await backend.runTurn({ prompt, cwd, model, maxBudgetUsd: remainingBudgetUsd(state) });
      if (turn.ok) {
        if (attempt > 1) process.stdout.write(`[supervisor] turn succeeded on attempt ${attempt}\n`);
        break;
      }
      const verdict = decideRetry({ error: turn.error, attempt, limits: retryLimits, backoff: retryBackoff });
      if (!verdict.retry) {
        process.stderr.write(`[supervisor] turn failed — ${verdict.reason}\n`);
        notify('Supervisor: turn failed', `backend=${backend.id} kind=${verdict.kind} error=${turn.error || 'unknown'}`);
        return finish({ stopped: 'turn_failed', loops, error: turn.error, failureKind: verdict.kind });
      }
      process.stdout.write(`[supervisor] ${verdict.reason}\n`);
      await sleep(verdict.delayMs);
      // While we waited the lock could have been taken over — check the loop is still ours.
      if (useLock && lockHeld && !refreshLock({ projectDir })) {
        lockHeld = false;
        return { stopped: 'lock_lost', loops };
      }
    }
    // Progress is assessed BEFORE we write our own iteration counter into STATE — otherwise the
    // supervisor would mistake its own write for the agent's progress.
    const after = captureSnapshot({ cwd, stateFile });
    const progress = assessProgress(before, after);

    // v1.5.0 — the secrets notice. It BLOCKS NOTHING, by an explicit user decision: the ability to
    // commit a key is fully preserved. Our job is to inform, not to obstruct. A real case from
    // v1.4.0: in a target project `.env` turned out to be tracked by git, and an agent running
    // `git add -A` would have committed a key into it — only human eyes caught it that time.
    try {
      const notice = noticeAfterTurn({ cwd, before, after });
      if (notice) {
        process.stderr.write(`[supervisor] WARNING: ${notice.message}\n`);
        notify('Supervisor: secrets in a commit', notice.message);
      }
    } catch { /* an observer must never be able to break a turn */ }
    stagnantTurns = progress.progressed ? 0 : stagnantTurns + 1;

    // Atomically record progress in STATE (iteration++, session_count, last_session_id);
    // on the 3rd empty turn in a row, add a no_progress blocker in the same atomic patch.
    const patch = {
      iteration: decision.next.iteration,
      last_session_id: sessionId,
      session_count: decision.next.sessionCount,
    };

    // Accumulating the actual cost (v1.4.0). Found by the claims audit: the budget gate COMPARED
    // version_cost_usd against the cap, but nobody ever wrote it — even though the turn cost is
    // parsed and returned by the backend. The guard would never have fired.
    if (Number.isFinite(turn.costUsd) && turn.costUsd > 0) {
      const previous = Number.parseFloat((state.budget_metrics || {}).version_cost_usd) || 0;
      patch.budget_metrics = { version_cost_usd: Math.round((previous + turn.costUsd) * 10000) / 10000 };
    }
    if (stagnantTurns >= 3) {
      patch.blockers = [{
        type: 'no_progress',
        detail: `${stagnantTurns} consecutive turns without measurable progress (git and STATE unchanged), escalation did not help`,
        at: new Date().toISOString(),
      }];
    }
    const ok = writeStatePatch(stateFile, patch);
    if (!ok) {
      notify('Supervisor: STATE update failed', 'Could not write STATE — stopping to avoid an endless loop.');
      return finish({ stopped: 'state_write_failed', loops });
    }
    loops++;
    if (stagnantTurns >= 3) {
      notify('Ralph Loop: no progress',
        `${stagnantTurns} consecutive turns without progress — a no_progress blocker was written to STATE. See docs/failure-modes.md.`);
      return finish({ stopped: 'no_progress', loops });
    }
  }
}

// Remaining version budget (cap − spent) for --max-budget-usd; undefined when no cap is set.
// A zero or negative remainder never reaches here — the budget gate stops the loop earlier.
function remainingBudgetUsd(state) {
  const bm = (state.budget_metrics && typeof state.budget_metrics === 'object') ? state.budget_metrics : {};
  const cap = Number.parseFloat(bm.cap_usd) || 0;
  if (cap <= 0) return undefined;
  const rest = Math.round((cap - (Number.parseFloat(bm.version_cost_usd) || 0)) * 100) / 100;
  return rest > 0 ? rest : undefined;
}

// CLI mode.
function parseArgs(argv) {
  const o = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--no-preflight') o.usePreflight = false;
    else if (a === '--state') o.stateFile = argv[++i];
    else if (a === '--max') o.maxLoops = parseInt(argv[++i], 10);
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--backend') o.backendId = argv[++i];
  }
  return o;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runLoop(parseArgs(process.argv.slice(2)))
    .then(r => { process.stdout.write(JSON.stringify(r) + '\n'); process.exit(0); })
    .catch(e => { process.stderr.write(`supervisor: ${e.message}\n`); process.exit(1); });
}
