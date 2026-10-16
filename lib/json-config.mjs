// Preserve malformed user data and publish complete configuration atomically.
import { readFileSync, writeFileSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { replaceFileSync } from './replace-file.mjs';

export const objectConfig = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

function ordinary(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Configuration must be an ordinary file: ' + file);
    return stat;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function readJsonConfig(file, fallback = {}) {
  if (!ordinary(file)) return fallback;
  let config;
  try { config = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error('Invalid JSON configuration, original preserved: ' + file); }
  if (!objectConfig(config)) throw new Error('Configuration must contain an object, original preserved: ' + file);
  return config;
}

export function writeJsonConfig(file, config) {
  if (!objectConfig(config)) throw new Error('Configuration must contain an object');
  ordinary(file);
  mkdirSync(dirname(file), { recursive: true });
  const staging = join(dirname(file), '.config-' + randomUUID() + '.tmp');
  try {
    writeFileSync(staging, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    replaceFileSync(staging, file, { validate: () => { ordinary(file); ordinary(staging); } });
  } finally {
    try { unlinkSync(staging); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
