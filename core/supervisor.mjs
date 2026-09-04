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
import { inspectStateJobs } from './long-jobs.mjs';
import { acquireLock, refreshLock, releaseLock } from './loop-lock.mjs';
import { decideRetry } from './turn-retry.mjs';
import { preflight, explainFailure } from './preflight.mjs';
import { setChildRegistryFile, sweepStaleChildren, killAllChildren } from './backends/spawn-cli.mjs';
import { getBackend } from './backend-factory.mjs';
import { routeModel, presetForBackend } from './model-routing.mjs';
import { captureSnapshot, escalationDirective } from './progress.mjs';
import {
  readMemory, writeMemory, stagnantAfterTurn, ESCALATE_AFTER, BLOCK_AFTER, noProgressBlocker,
} from './turn-progress.mjs';
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
  // v1.15.0 — WHERE THE ENGINE RUNS. This defaulted to `process.cwd()`, so the supervisor drove one
  // project's STATE while running the engine in whatever directory it happened to be launched from.
  // Found the hard way: a run started from the framework directory with `--state` pointing
  // elsewhere launched a real Claude Code session INSIDE the framework project, on somebody else's
  // instruction, alongside a session already working there.
  //
  // The project is not a preference — it is `dirname(dirname(stateFile))`, which this function
  // already computes for the lock. Deriving the two from one source removes the possibility of them
  // disagreeing. `cwd` stays overridable for the rare case of a state file kept outside its project.
  cwd = null,
  model,
  maxLoops = Infinity,
  dryRun = false,
  sessionId = `supervisor-${process.pid}`,
  backend = null,   // Backend injection (for tests / DI); defaults to the factory by backendId
  useLock = true,   // v1.5.0: the loop lock; disabled in tests that only care about turn logic
  usePreflight = true,  // v1.5.0: engine self-check before the loop; --no-preflight disables it
  retryLimits,      // v1.5.0: retry limits per failure kind (for tests)
  retryBackoff,     // v1.5.0: pause parameters (for tests — so they do not really wait)
  // v1.15.0: how often the lock proves it is alive WHILE a turn runs. A minute is two orders of
  // magnitude below the lock's half-hour deadline and costs one small file write, so the guard
  // holds even if a few beats are missed. Tests shorten it so they do not have to wait.
  heartbeatMs = 60 * 1000,
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
  if (!cwd) cwd = projectDir;      // the project it drives, never the directory it was called from
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

  // Every exit from the loop goes through here, so the two things that must not outlive it — our
  // hold on the lock and our engine processes — are cleaned up exactly once, whether the loop was
  // stopped by a gate, a failure, or the loss of the lock.
  //
  // v1.15.0: killing the children used to be wired ONLY to process exit. Run as a library — which
  // is how a wrapper, and every test, runs it — nothing exits, and an abandoned loop left its
  // engine running. Proven by a probe that started a real process and found it still alive after
  // runLoop had returned.
  const finish = (result) => {
    if (useLock) {
      killAllChildren();
      if (lockHeld) { releaseLock({ projectDir }); lockHeld = false; }
    }
    return result;
  };

  // v1.5.0 — ENGINE SELF-CHECK. One tiny turn is cheaper than a loop spinning for nothing.
  // It catches two classes of trouble at once: a changed response format (turns "succeed" but come
  // back empty) and a misconfiguration (model or key) that would otherwise masquerade as a
  // transient failure and cost 75 seconds of retries — measured during development.
  //
  // v1.15.0 — WHEN it runs. It used to run before the state had even been read, so starting the
  // supervisor on a finished version, on a blocked one, or on one past its cap spent a paid engine
  // call in order to then announce that there was nothing to do. It is now deferred until the gates
  // have said there is work: nothing is paid for before we know it will be used.
  let selfChecked = !usePreflight || dryRun;
  const selfCheck = async () => {
    if (selfChecked) return null;
    selfChecked = true;
    const probe = await preflight({ backend, model, cwd });
    if (!probe.ok) {
      process.stderr.write(`${explainFailure({
        problems: probe.problems, backendId: backend.id, model,
      })}\n`);
      notify('Supervisor: preflight failed', probe.problems.join('; '));
      return { stopped: 'preflight_failed', loops: 0, problems: probe.problems };
    }
    for (const note of probe.notes) process.stderr.write(`[supervisor] self-check note: ${note}\n`);
    process.stdout.write(`[supervisor] engine self-check passed in ${Math.round(probe.ms / 1000)} s\n`);
    return null;
  };

  const docsDir = dirname(stateFile);
  let loops = 0;
  let stagnantTurns = 0;   // v1.1.0: consecutive turns without measurable progress
  for (;;) {
    if (loops >= maxLoops) return finish({ stopped: 'max_loops', loops });
    const state = readState(stateFile);
    const jobs = inspectStateJobs(state, { cwd });
    const decision = decideContinuation(state,
      { sessionId, driver: 'supervisor', jobs, projectDir });
    for (const j of jobs) {
      if (j.state === 'died' || j.state === 'overdue') {
        process.stderr.write(`[supervisor] job ${j.id} is ${j.state} — ${j.why}\n`);
      }
      // v1.14.0: a self-contradicting record — an unreadable deadline, a marker with nowhere to
      // look for it — used to be ignored in silence, which is how a guard stops guarding.
      for (const w of (j.warnings || [])) {
        process.stderr.write(`[supervisor] job ${j.id} — ${w}\n`);
      }
    }

    // v1.7.0: same as in the Stop hook — an instruction quietly dropped is a quiet failure.
    if (decision.staleNextPrompt) {
      process.stderr.write(
        `[supervisor] the recorded step instruction was dropped — ${decision.staleNextPrompt.why}\n`);
    }

    if (decision.action === 'stop') {
      if (decision.notify) notify(decision.notify.subject, decision.notify.body);
      return finish({ stopped: decision.stopCause, loops });
    }

    if (dryRun) {
      // Dry run: show what would be executed, touch neither the filesystem nor the agent.
      process.stdout.write(`[dry-run] backend=${backend.id} iter→${decision.next.iteration} prompt="${decision.reason.slice(0, 80)}..."\n`);
      return finish({ stopped: 'dry_run', loops, wouldRun: decision.reason });
    }

    // The engine is checked only now, when the gates have confirmed there is work to pay for.
    const probeFailure = await selfCheck();
    if (probeFailure) return finish(probeFailure);

    // v1.15.0 — HOW MANY EMPTY TURNS HAVE ALREADY HAPPENED, read from the shared memory rather than
    // from a variable of our own. The rule "two escalate, three block" used to exist twice: on disk
    // for the Stop hook, and in a local variable here — so restarting the supervisor reset the count
    // to zero and the blocker could never arrive on a run that was interrupted and resumed. One
    // rule, one storage, one function that decides.
    stagnantTurns = (readMemory(docsDir) || { stagnant: 0 }).stagnant;

    // v1.1.0 Phase 2: after ESCALATE_AFTER empty turns in a row, add a directive to the prompt.
    // The threshold and the wording live in core/turn-progress.mjs, so this driver and the Stop hook
    // cannot come to disagree about what the rule is.
    let prompt = decision.reason;
    if (stagnantTurns >= ESCALATE_AFTER) prompt = escalationDirective(prompt, stagnantTurns);

    // v1.5.0: confirm the loop is still ours and refresh the heartbeat.
    if (useLock && lockHeld && !refreshLock({ projectDir })) {
      process.stderr.write('[supervisor] the loop lock was taken over by another process — stopping\n');
      lockHeld = false;
      return finish({ stopped: 'lock_lost', loops });
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
    // The baseline for this turn goes into the shared memory before the turn starts, so that the
    // very same function judges an empty turn for both drivers. The memory file is ignored by git
    // and is therefore not part of the snapshot it holds — it cannot register as its own progress.
    const before = captureSnapshot({ cwd, stateFile });
    writeMemory(docsDir, before, stagnantTurns);

    // While a turn runs, the lock must keep proving it is alive. It used to be refreshed only
    // BETWEEN turns, and the deadline had been chosen from a number that was not the number:
    // core/loop-lock.mjs claimed a turn is capped at 15 minutes, while the actual cap is FOUR HOURS
    // — eight times the lock's deadline rather than half of it. So an ordinary long turn could have
    // its lock taken from underneath a working process, which is precisely the corruption the lock
    // exists to prevent. A beat inside the turn also gives "the process is alive but its heartbeat
    // is old" its meaning back: it now really does mean hung.
    let heartbeat = null;
    if (useLock && lockHeld && heartbeatMs > 0) {
      heartbeat = setInterval(() => {
        if (!refreshLock({ projectDir })) { clearInterval(heartbeat); heartbeat = null; }
      }, heartbeatMs);
      heartbeat.unref?.();       // a timer must never be the reason a process refuses to exit
    }
    const stopHeartbeat = () => { if (heartbeat) { clearInterval(heartbeat); heartbeat = null; } };

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
        stopHeartbeat();
        return finish({ stopped: 'turn_failed', loops, error: turn.error, failureKind: verdict.kind });
      }
      process.stdout.write(`[supervisor] ${verdict.reason}\n`);
      await sleep(verdict.delayMs);
      // While we waited the lock could have been taken over — check the loop is still ours.
      if (useLock && lockHeld && !refreshLock({ projectDir })) {
        lockHeld = false;
        stopHeartbeat();
        return finish({ stopped: 'lock_lost', loops });
      }
    }
    stopHeartbeat();

    // v1.15.0 — CHECKED AFTER THE TURN, NOT ONLY BEFORE IT. The lock can be lost while a turn is in
    // flight; the beat above simply stops when that happens. Writing our bookkeeping into a state
    // that now belongs to another driver is precisely the corruption the lock exists to prevent, so
    // we stop BEFORE the write rather than discovering it on the next pass. Found by the probe
    // written for the orphaned-process defect, which is why it is worth writing probes that use real
    // processes: this path had no test and no reader had noticed it.
    if (useLock && lockHeld && !refreshLock({ projectDir })) {
      lockHeld = false;
      process.stderr.write('[supervisor] the loop lock was taken over during the turn — stopping before writing STATE\n');
      return finish({ stopped: 'lock_lost', loops });
    }
    // Progress is assessed BEFORE we write our own iteration counter into STATE — otherwise the
    // supervisor would mistake its own write for the agent's progress.
    const after = captureSnapshot({ cwd, stateFile });

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
    stagnantTurns = stagnantAfterTurn(readMemory(docsDir), after);
    writeMemory(docsDir, after, stagnantTurns);

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
    if (stagnantTurns >= BLOCK_AFTER) patch.blockers = [noProgressBlocker(stagnantTurns)];
    const ok = writeStatePatch(stateFile, patch);
    if (!ok) {
      notify('Supervisor: STATE update failed', 'Could not write STATE — stopping to avoid an endless loop.');
      return finish({ stopped: 'state_write_failed', loops });
    }
    loops++;
    if (stagnantTurns >= BLOCK_AFTER) {
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
//
// v1.15.0 — AN OPTION THAT ASKS FOR A LIMIT MUST NEVER BECOME THE ABSENCE OF ONE. `--max` used to
// be `parseInt(argv[++i], 10)`, so `--max` with a typo, or with no value at all, produced NaN — and
// `loops >= NaN` is false for ever. Measured before the fix:
//
//     maxLoops = NaN | loops >= maxLoops -> false -> no limit at all
//
// A person who typed a cap and mistyped the number got an unbounded unattended run. That is the
// worst available reading of the request, so every option now refuses rather than guesses. Returning
// the error instead of exiting keeps the parser testable.
export function parseArgs(argv) {
  const o = { dryRun: false };
  const value = (flag, i) => {
    const v = argv[i + 1];
    if (v === undefined || String(v).startsWith('--')) { o.error = `${flag} needs a value`; return null; }
    return v;
  };
  for (let i = 0; i < argv.length && !o.error; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--no-preflight') o.usePreflight = false;
    else if (a === '--state') { const v = value(a, i); if (v !== null) { o.stateFile = v; i++; } }
    else if (a === '--model') { const v = value(a, i); if (v !== null) { o.model = v; i++; } }
    else if (a === '--backend') { const v = value(a, i); if (v !== null) { o.backendId = v; i++; } }
    else if (a === '--cwd') { const v = value(a, i); if (v !== null) { o.cwd = v; i++; } }
    else if (a === '--max') {
      const v = value(a, i);
      if (v !== null) {
        i++;
        const n = Number.parseInt(v, 10);
        // Zero and negatives are refused too: elsewhere in the framework they mean "no limit"
        // (v1.9.0), and here the user is explicitly asking FOR a limit. Silently granting the
        // opposite of what was asked is the defect being fixed.
        if (!Number.isFinite(n) || n <= 0) o.error = `--max needs a positive whole number, got ${JSON.stringify(v)}`;
        else o.maxLoops = n;
      }
    } else o.error = `unknown option ${a}`;
  }
  return o;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`supervisor: ${args.error}\n`);
    process.stderr.write('usage: supervisor.mjs [--state <file>] [--cwd <dir>] [--max <n>] [--model <m>] [--backend <id>] [--dry-run] [--no-preflight]\n');
    process.exit(2);
  }
  delete args.error;
  runLoop(args)
    .then(r => { process.stdout.write(JSON.stringify(r) + '\n'); process.exit(0); })
    .catch(e => { process.stderr.write(`supervisor: ${e.message}\n`); process.exit(1); });
}
