#!/usr/bin/env node
// backup.mjs — a ring buffer of file backups (the N most recent versions).
//
// THE SINGLE SOURCE OF TRUTH for backup rotation: used by both update-state.mjs and
// state-backup.mjs (the logic used to be duplicated in each of them).

import { existsSync, copyFileSync, renameSync, unlinkSync } from 'node:fs';

export const MAX_BACKUPS = 5;

// Rotation: .bak.(N-1)→.bak.N, ..., .bak.1→.bak.2, then the current file → .bak.1.
// Best effort: a failure in one link is not fatal (a backup is a safety net, not a critical path).
export function rotateBackups(path, max = MAX_BACKUPS) {
  for (let i = max - 1; i >= 1; i--) {
    const src = `${path}.bak.${i}`;
    const dst = `${path}.bak.${i + 1}`;
    if (existsSync(src)) {
      try {
        if (existsSync(dst)) unlinkSync(dst);
        renameSync(src, dst);
      } catch { /* non-fatal */ }
    }
  }
  if (existsSync(path)) {
    try { copyFileSync(path, `${path}.bak.1`); } catch { /* non-fatal */ }
  }
}
