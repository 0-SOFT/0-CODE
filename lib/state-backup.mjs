#!/usr/bin/env node
// state-backup.mjs — CLI wrapper around the ring buffer of STATE.md backups.
//
// The rotation logic lives in the shared ./backup.mjs module (a single source of truth — it used
// to be duplicated here and in update-state.mjs).
//
// Usage: node lib/state-backup.mjs <path-to-STATE.md>

import { existsSync } from 'node:fs';
import { argv, exit, stderr } from 'node:process';
import { rotateBackups } from './backup.mjs';

if (argv.length < 3) {
  stderr.write('Usage: state-backup.mjs <path-to-STATE.md>\n');
  exit(2);
}

const stateFile = argv[2];
if (!existsSync(stateFile)) exit(0); // nothing to back up — fine

rotateBackups(stateFile);
exit(0);
