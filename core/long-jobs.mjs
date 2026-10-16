// core/long-jobs.mjs — long-running external work, as something the loop understands (v1.13.0).
//
// THE DEFECT THIS EXISTS FOR. In a real session the agent scheduled long jobs with the shell:
// `sleep` appeared 447 times, thirty-nine `until … do sleep N; done` loops, pauses of up to 900
// seconds inside a single tool call — while the framework's own background mechanism was used once.
// The human asked four different ways whether the loop was working or standing still, across 124
// interventions in one session.
//
// The root is not the sleeping. A turn is where the loop acts, and it is the loop's only spendable
// resource; a turn spent asleep produces nothing — no git change, no state change — which is also
// exactly what a hung turn looks like from the outside. The framework had no idea a long job
// existed, so it could not tell waiting from hanging, and neither could the human.
//
// WHY A COMPLETION MARKER IS NOT ENOUGH, which is the crux. `until grep -q MARKER log` waits for
// ever when the job dies before writing its marker, because absence of the marker means two
// different things. Liveness of the process separates them:
//
//   process alive · no marker   → running
//   process dead  · marker      → finished
//   process dead  · no marker   → DIED — the case that hangs for ever today
//
// Plus one more the pair cannot express: alive but past the time it was expected to take. That is
// not a failure and must not stop anything — it is a fact the agent should be told, because a job
// running three times longer than expected usually means something the agent can act on.
//
// v1.14.0 — WHERE THAT TABLE WAS STILL TOO CONFIDENT, found by auditing the mechanism against the
// physics of its own signals:
//
//   1. A PROCESS NUMBER IS NOT A NAME. The operating system reissues it once the process is gone,
//      so a job that died hours ago can appear "alive" wearing somebody else's process, and used to
//      be reported as running for ever. The marker is evidence the job wrote about itself, so it
//      now outranks liveness: marker seen → finished, whatever the process table says. The price is
//      named rather than hidden — the log must be TRUNCATED when the job starts (`> log`, which is
//      what an ordinary redirect does), otherwise a marker left by a previous run is believed.
//   2. "GONE AND NO MARKER DECLARED" USED TO MEAN FINISHED. It also covers a job that never started
//      at all, and those two must not share an answer. The log file separates them: a job that ran
//      wrote something, a job that never started left no file behind.
//   3. A DEADLINE THAT CANNOT BE READ SILENTLY NEVER FIRES — the exact defect class this project
//      keeps finding. Malformed records now produce named warnings instead of a quiet shrug.
//   4. TERMINAL RECORDS ARE NOT THE REGISTRY'S BUSINESS TO DELETE, because removing one decides on
//      the agent's behalf that the result was collected. So the mechanism says what to do instead
//      of doing it (see `terminalAdvice`).
//
// WHAT THIS DELIBERATELY IS NOT. Not a scheduler, not a job queue, not a supervisor of children.
// Four states, one record in docs/STATE.md, and a check that costs milliseconds. The temptation to
// build a service here is real and would be a mistake: the loop needs to stop wasting turns, not to
// gain a subsystem.
//
// No I/O in the classifier: liveness, marker and log lookups are injected, so the behaviour is
// testable without starting processes, and a driver decides how to gather them.

import { readFileSync, existsSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { win32, posix } from 'node:path';
import { isPidAlive } from './loop-lock.mjs';

export const RUNNING = 'running';
export const FINISHED = 'finished';
export const DIED = 'died';
export const OVERDUE = 'overdue';

const TERMINAL = new Set([FINISHED, DIED]);
const usableText = value => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
const declared = (job, field) => job[field] !== undefined;

// Only path fields pass through the platform path API. Never unescape YAML a second time,
// collapse a UNC prefix by hand, or reinterpret a POSIX backslash in a filename.
export function resolveJobPath(value, { cwd = process.cwd(), platform = process.platform } = {}) {
  if (!usableText(value)) throw new Error('job path must be a nonempty string without NUL');
  return (platform === 'win32' ? win32 : posix).resolve(cwd, value);
}

function parseTime(v) {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? t : null;
}

// Everything about a record that is self-contradictory or unusable. None of it changes the verdict:
// a warning that could stop a job would be a gate, and this is an observer.
function inspectRecord(j) {
  const warnings = [];
  const pid = Number(j.pid ?? NaN);
  if (!Number.isInteger(pid) || pid <= 0) {
    warnings.push('no usable pid on the record, so liveness cannot be checked at all');
  }
  if (j.expect_by !== undefined && j.expect_by !== null && parseTime(j.expect_by) === null) {
    warnings.push(`expect_by ${JSON.stringify(String(j.expect_by))} cannot be read as a time, so the deadline can never fire`);
  }
  const deadline = parseTime(j.expect_by);
  const started = parseTime(j.started_at);
  if (deadline !== null && started !== null && deadline < started) {
    warnings.push('expect_by is before started_at — the job was overdue the moment it began');
  }
  if (j.done_marker && !j.log) {
    warnings.push('a done_marker is declared with no log to look for it in, so it can never be seen and the job will end up reported as died');
  }
  for (const field of ['log', 'done_marker', 'done_file']) {
    if (declared(j, field) && !usableText(j[field])) warnings.push(`${field} must be a nonempty string without NUL`);
  }
  if (declared(j, 'done_marker') && declared(j, 'done_file')) {
    warnings.push('declare exactly one of done_marker (literal log text) or done_file (result path), not both');
  }
  if (usableText(j.done_marker) && /[\\/]/.test(j.done_marker)) {
    warnings.push('done_marker looks like a path; it is literal log text — use done_file for a result file');
  }
  return warnings;
}

// Classify ONE job. Never throws: a malformed record must not take a driver down with it.
export function classifyJob(job, { now, alive = false, markerSeen = false, doneFileSeen = false,
  logExists = null, probeWarnings = [] } = {}) {
  const j = (job && typeof job === 'object' && !Array.isArray(job)) ? job : {};
  const id = j.id ? String(j.id) : '(unnamed)';
  const marker = usableText(j.done_marker) ? j.done_marker : '';
  const hasMarker = declared(j, 'done_marker'), hasFile = declared(j, 'done_file');
  const nowMs = parseTime(now) ?? Date.now();
  const warnings = [...inspectRecord(j), ...probeWarnings];
  const verdict = (state, why) => ({ id, state, why, warnings });

  // The job's own word about itself comes first. A process number can be reused by the system and
  // a winding-down process can outlive its own last line; a written marker can do neither.
  if (!hasFile && marker && markerSeen) {
    return verdict(FINISHED, 'the marker it declared was written — it finished');
  }
  if (!hasMarker && usableText(j.done_file) && doneFileSeen) {
    return verdict(FINISHED, 'the declared result file is readable — it finished; read the result to determine success');
  }

  if (alive) {
    const deadline = parseTime(j.expect_by);
    if (deadline !== null && nowMs > deadline) {
      return verdict(OVERDUE, `still running, but was expected to finish by ${j.expect_by}`);
    }
    return verdict(RUNNING, 'the process is alive');
  }

  // The process is gone. What that means depends on what it left behind.
  if (hasFile) {
    return verdict(DIED, 'the process is gone and no usable completion file was observed — read the warnings and log');
  }
  if (hasMarker) {
    return verdict(DIED,
      `the process is gone and the marker ${JSON.stringify(marker)} was never written — it did not finish`);
  }
  if (logExists === false) {
    return verdict(DIED,
      'the process is gone and its log was never created — the job never started, so nothing ran to succeed or fail');
  }
  return verdict(FINISHED,
    'the process is gone, and no marker was declared — success was not verified, read the log');
}

// Classify every job in the state record. The probes are injected so that this costs a few system
// calls and cannot block: the whole point is that checking is not waiting.
export function inspectJobs(jobs, {
  now, pidAlive = () => false, markerSeen = () => false, logExists = () => null,
  doneFileSeen = () => false, probeWarnings = () => [],
} = {}) {
  if (!Array.isArray(jobs)) return [];
  return jobs.map((j) => {
    const pid = Number((j && j.pid) ?? NaN);
    const alive = Number.isInteger(pid) && pid > 0 ? Boolean(pidAlive(pid)) : false;
    // The marker is now read even for a live process: it is the only signal that survives a reused
    // process number, and reading one log costs a file read, not a wait.
    const seen = Boolean(markerSeen(j));
    const exists = alive ? null : logExists(j);   // a live job's log tells us nothing new
    return classifyJob(j, { now, alive, markerSeen: seen, doneFileSeen: Boolean(doneFileSeen(j)),
      logExists: exists, probeWarnings: probeWarnings(j) });
  });
}

// One line for the continuation text, answering the question a human asked four different ways in a
// single session: are we waiting for something, or just standing still? Returns null when there is
// nothing to say — silence is correct when no job was ever started.
export function summariseJobs(inspected) {
  if (!Array.isArray(inspected) || inspected.length === 0) return null;
  const by = { [RUNNING]: [], [OVERDUE]: [], [DIED]: [], [FINISHED]: [] };
  for (const j of inspected) if (by[j.state]) by[j.state].push(j.id);

  const part = (label, ids) => `${label}: ${ids.length}${ids.length ? ` (${ids.join(', ')})` : ''}`;
  return [
    part('running', by[RUNNING]),
    part('overdue', by[OVERDUE]),
    part('died', by[DIED]),
    part('finished', by[FINISHED]),
  ].join(' | ');
}

// What to do about jobs that are over. The registry describes what is happening NOW, so a record
// that has stopped happening is stale by definition — but only the agent knows whether it has
// collected the result, and deleting the record here would answer that question on its behalf. So
// the mechanism asks, every turn, until the agent clears it. Returns null when there is nothing
// over, because a line printed for no reason is a line that stops being read.
export function terminalAdvice(inspected) {
  if (!Array.isArray(inspected)) return null;
  const over = inspected.filter(j => j && TERMINAL.has(j.state)).map(j => j.id);
  if (over.length === 0) return null;
  return `jobs over: ${over.join(', ')} — read the log, take the result, and remove them from ` +
    'running_jobs in the state role; the registry is what is running now, not a history.';
}

// Everything the classifier needs to know about one record, gathered from disk. Reading a log is
// bounded by the file size, and a missing or unreadable file simply means "not seen" — never an
// exception, because an observer that can stop the thing it observes is not an observer.
function logProbe(j, cwd) {
  if (!j || !usableText(j.log)) return { exists: null, markerSeen: false };
  const path = resolveJobPath(j.log, { cwd });
  if (!existsSync(path)) return { exists: false, markerSeen: false };
  if (!usableText(j.done_marker)) return { exists: true, markerSeen: false };
  try {
    return { exists: true, markerSeen: readFileSync(path, 'utf8').includes(String(j.done_marker)) };
  } catch { return { exists: true, markerSeen: false }; }
}

function fileProbe(j, cwd) {
  if (!j || !usableText(j.done_file)) return { doneFileSeen: false, warnings: [] };
  let fd;
  try {
    // A mistaken FIFO must not turn this observer into a blocking reader on POSIX.
    fd = openSync(resolveJobPath(j.done_file, { cwd }), constants.O_RDONLY | (constants.O_NONBLOCK || 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { doneFileSeen: false, warnings: ['done_file is not a regular readable file'] };
    const started = parseTime(j.started_at);
    if (started !== null && stat.mtimeMs < started) {
      return { doneFileSeen: false, warnings: ['done_file predates started_at; remove it before launch or use a new result path'] };
    }
    return { doneFileSeen: true, warnings: [] };
  } catch (error) {
    return { doneFileSeen: false, warnings: error.code === 'ENOENT' ? [] : [`done_file cannot be read (${error.code || 'I/O error'})`] };
  } finally { if (fd !== undefined) closeSync(fd); }
}

// The gathering half, kept beside the classifier so the two drivers cannot drift apart on what
// "alive" or "finished" means. Liveness reuses the check the loop lock has relied on since v1.5.0
// rather than growing a second one.
export function inspectStateJobs(state, { cwd = process.cwd(), now = new Date().toISOString() } = {}) {
  const jobs = (state && Array.isArray(state.running_jobs)) ? state.running_jobs : [];
  if (!jobs.length) return [];
  // Each log is read at most once per pass, even though two questions are asked of it.
  const cache = new Map();
  const probe = (j) => {
    if (!cache.has(j)) cache.set(j, { ...logProbe(j, cwd), ...fileProbe(j, cwd) });
    return cache.get(j);
  };
  return inspectJobs(jobs, {
    now,
    pidAlive: isPidAlive,
    markerSeen: (j) => probe(j).markerSeen,
    logExists: (j) => probe(j).exists,
    doneFileSeen: (j) => probe(j).doneFileSeen,
    probeWarnings: (j) => probe(j).warnings,
  });
}
