// core/turn-progress.mjs — memory for the progress detector on a driver that has none (v1.8.0).
//
// core/progress.mjs answers "did anything change between these two snapshots". The supervisor can
// use it directly: it is a long-running process, it takes a snapshot before the turn and another
// after it, and it keeps the running count in a variable.
//
// The Claude Code Stop hook cannot. It is a short-lived process that runs only at the END of a
// turn: by the time it exists, the turn it must judge is over. Both the earlier snapshot and the
// count of consecutive empty turns have to survive between invocations.
//
// This module is that memory and nothing else. The detector itself is NOT reimplemented here — two
// detectors of the same thing would be exactly the class of defect v1.7.1 spent a version closing.
//
// WHERE THE MEMORY LIVES, and why not in STATE. Putting it in docs/STATE.md was the obvious
// candidate and is wrong by construction: the hash of STATE is one of the three progress signals,
// so the detector's memory would live inside the artefact it measures. Every write would register
// as progress and the detector could never fire — it would be a watchdog that barks at its own
// tail. The file therefore sits beside the loop's other process state (docs/.loop.lock,
// docs/.loop-children), which describes a process rather than the project and is ignored by git.
//
// THE ONE-TURN BASELINE, stated plainly rather than hidden. The supervisor snapshots before the
// first turn because it starts that turn. The hook has no such moment: on its first invocation
// there is nothing to compare against, so that invocation establishes the baseline and counts as
// zero. On the Claude driver the count therefore begins one turn later than on the supervisor.
// The alternative would be to guess whether the first turn did anything, and a detector that
// guesses is worse than one that starts a turn late.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assessProgress } from './progress.mjs';

export const MEMORY_FILENAME = '.loop-progress';

export function memoryPath(docsDir) {
  return join(docsDir, MEMORY_FILENAME);
}

// null when there is no usable memory — a fresh loop, a wiped file, a corrupted one. Every such
// case means "no baseline yet", never "no progress".
export function readMemory(docsDir) {
  try {
    const m = JSON.parse(readFileSync(memoryPath(docsDir), 'utf8'));
    if (!m || typeof m !== 'object' || !m.snapshot) return null;
    return { snapshot: m.snapshot, stagnant: Number.isFinite(m.stagnant) ? m.stagnant : 0 };
  } catch { return null; }
}

// Failure to remember must never break a turn: the loop keeps running, it just loses one
// observation. An observer that can stop the thing it observes is not an observer.
export function writeMemory(docsDir, snapshot, stagnant) {
  try {
    writeFileSync(
      memoryPath(docsDir),
      `${JSON.stringify({ snapshot, stagnant, at: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
    return true;
  } catch { return false; }
}

// How many turns in a row have now produced nothing, seen from the end of a turn.
export function stagnantAfterTurn(memory, current) {
  if (!memory) return 0;
  return assessProgress(memory.snapshot, current).progressed ? 0 : (memory.stagnant || 0) + 1;
}

export default { MEMORY_FILENAME, memoryPath, readMemory, writeMemory, stagnantAfterTurn };
