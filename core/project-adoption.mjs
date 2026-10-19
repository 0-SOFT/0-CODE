// A reviewed hash manifest authorizes replacement, never execution of the old tree.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { fileSnapshot, hashBytes, assertCycleRelocationStopped, enterCycleRelocationGuard } from './installation-transaction.mjs';
import { projectRelativePath, resolveProjectPath, isDocumentZone, loadProjectConfig } from './project-config.mjs';
import { assertStateStopped } from './document-relocation.mjs';
import { isDeepStrictEqual } from 'node:util';

const key = path => path.toLowerCase();
export const isRetainedProjectPath = path => path.toLowerCase() === '.0-code/readme.md' || /^\.0-code\/(?:bin|claude)\/.+/i.test(path);
const isRuntime = path => /^\.0-code\/run(?:\/|$)/i.test(path);
export function installationTreeFiles(root, directory = '.0-code') {
  const absolute = resolveProjectPath(root, directory, { allowFramework: true });
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const path = directory + '/' + entry.name;
    resolveProjectPath(root, path, { allowFramework: true });
    if (entry.isDirectory()) return installationTreeFiles(root, path);
    if (!entry.isFile()) throw new Error('Adoption requires ordinary files: ' + path);
    return [path];
  }).sort();
}
export function validateRetainedFiles(files, owned = []) {
  if (!Array.isArray(files)) throw new Error('Invalid retained project files');
  const seen = new Set(owned.map(entry => key(entry.path)));
  for (const path of files) {
    if (projectRelativePath(path, { allowFramework: true }) !== path || !isRetainedProjectPath(path) || seen.has(key(path))) throw new Error('Invalid retained project path: ' + path);
    seen.add(key(path));
  }
}
export function prepareProjectAdoption(root, manifest, config) {
  const original=loadProjectConfig({projectDir:root});
  if(!original.installed||!isDeepStrictEqual(original.config.documents,config.documents))throw new Error('Adoption preserves existing document roles; relocate documents in a separate operation');
  if (!manifest || manifest.schema_version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length
    || Object.keys(manifest).some(key => !['schema_version', 'files'].includes(key))) throw new Error('Invalid adoption manifest');
  const seen = new Set(), replaced = [], retainedFiles = [];
  const entries = manifest.files.map(entry => {
    if (!entry || Object.keys(entry).some(key => !['path', 'sha256', 'action'].includes(key))
      || !['replace', 'preserve'].includes(entry.action) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid adoption file entry');
    const path = projectRelativePath(entry.path, { allowFramework: true });
    if (path !== entry.path || !path.startsWith('.0-code/') || isDocumentZone(path) || isRuntime(path)
      || key(path) === '.0-code/installation.json' || seen.has(key(path))) throw new Error('Invalid adoption path: ' + path);
    seen.add(key(path));
    const snapshot = fileSnapshot(root, path);
    if (snapshot.hash !== entry.sha256) throw new Error('Adoption hash mismatch: ' + path);
    if (entry.action === 'preserve') {
      if (!isRetainedProjectPath(path)) throw new Error('Cannot retain framework code: ' + path);
      retainedFiles.push(path);
    } else {
      if (isRetainedProjectPath(path)) throw new Error('Project extensions must be preserved: ' + path);
      replaced.push({ path, hash: snapshot.hash, originalHash: null, originalMode: snapshot.mode });
    }
    return { ...entry, ...snapshot };
  });
  const checkTree = () => {
    for (const path of installationTreeFiles(root)) {
      if (!isDocumentZone(path) && !isRuntime(path) && !seen.has(key(path))) throw new Error('Unreviewed adoption file: ' + path);
    }
  };
  checkTree();
  const statePath = config.documents.state.path, stateHash = fileSnapshot(root, statePath).hash;
  const cycleLockPaths = [...new Set(['.0-code/run/.loop.lock', posix.join(dirname(statePath).replaceAll('\\', '/'), '.loop.lock')])];
  const preflight = () => {
    checkTree();
    if (fileSnapshot(root, statePath).hash !== stateHash) throw new Error('Cycle state changed after adoption planning');
    assertStateStopped(fileSnapshot(root, statePath).bytes);
    assertCycleRelocationStopped(root, cycleLockPaths);
    for (const entry of entries) if (fileSnapshot(root, entry.path).hash !== entry.sha256) throw new Error('Adoption file changed: ' + entry.path);
  };
  preflight();
  const receipt = { schema_version: 1, files: replaced, directories: [], retainedFiles,
    migration: { adopted: true, manifestHash: hashBytes(Buffer.from(JSON.stringify(manifest))) } };
  return { receipt, entries, preflight, cycleLockPaths, enterGuard: () => enterCycleRelocationGuard(root, cycleLockPaths) };
}
export function addAdoptionBackups(plan, adoption) {
  const backups = adoption.entries.filter(entry => entry.action === 'replace').map(entry => {
    const backup = '.0-code/run/adoption/' + hashBytes(Buffer.from(entry.path)) + '.bin';
    plan.change(backup, entry.bytes, { mode: 0o600, preserveMode: false });
    return { path: entry.path, backup, hash: entry.hash, mode: entry.mode };
  });
  plan.change('.0-code/run/adoption/index.json', Buffer.from(JSON.stringify(backups, null, 2) + '\n'), { mode: 0o600, preserveMode: false });
  return backups;
}
