// Relocation is explicit project authorization, never ownership of a whole docs tree.
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DOCUMENT_DEFAULTS, LEGACY_DOCUMENT_DEFAULTS, normalizeProjectConfig, projectRelativePath, resolveProjectPath } from './project-config.mjs';
import { fileSnapshot, hashBytes, assertCycleRelocationStopped, enterCycleRelocationGuard } from './installation-transaction.mjs';
import { parseYaml } from '../lib/yaml-mini.mjs';

const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const key = path => process.platform === 'win32' ? path.toLowerCase() : path;
const contains = (role, path) => role.name ? role.path === '.' ? !path.includes('/') : path.startsWith(role.path + '/') : path === role.path;
function stateHeader(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('Cycle state must be lossless UTF-8');
  const match = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('Configured state is not a machine cycle state');
  const state = parseYaml(match[1]);
  if (state.schema_version !== 1 || !state.project_name || typeof state.current_version !== 'string'
    || !Number.isInteger(state.current_stage)) throw new Error('Configured state is not a machine cycle state');
  return { text, match, state };
}
export function assertStateStopped(bytes) {
  if (bytes === null) throw new Error('Configured cycle state is missing');
  const { state } = stateHeader(bytes);
  const initial = state.current_stage === 0 && Number(state.iteration) === 0 && !state.current_prompt_file
    && !state.next_step_prompt && !state.released_version;
  if (!initial && state.released_version !== state.current_version) throw new Error('Stop and finish the active cycle before relocating documents');
  if (state.running_jobs !== undefined && (!Array.isArray(state.running_jobs) || state.running_jobs.length))
    throw new Error('Collect running jobs before relocating documents');
}
function runtimePaths(documents) {
  return [...new Set(['.0-code/run', dirname(documents.state.path).replaceAll('\\', '/')])];
}
const runtimeFile = (directory, name) => directory === '.' ? name : directory + '/' + name;
function treeFiles(root, directory) {
  const path = resolveProjectPath(root, directory, { allowFramework: true });
  if (!existsSync(path)) return [];
  if (!lstatSync(path).isDirectory()) throw new Error('Document role must be a directory: ' + directory);
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const child = directory + '/' + entry.name;
    const stat = lstatSync(resolveProjectPath(root, child, { allowFramework: true }));
    return stat.isDirectory() ? treeFiles(root, child) : [child];
  });
}
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function templateFiles(root, document) {
  const directory = resolveProjectPath(root, document.path, { allowRoot: true, allowFramework: true });
  if (!existsSync(directory)) return [];
  const name = new RegExp('^' + document.name.split(/(<(?:version|name|date|id)>)/)
    .map(part => /^<.*>$/.test(part) ? '.+' : escaped(part)).join('') + '$');
  return readdirSync(directory, { withFileTypes: true }).filter(entry => !entry.isDirectory() && name.test(entry.name))
    .map(entry => runtimeFile(document.path, entry.name));
}
function referenceRewriter(mappings) {
  const targets = new Map([...mappings].map(([from, to]) => [key(from), to]));
  const separator = String.raw`(?:/|\\{1,2})`;
  const alternatives = [...mappings.keys()].sort((a, b) => b.length - a.length)
    .map(path => path.split('/').map(escaped).join(separator)).join('|');
  if (!alternatives) return value => value;
  // A retained product descendant must never follow a relocated directory by accident.
  const pattern = new RegExp('(^|[^A-Za-z0-9_./\\\\-])(' + alternatives + ')(?=$|[^A-Za-z0-9_./\\\\-]|\\.(?![A-Za-z0-9_])|' + separator + '[<{])', process.platform === 'win32' ? 'gi' : 'g');
  return value => typeof value === 'string' ? value.replace(pattern, (_, prefix, path) => prefix + targets.get(key(path.replace(/\\{1,2}/g, '/')))) : value;
}
function rewriteState(bytes, rewrite) {
  const { text, match, state } = stateHeader(bytes);
  const expected = { ...state,
    ...(typeof state.current_prompt_file === 'string' ? { current_prompt_file: rewrite(state.current_prompt_file) } : {}),
    ...(typeof state.next_step_prompt === 'string' ? { next_step_prompt: rewrite(state.next_step_prompt) } : {}),
    ...(state.next_step_prompt_meta ? { next_step_prompt_meta: { ...state.next_step_prompt_meta,
      ...(typeof state.next_step_prompt_meta.prompt_file === 'string' ? { prompt_file: rewrite(state.next_step_prompt_meta.prompt_file) } : {}) } } : {}),
  };
  const header = match[0].replace(/^(?:current_prompt_file|next_step_prompt):[^\r\n]*/gm, rewrite)
    .replace(/^next_step_prompt_meta:[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/m,
      block => block.replace(/^[ \t]+prompt_file:[^\r\n]*/gm, rewrite));
  const after = Buffer.from(header + text.slice(match[0].length));
  if (!isDeepStrictEqual(stateHeader(after).state, expected))
    throw new Error('Cycle pointer syntax cannot be safely relocated; original preserved');
  return after;
}
function rewriteTemplate(bytes, rewrite) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('Selected template must be lossless UTF-8');
  return Buffer.from(rewrite(text));
}
function validateManifest(manifest) {
  if (!manifest || manifest.schema_version !== 1 || !Array.isArray(manifest.files)
    || Object.keys(manifest).some(name => !['schema_version', 'files'].includes(name)))
    throw new Error('Invalid document manifest; expected schema_version: 1 and files');
  const files = manifest.files.map(path => projectRelativePath(path, { allowDocuments: true }));
  if (new Set(files.map(key)).size !== files.length) throw new Error('Duplicate document manifest path');
  return files;
}
function manifestRole(documents, path) {
  const candidates = Object.entries(documents).filter(([, document]) => contains(document, path))
    .sort((a, b) => b[1].path.length - a[1].path.length);
  if (!candidates.length) throw new Error('Manifest file is outside a configured cycle role: ' + path);
  if (candidates.length > 1 && candidates[0][1].path.length === candidates[1][1].path.length)
    throw new Error('Document belongs to ambiguous shared roles; separate their paths before relocation: ' + path);
  return candidates[0][0];
}
export function planDocumentRelocation(root, beforeConfig, proposedConfig, manifest) {
  const selected = validateManifest(manifest), before = beforeConfig.documents;
  const cycleLockPaths = runtimePaths(before).map(directory => runtimeFile(directory, '.loop.lock')), statePath = before.state.path;
  const stateSnapshot = fileSnapshot(root, statePath);
  assertStateStopped(stateSnapshot.bytes); assertCycleRelocationStopped(root, cycleLockPaths);
  const unchanged = path => {
    if (fileSnapshot(root, path).hash !== stateSnapshot.hash) throw new Error('Cycle state changed after relocation planning');
  };
  const preflight = () => { unchanged(statePath); assertStateStopped(fileSnapshot(root, statePath).bytes); assertCycleRelocationStopped(root, cycleLockPaths); };
  // A previously applied manifest is accepted only through the persisted operation record.
  const previousBytes = fileSnapshot(root, '.0-code/run/document-migration/index.json').bytes;
  const previous = previousBytes === null ? null : JSON.parse(previousBytes.toString('utf8'));
  const repeated = previous && isDeepStrictEqual(previous.files, selected)
    && previous.roles.every(entry => before[entry.role]?.path === entry.to && proposedConfig.documents[entry.role]?.path === entry.to);
  if (repeated || !selected.length) {
    if (repeated && (previous.moves.some(move => fileSnapshot(root, move.from).bytes !== null || fileSnapshot(root, move.to).hash !== move.afterHash)
      || (previous.updates || []).some(entry => fileSnapshot(root, entry.to).hash !== entry.afterHash)))
      throw new Error('Document manifest does not describe a pending or completed relocation');
    return { config: proposedConfig, moves: [], updates: [], preserved: [], roles: [], preflight, cycleLockPaths };
  }
  const selectedRoles = new Map(selected.map(from => [from, manifestRole(before, from)]));
  const eligible = Object.entries(before).filter(([role, document]) => document.path === LEGACY_DOCUMENT_DEFAULTS[role].path
    && proposedConfig.documents[role].path === document.path && [...selectedRoles.values()].includes(role));
  const roles = eligible.map(([role, document]) => ({ role, from: document.path, to: DOCUMENT_DEFAULTS[role].path }));
  const documents = Object.fromEntries(Object.entries(proposedConfig.documents).map(([role, document]) =>
    [role, { ...document, ...(roles.some(entry => entry.role === role) ? { path: DOCUMENT_DEFAULTS[role].path } : {}) }]));
  const baseConfig = normalizeProjectConfig({ ...proposedConfig, documents });
  const specs = selected.map(from => {
    const role = selectedRoles.get(from), document = before[role], snapshot = fileSnapshot(root, from);
    const relocated = eligible.some(([candidate]) => candidate === role);
    if (!relocated && !['state', 'templates'].includes(role)) throw new Error('Manifest file is outside a legacy standard role: ' + from);
    if (snapshot.bytes === null) throw new Error('Selected document is missing: ' + from);
    return { from, to: relocated ? DOCUMENT_DEFAULTS[role].path + from.slice(document.path.length) : from, role, ...snapshot };
  });
  for (const role of ['state', 'roadmap']) {
    if (roles.some(entry => entry.role === role) && fileSnapshot(root, before[role].path).bytes !== null
      && !selected.includes(before[role].path)) throw new Error('Manifest must include the existing ' + role + ' document');
  }
  const mappings = new Map([...roles.map(entry => [entry.from, entry.to]), ...specs.filter(entry => entry.from !== entry.to).map(entry => [entry.from, entry.to])]);
  const rewrite = referenceRewriter(mappings);
  const changes = specs.map(entry => {
    const after = entry.role === 'state' ? rewriteState(entry.bytes, rewrite)
      : entry.role === 'templates' ? rewriteTemplate(entry.bytes, rewrite) : entry.bytes;
    const afterHash = hashBytes(after);
    return { from: entry.from, to: entry.to, beforeHash: entry.hash, afterHash, mode: entry.mode, bytes: entry.bytes, after,
      ...(entry.hash !== afterHash ? { backup: '.0-code/run/document-migration/' + entry.hash + '.bin' } : {}) };
  });
  if (!selected.includes(statePath) && !rewriteState(stateSnapshot.bytes, rewrite).equals(stateSnapshot.bytes))
    throw new Error('Manifest must include the configured state for pointer updates: ' + statePath);
  if (!roles.some(entry => entry.role === 'templates')) {
    for (const path of templateFiles(root, before.templates)) {
      if (selected.includes(path)) continue;
      const snapshot = fileSnapshot(root, path);
      if (!rewriteTemplate(snapshot.bytes, rewrite).equals(snapshot.bytes))
        throw new Error('Manifest must include the configured template for pointer updates: ' + path);
    }
  }
  const moves = changes.filter(entry => entry.from !== entry.to);
  const updates = changes.filter(entry => entry.from === entry.to && entry.beforeHash !== entry.afterHash);
  const candidates = eligible.flatMap(([, document]) => document.name ? treeFiles(root, document.path) :
    fileSnapshot(root, document.path).bytes === null ? [] : [document.path]);
  const preserved = [...new Set(candidates)].filter(path => !selected.includes(path)).sort();
  return { config: baseConfig, moves, updates, preserved, roles, preflight, cycleLockPaths, files: selected };
}
export function addDocumentRelocation(plan, relocation) {
  const archived = new Set();
  const archive = entry => {
    if (!entry.backup || archived.has(entry.backup)) return;
    plan.change(entry.backup, entry.bytes, { mode: 0o600, preserveMode: false });
    archived.add(entry.backup);
  };
  for (const move of relocation.moves) {
    // Even an identical existing target is an intersection, not authorization to delete a source.
    if (fileSnapshot(plan.root, move.to).bytes !== null) throw new Error('Document destination already exists: ' + move.to);
    plan.change(move.to, move.after, { mode: move.mode, preserveMode: false });
    archive(move);
    plan.change(move.from, null, { overwrite: true, expectedHash: move.beforeHash });
  }
  for (const update of relocation.updates) {
    plan.change(update.to, update.after, { overwrite: true, expectedHash: update.beforeHash });
    archive(update);
  }
  const summary = { schema_version: 1, files: relocation.files, roles: relocation.roles, preserved: relocation.preserved,
    moves: relocation.moves.map(({ bytes, after, ...entry }) => entry),
    updates: relocation.updates.map(({ bytes, after, ...entry }) => entry) };
  if (relocation.roles.length) plan.change('.0-code/run/document-migration/index.json', json(summary), { overwrite: true });
  plan.preflight = relocation.preflight;
  const cycleLockPaths = relocation.cycleLockPaths;
  plan.cycleLockPaths = cycleLockPaths;
  plan.enterGuard = () => enterCycleRelocationGuard(plan.root, cycleLockPaths);
  return summary;
}
