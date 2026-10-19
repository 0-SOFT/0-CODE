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
import { dirname, join, relative, resolve } from 'node:path';
import { parseYaml } from '../lib/yaml-mini.mjs';
import { decideContinuation } from './gates.mjs';
import { inspectStateJobs } from './long-jobs.mjs';
import { acquireLockEventually, refreshLock, refreshLockEventually, releaseLock, releaseLockEventually, LOCK_BUSY } from './loop-lock.mjs';
import { decideRetry, classifyFailure, ATTEMPTS, networkOutage } from './turn-retry.mjs';
import { preflight, explainFailure } from './preflight.mjs';
import { setChildRegistryFile, sweepStaleChildren, killAllChildren } from './backends/spawn-cli.mjs';
import { getBackend } from './backend-factory.mjs';
import { routeModel, presetForBackend } from './model-routing.mjs';
import { captureSnapshot, escalationDirective } from './progress.mjs';
import {
  readMemory, writeMemory, stagnantAfterTurn, progressPolicy, noProgressBlocker,
} from './turn-progress.mjs';
import { noticeAfterTurn } from './secret-notice.mjs';
import { resolveEngineSettings, parseDuration } from './engine-settings.mjs';
import { loadCodexEnvironment, loadEngineSettingsEnvironment } from '../lib/codex-env.mjs';
import { CONFIG_PATH, findProjectRoot, loadProjectConfig, isClaudeInstructionPath } from './project-config.mjs';
import { saveTurnJournal } from './turn-journal.mjs';

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
    { input: JSON.stringify(patch), encoding: 'utf8', windowsHide: true });
  if (res.status === 0) return { ok: true };
  const error = res.error?.message || String(res.stderr || '').trim()
    || `update-state exited ${res.status}, signal ${res.signal || 'none'}`;
  process.stderr.write(`[supervisor] STATE update failed: ${error}\n`);
  return { ok: false, error };
}

function sendNotification(subject, body, env) {
  const tns = join(ROOT, 'lib', 'telegram-notify.sh');
  if (existsSync(tns) && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try { return spawnSync('bash', [tns, subject, body], { env, stdio: 'ignore', timeout: 15000, windowsHide: true }).status === 0; }
    catch { /* not critical */ }
  }
  return false;
}

// The main loop. Returns the reason it finished.
export async function runLoop({
  stateFile = null,
  projectDir = null,
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
  effort, sandbox, timeoutMs, idleTimeoutMs, networkRetries,
  engineSettings = {},
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
  if (!projectDir) {
    const candidate = findProjectRoot(stateFile ? dirname(resolve(stateFile)) : cwd || process.cwd());
    projectDir = stateFile && !existsSync(join(candidate, CONFIG_PATH))
      ? dirname(dirname(resolve(stateFile))) : candidate;
  }
  projectDir = resolve(projectDir);
  if (!cwd) cwd = projectDir;
  const envFiles = [join(cwd, 'config', '.env'), join(cwd, '.env')];
  const project = loadProjectConfig({ projectDir,
    env: loadEngineSettingsEnvironment(envFiles, backend?.env || process.env) });
  stateFile = stateFile ? resolve(stateFile) : project.documentPath('state');
  const statePath = relative(projectDir, stateFile).replaceAll('\\', '/');
  if (project.config.instructions.claude === 'session-hook' && isClaudeInstructionPath(statePath)) throw new Error('session-hook state updates cannot write CLAUDE.md');
  const settingsEnv = project.guardEnvironment;
  if (project.installed && !settingsEnv.SAFETY_GUARD_LOG) settingsEnv.SAFETY_GUARD_LOG = project.runtimePath('guard.log');
  backend = backend || getBackend(backendId || settingsEnv.AGENT_BACKEND
    || (project.installed ? project.config.engines[0] : undefined), { env: settingsEnv, envFiles });
  const notificationEnv = loadCodexEnvironment([join(cwd, 'config', '.env'), join(cwd, '.env')],
    { ...process.env, ...settingsEnv }, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
  const notify = (subject, body) => (!project.installed || project.config.modules.telegram)
    && sendNotification(subject, body, notificationEnv);
  const explicit = Object.fromEntries(Object.entries({ model, effort, sandbox, timeoutMs, idleTimeoutMs, networkRetries })
    .filter(([, value]) => value !== undefined));
  const settings = resolveEngineSettings(backend.id, { ...engineSettings, ...explicit }, settingsEnv,
    project.config.engine_settings[backend.id] || {});
  retryLimits = { ...ATTEMPTS, transient: settings.networkRetries, ...retryLimits };
  model = settings.model || routeModel('implement', presetForBackend(backend.id, settingsEnv));
  const turnSettings = { ...settings, model, env: settingsEnv };
  let journalFiles=[];
  const recordAttempt = (turn, phase, attempt, iteration, startedAt) => {
    try {
      const file=saveTurnJournal(project,{engine:backend.id,supervisor_session:sessionId,phase,attempt,iteration,
        started_at:startedAt,finished_at:new Date().toISOString(),turn},
        {env:{...process.env,...backend.env,...settingsEnv}});
      if(file)journalFiles=[...journalFiles,relative(cwd,file).replaceAll('\\','/')];
    } catch {throw new Error('Supervisor attempt journal could not be saved');}
  };
  const runAttempt = async (options, phase, attempt, iteration) => {
    const startedAt=new Date().toISOString();
    let turn;
    try {turn=await backend.runTurn(options);}
    catch(error) {
      recordAttempt({ok:false,error:'exception while launching: '+String(error?.message||error)},phase,attempt,iteration,startedAt);
      throw error;
    }
    recordAttempt(turn,phase,attempt,iteration,startedAt);
    return turn;
  };

  // v1.5.0 — THE LOOP LOCK. Found in practice: two supervisors on the same docs/STATE.md competed
  // for writes, and the iteration counter and commits got mixed up. A live owner → an honest
  // refusal; a dead or hung one → take-over, because a crashed process must not stop autonomy
  // forever.
  if (dryRun) useLock = false;    // A preview must not acquire a lock or sweep the child registry.
  let lockHeld = false;
  let heartbeat = null;
  const stopHeartbeat = () => { if (heartbeat) { clearInterval(heartbeat); heartbeat = null; } };
  const release = () => {
    stopHeartbeat();
    if (useLock) {
      killAllChildren();
      if (lockHeld) { releaseLock({ projectDir }); lockHeld = false; }
    }
  };
  const confirmOwnership = async (loops) => {
    if (!useLock || !lockHeld) return null;
    const result = await refreshLockEventually({ projectDir });
    if (result === true) return null;
    if (result === LOCK_BUSY) {
      const reason = 'the loop lock is still being updated; ownership was not confirmed';
      process.stderr.write(`[supervisor] ${reason} — stopping without launching work or writing STATE\n`);
      return { stopped: 'lock_busy', loops, reason };
    }
    lockHeld = false;
    return { stopped: 'lock_lost', loops };
  };
  const signalHandlers = new Map();
  if (useLock) {
    const lock = await acquireLockEventually({ projectDir, engine: 'supervisor', sessionId });
    if (!lock.acquired) {
      process.stderr.write(`[supervisor] launch refused: ${lock.reason}\n`);
      return { stopped: lock.state === LOCK_BUSY ? 'lock_busy' : 'locked', loops: 0, reason: lock.reason };
    }
    lockHeld = true;
    if (lock.takenOver) process.stdout.write(`[supervisor] ${lock.reason}\n`);

    // v1.5.0, line of defence 2 against orphans: an on-disk child registry. When the parent is
    // killed HARD (`kill -9`, `taskkill /F`) exit handlers do not run at all — proven by
    // experiment. So we finish off whatever the predecessor left and keep our own registry.
    setChildRegistryFile(project.runtimePath('.loop-children'));
    const swept = sweepStaleChildren();
    if (swept > 0) process.stdout.write(`[supervisor] orphaned engine processes killed: ${swept}\n`);
    // Release the lock on any exit, signals included: otherwise an abandoned lock would hold the
    // project until its time-to-live expired.
    process.once('exit', release);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => { release(); process.exit(130); };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  }

  // The loop finally releases resources on normal returns and unexpected exceptions.
  const prepare = async (loops) => {
    if (typeof backend.ensureReady !== 'function') return null;
    try {
      const r = await backend.ensureReady({ cwd, ...turnSettings });
      if (r?.restored?.length) {
        process.stdout.write(`[supervisor] backend scaffolding restored: ${r.restored.join(', ')}\n`);
      }
      const ownershipFailure = await confirmOwnership(loops);
      if (ownershipFailure) return ownershipFailure;
      return null;
    } catch (e) {
      const error = `Could not restore backend protection: ${e?.message || String(e)}`;
      process.stderr.write(`[supervisor] ${error}\n`);
      return { stopped: 'protection_failed', loops, error };
    }
  };

  const observeOutage = (outage, kind = 'transient', recovered = false) => {
    Object.assign(outage, networkOutage(outage, { kind }));
    if (outage.notify) {
      const sent = notify('Supervisor: prolonged network outage', `Engine ${backend.id}; `
        + (recovered ? 'network recovered after more than ten minutes of downtime.'
          : 'offline for more than ten minutes; the loop waits for the network and retains project ownership.'));
      // A network outage can prevent the bot itself from reaching Telegram. Keep the
      // notice pending until delivered, including one last attempt when work recovers.
      if (!sent) outage.notified = false;
    }
  };
  const stopWhileWaiting = (loops) => {
    const state = readState(stateFile);
    const decision = decideContinuation(state, { sessionId, driver: 'supervisor', projectDir, project, statePath,
      jobs: inspectStateJobs(state, { cwd }) });
    if (decision.action !== 'stop') return null;
    if (decision.notify) notify(decision.notify.subject, decision.notify.body);
    return { stopped: decision.stopCause, loops };
  };
  const pauseForRetry = async (verdict, outage, loops) => {
    const stop = stopWhileWaiting(loops);
    if (stop) return stop;
    observeOutage(outage, verdict.kind);
    process.stdout.write(`[supervisor] ${verdict.reason}\n`);
    // Short waits keep ownership checks and the ten-minute alert active during the pause.
    for (let left = verdict.delayMs; left > 0;) {
      const chunk = Math.min(left, 60000);
      await sleep(chunk); left -= chunk;
      const ownershipFailure = await confirmOwnership(loops);
      if (ownershipFailure) return ownershipFailure;
      const stop = stopWhileWaiting(loops);
      if (stop) return stop;
      observeOutage(outage, verdict.kind);
    }
    return null;
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
    let probe;
    const outage = {};
    for (let attempt = 1; ; attempt++) {
      const startedAt=new Date().toISOString();
      probe = await preflight({ backend, model, cwd, ...turnSettings });
      if(probe.turn)recordAttempt(probe.turn,'preflight',attempt,0,startedAt);
      if (probe.ok) {
        if (outage.startedAt !== undefined) observeOutage(outage, 'transient', true);
        break;
      }
      const error = probe.turn?.error || probe.problems.join('; ');
      // Empty/malformed successful probes still fail immediately. Only proven temporary
      // transport failures deserve a startup retry.
      if (classifyFailure(error) !== 'transient') break;
      const verdict = decideRetry({ error, attempt, limits: retryLimits, backoff: retryBackoff });
      if (!verdict.retry) break;
      const ownershipFailure = await pauseForRetry(verdict, outage, 0);
      if (ownershipFailure) return ownershipFailure;
      const protectionFailure = await prepare(0);
      if (protectionFailure) return protectionFailure;
    }
    if (!probe.ok) {
      if (classifyFailure(probe.turn?.error) === 'usage_limited') {
        return { stopped: 'usage_limited', paused: true, loops: 0,
          error: probe.turn.error, ...(probe.turn.retryAt !== undefined ? { retryAt: probe.turn.retryAt } : {}) };
      }
      process.stderr.write(`${explainFailure({
        problems: probe.problems, backendId: backend.id, model, engineVersion: probe.engineVersion,
      })}\n`);
      notify('Supervisor: preflight failed', probe.problems.join('; '));
      return { stopped: 'preflight_failed', loops: 0, problems: probe.problems };
    }
    for (const note of probe.notes) process.stderr.write(`[supervisor] self-check note: ${note}\n`);
    process.stdout.write(`[supervisor] engine self-check passed in ${Math.round(probe.ms / 1000)} s\n`);
    return null;
  };

  const docsDir = project.installed ? project.runtimeDir : dirname(stateFile);
  let loops = 0;
  let stagnantTurns = 0;   // v1.1.0: consecutive turns without measurable progress
  try {
    for (;;) {
      if (loops >= maxLoops) return ({ stopped: 'max_loops', loops });
      const state = readState(stateFile);
      const progressLimits = progressPolicy(state);
      if (progressLimits.warning) process.stderr.write(`[supervisor] ${progressLimits.warning}\n`);
      const jobs = inspectStateJobs(state, { cwd });
      const decision = decideContinuation(state,
        { sessionId, driver: 'supervisor', jobs, projectDir, project, statePath });
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
        if (decision.notify && !dryRun) notify(decision.notify.subject, decision.notify.body);
        return ({ stopped: decision.stopCause, loops });
      }

      if (dryRun) {
        // Dry run: show what would be executed, touch neither the filesystem nor the agent.
        process.stdout.write(`[dry-run] backend=${backend.id} iter→${decision.next.iteration} prompt="${decision.reason.slice(0, 80)}..."\n`);
        return ({ stopped: 'dry_run', loops, wouldRun: decision.reason });
      }

      if (backend.id === 'codex' && Number.parseFloat(state.budget_metrics?.cap_usd) > 0) {
        return ({ stopped: 'unsupported_budget', loops,
          error: 'Codex cannot enforce cap_usd: exec reports tokens, not USD' });
      }

      // Cover restoration, the probe, working attempts and retry pauses with the same heartbeat.
      if (!heartbeat && useLock && lockHeld && heartbeatMs > 0) {
        heartbeat = setInterval(() => {
          if (refreshLock({ projectDir }) === false) stopHeartbeat();
        }, heartbeatMs);
        heartbeat.unref?.();
      }

      // The engine is checked only now, when the gates have confirmed there is work to pay for.
      if (!selfChecked) {
        const protectionFailure = await prepare(loops);
        if (protectionFailure) return (protectionFailure);
      }
      const probeFailure = await selfCheck();
      if (probeFailure) return (probeFailure);

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
      if (stagnantTurns >= progressLimits.escalateAfter) prompt = escalationDirective(prompt, stagnantTurns, statePath);

      // v1.5.0: confirm the loop is still ours and refresh the heartbeat.
      const ownershipFailure = await confirmOwnership(loops);
      if (ownershipFailure) return ownershipFailure;

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
      let before;

      // While a turn runs, the lock must keep proving it is alive. It used to be refreshed only
      // BETWEEN turns, and the deadline had been chosen from a number that was not the number:
      // core/loop-lock.mjs claimed a turn is capped at 15 minutes, while the actual cap is FOUR HOURS
      // — eight times the lock's deadline rather than half of it. So an ordinary long turn could have
      // its lock taken from underneath a working process, which is precisely the corruption the lock
      // exists to prevent. A beat inside the turn also gives "the process is alive but its heartbeat
      // is old" its meaning back: it now really does mean hung.
      let turn = null;
      const outage = {};
      for (let attempt = 1; ; attempt++) {
        const protectionFailure = await prepare(loops);
        if (protectionFailure) return (protectionFailure);
        // Restoration can be asynchronous: never launch after losing ownership during it.
        const ownershipFailure = await confirmOwnership(loops);
        if (ownershipFailure) return ownershipFailure;
        if (!before) {
          before = captureSnapshot({ cwd, stateFile, ignoredFiles:journalFiles });
          writeMemory(docsDir, before, stagnantTurns);
        }
        turn = await runAttempt({ prompt, cwd, model, ...turnSettings, maxBudgetUsd: remainingBudgetUsd(state) },'work',attempt,state.iteration);
        if (turn.ok) {
          if (outage.startedAt !== undefined) observeOutage(outage, 'transient', true);
          if (attempt > 1) process.stdout.write(`[supervisor] turn succeeded on attempt ${attempt}\n`);
          break;
        }
        const verdict = decideRetry({ error: turn.error, attempt, limits: retryLimits, backoff: retryBackoff });
        if (!verdict.retry) {
          if (verdict.kind === 'usage_limited') {
            process.stderr.write(`[supervisor] ${verdict.reason}\n`);
            return ({ stopped: 'usage_limited', paused: true, loops, error: turn.error,
              ...(turn.retryAt !== undefined ? { retryAt: turn.retryAt } : {}) });
          }
          process.stderr.write(`[supervisor] turn failed — ${verdict.reason}\n`);
          notify('Supervisor: turn failed', `backend=${backend.id} kind=${verdict.kind} error=${turn.error || 'unknown'}`);
          return ({ stopped: 'turn_failed', loops, error: turn.error, failureKind: verdict.kind });
        }
        const retryOwnershipFailure = await pauseForRetry(verdict, outage, loops);
        if (retryOwnershipFailure) return retryOwnershipFailure;
      }
      stopHeartbeat();

      // v1.15.0 — CHECKED AFTER THE TURN, NOT ONLY BEFORE IT. The lock can be lost while a turn is in
      // flight; the beat above simply stops when that happens. Writing our bookkeeping into a state
      // that now belongs to another driver is precisely the corruption the lock exists to prevent, so
      // we stop BEFORE the write rather than discovering it on the next pass. Found by the probe
      // written for the orphaned-process defect, which is why it is worth writing probes that use real
      // processes: this path had no test and no reader had noticed it.
      const finalOwnershipFailure = await confirmOwnership(loops);
      if (finalOwnershipFailure) return finalOwnershipFailure;
      // Progress is assessed BEFORE we write our own iteration counter into STATE — otherwise the
      // supervisor would mistake its own write for the agent's progress.
      const after = captureSnapshot({ cwd, stateFile, ignoredFiles:journalFiles });

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
      // An owner may change the threshold during the turn. Consult current STATE before stopping.
      let finalProgressLimits = progressLimits;
      try { finalProgressLimits = progressPolicy(readState(stateFile)); }
      catch (error) {
        // The atomic updater remains the authority for a malformed STATE. Let it report
        // the real refusal instead of throwing before the established failure path.
        process.stderr.write(`[supervisor] current STATE could not be read: ${error.message}\n`);
      }
      if (stagnantTurns >= finalProgressLimits.blockAfter) patch.blockers = [noProgressBlocker(stagnantTurns)];
      const written = writeStatePatch(stateFile, patch);
      if (!written.ok) {
        notify('Supervisor: STATE update failed', 'Could not write STATE — stopping to avoid an endless loop.');
        return ({ stopped: 'state_write_failed', loops, error: written.error });
      }
      loops++;
      if (stagnantTurns >= finalProgressLimits.blockAfter) {
        notify('Ralph Loop: no progress',
          `${stagnantTurns} consecutive turns without progress — a no_progress blocker was written to the state role. See the failure-mode guide.`);
        return ({ stopped: 'no_progress', loops });
      }
    }
  } finally {
    stopHeartbeat();
    try {
      if (useLock) {
        killAllChildren();
        if (lockHeld) {
          const released = await releaseLockEventually({ projectDir });
          if (released === LOCK_BUSY) process.stderr.write('[supervisor] loop lock release remains busy after bounded retries; owner record retained\n');
          lockHeld = false;
        }
      }
    } finally {
      process.removeListener('exit', release);
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
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
    else if (a === '--effort') { const v = value(a, i); if (v !== null) { o.effort = v; i++; } }
    else if (a === '--network-retries') {
      const v = value(a, i);
      if (v !== null) {
        const n = /^\d+$/.test(String(v)) ? Number(v) : NaN;
        if (!Number.isSafeInteger(n)) o.error = '--network-retries needs a nonnegative safe whole number';
        else o.networkRetries = n;
        i++;
      }
    }
    else if (a === '--sandbox') { const v = value(a, i); if (v !== null) {
      if (!['danger-full-access', 'workspace-write', 'read-only'].includes(v)) o.error = 'invalid --sandbox';
      else o.sandbox = v;
      i++;
    } }
    else if (a === '--idle-timeout' || a === '--turn-timeout') {
      const v = value(a, i);
      if (v !== null) {
        try { o[a === '--idle-timeout' ? 'idleTimeoutMs' : 'timeoutMs'] = parseDuration(v); }
        catch (e) { o.error = `${a}: ${e.message}`; }
        i++;
      }
    }
    else if (a === '--backend') { const v = value(a, i); if (v !== null) { o.backendId = v; i++; } }
    else if (a === '--cwd') { const v = value(a, i); if (v !== null) { o.cwd = v; i++; } }
    else if (a === '--max') {
      const v = value(a, i);
      if (v !== null) {
        i++;
        const n = /^\d+$/.test(String(v)) ? Number(v) : NaN;
        // Zero and negatives are refused too: elsewhere in the framework they mean "no limit"
        // (v1.9.0), and here the user is explicitly asking FOR a limit. Silently granting the
        // opposite of what was asked is the defect being fixed.
        if (!Number.isSafeInteger(n) || n <= 0) o.error = `--max needs a positive safe whole number, got ${JSON.stringify(v)}`;
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
    process.stderr.write('usage: supervisor.mjs [--state <file>] [--cwd <dir>] [--max <n>] [--model <m>] [--effort <level>] [--sandbox <mode>] [--idle-timeout <duration>] [--turn-timeout <duration>] [--network-retries <n>] [--backend <id>] [--dry-run] [--no-preflight]\n');
    process.exit(2);
  }
  delete args.error;
  runLoop(args)
    .then(r => { process.stdout.write(JSON.stringify(r) + '\n'); process.exit(0); })
    .catch(e => { process.stderr.write(`supervisor: ${e.message}\n`); process.exit(1); });
}
