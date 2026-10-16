#!/usr/bin/env node
// backup.mjs — a ring buffer of file backups (the N most recent versions).
//
// THE SINGLE SOURCE OF TRUTH for backup rotation: used by both update-state.mjs and
// state-backup.mjs (the logic used to be duplicated in each of them).

import { existsSync, copyFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { findProjectRoot, loadProjectConfig } from '../core/project-config.mjs';

export const MAX_BACKUPS = 5;

export function stateStorage(path) {
  path = resolve(path);
  const project = loadProjectConfig({ projectDir: findProjectRoot(dirname(path)) });
  if (!project.installed) return { backupBase: path, temporaryBase: path };
  const id = createHash('sha256').update(relative(project.projectDir, path)).digest('hex');
  mkdirSync(project.runtimeDir, { recursive: true });
  return { backupBase: project.runtimePath(`state-${id}`), temporaryBase: project.runtimePath(`state-update-${id}`) };
}

// Rotation: .bak.(N-1)→.bak.N, ..., .bak.1→.bak.2, then the current file → .bak.1.
// Best effort: a failure in one link is not fatal (a backup is a safety net, not a critical path).
export function rotateBackups(path, max = MAX_BACKUPS) {
  if (!existsSync(path)) return;
  const { backupBase } = stateStorage(path);
  for (let i = max - 1; i >= 1; i--) {
    const src = `${backupBase}.bak.${i}`;
    const dst = `${backupBase}.bak.${i + 1}`;
    if (existsSync(src)) {
      try {
        if (existsSync(dst)) unlinkSync(dst);
        renameSync(src, dst);
      } catch { /* non-fatal */ }
    }
  }
  if (existsSync(path)) {
    try { copyFileSync(path, `${backupBase}.bak.1`); } catch { /* non-fatal */ }
  }
}
