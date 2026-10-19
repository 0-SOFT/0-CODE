// Large before-images stay binary; the journal owns one exact directory and its recorded files.
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolveProjectPath } from './project-config.mjs';
import { retryWindowsFileOperation } from '../lib/replace-file.mjs';

const BEFORE_PREFIX = '.0-code/run/installation-before-';
const BEFORE_DIRECTORY = /^\.0-code\/run\/installation-before-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
export const MAX_INLINE_BEFORE_BYTES = 8 * 1024 * 1024;
const contained = (root, path) => resolveProjectPath(root, path, { allowFramework: true });
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const sameIdentity = (stat, expected) => expected && String(stat.dev) === expected.dev && String(stat.ino) === expected.ino;
const validIdentity = value => value && typeof value === 'object' && typeof value.dev === 'string' && typeof value.ino === 'string'
  && /^\d+$/.test(value.dev) && /^\d+$/.test(value.ino);

export function isBeforeStoragePath(path) { return path.replaceAll('\\', '/').toLowerCase().startsWith(BEFORE_PREFIX); }

function ownedDirectory(root, journal) {
  if (!BEFORE_DIRECTORY.test(journal.beforeDirectory) || !validIdentity(journal.beforeDirectoryIdentity))
    throw new Error('Invalid installation before-image directory');
  const directory = contained(root, journal.beforeDirectory), stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, journal.beforeDirectoryIdentity))
    throw new Error('Installation before-image directory changed');
  return directory;
}

function validateBeforeReference(journal, entry) {
  if (typeof entry.beforeFile !== 'string' || !HASH.test(entry.beforeHash)
    || entry.beforeFile !== `${journal.beforeDirectory}/${entry.beforeHash}.bin` || !validIdentity(entry.beforeFileIdentity)
    || Object.hasOwn(entry, 'before')) throw new Error('Invalid installation before-image reference');
}

function beforeFile(root, journal, entry) {
  validateBeforeReference(journal, entry);
  ownedDirectory(root, journal);
  const path = contained(root, entry.beforeFile), descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const validate = stat => {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !sameIdentity(stat, entry.beforeFileIdentity))
      throw new Error('Installation before-image file changed');
  };
  try {
    validate(fstatSync(descriptor, { bigint: true }));
    const bytes = readFileSync(descriptor);
    if (fingerprint(bytes) !== entry.beforeHash) throw new Error('Installation before-image fingerprint changed');
    validate(fstatSync(descriptor, { bigint: true }));validate(lstatSync(contained(root, entry.beforeFile), { bigint: true }));
    return bytes;
  } finally { closeSync(descriptor); }
}

function storageEntries(journal) {
  const entries = journal.changes.filter(entry => Object.hasOwn(entry, 'beforeFile'));
  const files = new Map();
  for (const entry of entries) {
    // Validate every reference before deduplication: one malformed duplicate must block all recovery writes.
    validateBeforeReference(journal, entry);
    const existing = files.get(entry.beforeFile);
    if (existing && (existing.beforeHash !== entry.beforeHash || existing.beforeFileIdentity?.dev !== entry.beforeFileIdentity?.dev
      || existing.beforeFileIdentity?.ino !== entry.beforeFileIdentity?.ino)) throw new Error('Inconsistent installation before-image reference');
    files.set(entry.beforeFile, entry);
  }
  return [...files.values()];
}

export function assertBeforeImages(root, journal) {
  const entries = storageEntries(journal);
  if (!Object.hasOwn(journal, 'beforeDirectory')) {
    if (entries.length || Object.hasOwn(journal, 'beforeDirectoryIdentity')) throw new Error('Missing installation before-image directory');
    return;
  }
  if (!entries.length) throw new Error('Empty installation before-image directory');
  const directory = ownedDirectory(root, journal);
  const expected = new Set(entries.map(entry => entry.beforeHash + '.bin'));
  const names = readdirSync(directory);
  if (names.length !== expected.size || names.some(name => !expected.has(name))) throw new Error('Unknown installation before-image file');
  for (const entry of entries) beforeFile(root, journal, entry);
}

export function readBeforeImage(root, journal, entry) {
  return Object.hasOwn(entry, 'beforeFile') ? beforeFile(root, journal, entry)
    : entry.before === null ? null : Buffer.from(entry.before, 'base64');
}

export function clearBeforeImages(root, journal) {
  if (!Object.hasOwn(journal, 'beforeDirectory')) return;
  // Inspect the whole set before deleting anything. A new unknown file still makes rmdir fail closed.
  assertBeforeImages(root, journal);
  for (const entry of storageEntries(journal)) {
    beforeFile(root, journal, entry);
    unlinkSync(contained(root, entry.beforeFile));
  }
  retryWindowsFileOperation(() => rmdirSync(ownedDirectory(root, journal)), { validate: () => ownedDirectory(root, journal) });
}

function assertUnpublishedFile(root, journal, name, file) {
  ownedDirectory(root, journal);
  const path = contained(root, journal.beforeDirectory + '/' + name), stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !sameIdentity(stat, file.owner))
    throw new Error('Unpublished installation before-image changed');
  const bytes = readFileSync(path);
  if (bytes.length > file.bytes.length || !bytes.equals(file.bytes.subarray(0, bytes.length)))
    throw new Error('Unpublished installation before-image changed');
  return path;
}

function clearUnpublished(root, journal, created) {
  const directory = ownedDirectory(root, journal), names = readdirSync(directory);
  if (names.length !== created.size || names.some(name => !created.has(name))) throw new Error('Unknown unpublished installation before-image file');
  for (const [name, file] of created) assertUnpublishedFile(root, journal, name, file);
  for (const [name, file] of created) unlinkSync(assertUnpublishedFile(root, journal, name, file));
  retryWindowsFileOperation(() => rmdirSync(ownedDirectory(root, journal)), { validate: () => ownedDirectory(root, journal) });
}

export function prepareBeforeImages(root, changes) {
  const total = changes.reduce((sum, entry) => sum + (entry.before?.length ?? 0), 0);
  if (total <= MAX_INLINE_BEFORE_BYTES) return { fields: changes.map(entry => ({ before: entry.before === null ? null : entry.before.toString('base64') })) };
  const beforeDirectory = BEFORE_PREFIX + randomUUID(), directory = contained(root, beforeDirectory);
  mkdirSync(directory, { mode: 0o700 });
  const journal = { beforeDirectory, beforeDirectoryIdentity: identity(lstatSync(directory, { bigint: true })) }, created = new Map();
  try {
    const fields = changes.map(entry => {
      if (entry.before === null) return { before: null };
      const hash = fingerprint(entry.before), name = hash + '.bin';
      let file = created.get(name);
      if (!file) {
        ownedDirectory(root, journal);
        const descriptor = openSync(contained(root, beforeDirectory + '/' + name), 'wx', 0o600);
        try {
          file = { owner: identity(fstatSync(descriptor, { bigint: true })), bytes: entry.before };created.set(name, file);
          writeFileSync(descriptor, entry.before);fsyncSync(descriptor);
        } finally { closeSync(descriptor); }
      }
      return { beforeFile: `${beforeDirectory}/${name}`, beforeFileIdentity: file.owner };
    });
    return { ...journal, fields };
  } catch (error) {
    try { clearUnpublished(root, journal, created); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Installation before-image preparation failed; owned storage could not be cleared'); }
    throw error;
  }
}
