// One source for document roles and project paths. Loading configuration never writes files.
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { resolveEngineSettings } from './engine-settings.mjs';

const SOURCE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCHEMA = JSON.parse(readFileSync(join(SOURCE_ROOT, 'schemas', 'config.schema.json'), 'utf8'));
export const CONFIG_PATH = '.0-code/config.json';
export const DOCUMENT_ZONE = '.0-code/docs';
export const isClaudeInstructionPath = path => path.replaceAll('\\', '/').toLowerCase() === 'claude.md';
export function isDocumentZone(path) {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  return normalized === DOCUMENT_ZONE || normalized.startsWith(DOCUMENT_ZONE + '/');
}
export function internalLogDirectories(config) {
  const logs = config.documents.logs.path;
  const directories = [DOCUMENT_ZONE + '/logs', ...(isDocumentZone(logs) ? [logs] : [])];
  const key = path => process.platform === 'win32' ? path.toLowerCase() : path;
  return directories.filter((path, index) => directories.findIndex(other => key(other) === key(path)) === index);
}
export function frameworkIgnorePatterns(config) {
  const literalDirectory = path => '/' + path.slice('.0-code/'.length).replace(/[\[\]!*?# ]/g, '\\$&') + '/';
  return ['/run/', ...internalLogDirectories(config).map(literalDirectory)];
}
// Historical source trees and pre-config installations keep these paths until migration.
export const LEGACY_DOCUMENT_DEFAULTS = Object.freeze({
  state: Object.freeze({ path: 'docs/STATE.md' }),
  roadmap: Object.freeze({ path: 'docs/ROADMAP.md' }),
  reports: Object.freeze({ path: 'docs/reports', name: '<version>_<name>.md' }),
  decisions: Object.freeze({ path: 'docs/decisions', name: '<version>_<name>.md' }),
  todo: Object.freeze({ path: 'docs/todo', name: '<version>_<name>.md' }),
  logs: Object.freeze({ path: 'docs/logs', name: '<date>_<id>.jsonl' }),
  prompts: Object.freeze({ path: 'docs/prompts', name: '<version>_<name>.md' }),
  templates: Object.freeze({ path: 'docs/prompts/templates', name: '<name>.md' }),
  userdocs: Object.freeze({ path: 'docs/userdocs', name: '<version>_<name>.md' }),
});
export const DOCUMENT_DEFAULTS = Object.freeze(Object.fromEntries(
  Object.entries(LEGACY_DOCUMENT_DEFAULTS).map(([role, document]) =>
    [role, Object.freeze({ ...document, path: '.0-code/' + document.path })]),
));
export const MODULE_DEFAULTS = Object.freeze({ audits: true, session_logs: true, token_usage: true,
  telegram: false, pm2: false, mcp_catalog: true, toolset: true });

export function frameworkVersion(root = SOURCE_ROOT) {
  const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid framework VERSION');
  return version;
}

// Validate only the vocabulary actually used by this schema; no second copy of field rules.
function checkSchema(value, schema, path = 'config') {
  if (schema.$ref) return checkSchema(value, schema.$ref.slice(2).split('/').reduce((obj, key) => obj[key], SCHEMA), path);
  const fail = reason => { throw new Error(`${path}: ${reason}`); };
  if ('const' in schema && !isDeepStrictEqual(value, schema.const)) fail('unsupported schema version');
  if (schema.enum && !schema.enum.some(entry => isDeepStrictEqual(entry, value))) fail('unsupported value');
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some(t => t === type || (t === 'integer' && type === 'number' && Number.isSafeInteger(value)))) fail('invalid type');
  }
  if (type === 'string') {
    if (schema.minLength && value.length < schema.minLength) fail('empty value');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('invalid format');
  }
  if (type === 'number' && schema.minimum !== undefined && value < schema.minimum) fail('value below minimum');
  if (type === 'array') {
    if (schema.minItems && value.length < schema.minItems) fail('empty list');
    if (schema.uniqueItems && value.some((entry, i) => value.slice(0, i).some(previous => isDeepStrictEqual(entry, previous)))) fail('duplicate entries');
    value.forEach((entry, i) => checkSchema(entry, schema.items || {}, `${path}[${i}]`));
  }
  if (type === 'object') {
    for (const required of schema.required || []) if (!Object.hasOwn(value, required)) fail(`missing ${required}`);
    for (const key of Object.keys(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) checkSchema(value[key], schema.properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) fail('unknown property');
    }
  }
}

// This is a path in the project, not a URL, shell expression or path on the owner's machine.
export function projectRelativePath(value, { allowRoot = false, allowFramework = false, allowDocuments = false } = {}) {
  if (allowRoot && value === '.') return value;
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f:*?<>|]/.test(value)
    || isAbsolute(value) || win32.isAbsolute(value)) throw new Error('Document path must be project-relative');
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Invalid document path');
  if (parts.some(part => part.toLowerCase() === '.git')) throw new Error('Document path cannot use .git');
  if (!allowFramework && parts[0].toLowerCase() === '.0-code' && !(allowDocuments && isDocumentZone(parts.join('/')))) throw new Error('Project documents must be outside framework code or inside .0-code/docs');
  return parts.join('/');
}

function normalizeName(value) {
  if (typeof value !== 'string' || !value || /[\\/\x00-\x1f:*?|]/.test(value) || /[ .]$/.test(value)) throw new Error('Invalid document name pattern');
  if (/<[^>]*>/.test(value.replace(/<(?:version|name|date|id)>/g, '')) || /[<>]/.test(value.replace(/<(?:version|name|date|id)>/g, ''))) throw new Error('Unknown document name placeholder');
  projectRelativePath(value.replace(/<(?:version|name|date|id)>/g, 'example'));
  return value;
}

export function normalizeProjectConfig(input = {}, { documentDefaults = DOCUMENT_DEFAULTS } = {}) {
  checkSchema(input, SCHEMA);
  const config = {
    schema_version: 1, framework_version: frameworkVersion(), engines: ['claude'], language: 'en',
    documents: {}, modules: { ...MODULE_DEFAULTS },
    toolset: { scope: 'user', defaults: true, enable: [], disable: [] }, guard: { mode: 'arbiter' },
    engine_settings: {}, inventory: {}, ...structuredClone(input),
  };
  config.modules = { ...MODULE_DEFAULTS, ...input.modules };
  config.toolset = { scope: 'user', defaults: true, enable: [], disable: [], ...input.toolset };
  config.guard = { mode: 'arbiter', ...input.guard };
  config.instructions = { claude: 'project-file', ...input.instructions };
  if(config.instructions.claude_settings==='.0-code/claude/settings.json'&&(!config.engines.includes('claude')||config.instructions.claude!=='session-hook'))throw new Error('Session settings require the Claude engine and session-hook instructions');
  for (const [role, fallback] of Object.entries(documentDefaults)) {
    config.documents[role] = { ...fallback, ...input.documents?.[role] };
    const runtimeLogs = role === 'logs' && /^\.0-code\/run\/logs(?:\/|$)/.test(config.documents[role].path);
    config.documents[role].path = projectRelativePath(config.documents[role].path, { allowRoot: 'name' in fallback, allowDocuments: true, allowFramework: runtimeLogs });
    if (!('name' in fallback) && config.documents[role].path.toLowerCase() === DOCUMENT_ZONE) throw new Error('Document file cannot replace the document zone directory');
    if ('name' in config.documents[role]) config.documents[role].name = normalizeName(config.documents[role].name);
  }
  const state = config.documents.state.path.toLowerCase(), roadmap = config.documents.roadmap.path.toLowerCase();
  if (config.instructions.claude === 'session-hook' && [state, roadmap].some(isClaudeInstructionPath)) throw new Error('session-hook document roles cannot use CLAUDE.md');
  if (state === roadmap || state.startsWith(roadmap + '/') || roadmap.startsWith(state + '/')) throw new Error('STATE and ROADMAP paths overlap');
  for (const [role, document] of Object.entries(config.documents)) {
    if (role === 'state' || role === 'roadmap') continue;
    const directory = document.path.toLowerCase();
    if ([state,roadmap].some(file => directory === file || directory.startsWith(file + '/'))) throw new Error('Document directory overlaps a document file');
  }
  if (config.documents.logs.path.toLowerCase() === DOCUMENT_ZONE) throw new Error('Internal logs need a separate document directory');
  for (const [role, document] of Object.entries(config.documents)) {
    if (role === 'logs' || !isDocumentZone(document.path)) continue;
    const directory = document.path.toLowerCase();
    if (internalLogDirectories(config).some(logs => directory === logs.toLowerCase() || directory.startsWith(logs.toLowerCase() + '/'))) throw new Error('Durable documents overlap internal session logs');
  }
  if (config.toolset.enable.some(id => config.toolset.disable.includes(id))) throw new Error('Tool is both enabled and disabled');
  for (const path of config.instructions.project_rules || []) {
    if (projectRelativePath(path, { allowDocuments: true }) !== path || !isDocumentZone(path) || path === DOCUMENT_ZONE) throw new Error('Project rules must be files inside .0-code/docs');
  }
  checkSchema(config, SCHEMA);
  return config;
}

export function findProjectRoot(start = process.cwd()) {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, CONFIG_PATH))) return dir;
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

// Inspect existing ancestors before any future write. Symlinks are not ownership evidence.
export function resolveProjectPath(projectDir, path, { allowRoot = false, allowFramework = false, allowDocuments = false } = {}) {
  const root = resolve(projectDir), destination = resolve(root, projectRelativePath(path, { allowRoot, allowFramework, allowDocuments }));
  const rel = relative(root, destination);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Path escapes the project');
  let current = root;
  // Lexical containment plus lstat of every component rejects links/junctions, including dangling
  // ones. Re-running realpath on every ordinary ancestor adds no evidence once links are excluded.
  for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
    if(part) current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Document path uses a symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return destination;
}

export function loadProjectConfig({ projectDir = findProjectRoot(), config, env = process.env } = {}) {
  projectDir = resolve(projectDir);
  const file = join(projectDir, CONFIG_PATH);
  const installed = existsSync(file);
  const frameworkFolder = join(projectDir, '.0-code');
  if (existsSync(frameworkFolder) && lstatSync(frameworkFolder).isSymbolicLink()) throw new Error('Framework directory cannot be a symlink');
  if (installed && lstatSync(file).isSymbolicLink()) throw new Error('Project config cannot be a symlink');
  if (config === undefined && installed) {
    try { config = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new Error('Project config cannot be read as JSON'); }
  }
  const effective = normalizeProjectConfig(config === undefined ? { documents: LEGACY_DOCUMENT_DEFAULTS } : config);
  const safeDocumentPath = destination => {
    if (effective.instructions.claude === 'session-hook' && isClaudeInstructionPath(relative(projectDir, destination))) throw new Error('session-hook document roles cannot use CLAUDE.md');
    return destination;
  };
  // A configured STATE can be overridden by the driver's explicit state flag.
  const rolePath = (role, values) => {
    const document = effective.documents[role];
    if (!document) throw new Error('Unknown document role');
    const allowFramework = role === 'logs' && /^\.0-code\/run\/logs(?:\/|$)/.test(document.path);
    if (!values || !document.name) return safeDocumentPath(resolveProjectPath(projectDir, document.path, { allowRoot: 'name' in document, allowDocuments: true, allowFramework }));
    const filename = document.name.replace(/<(version|name|date|id)>/g, (_, key) => {
      const value = values[key];
      if (value === undefined || value === null) throw new Error(`Missing document name value: ${key}`);
      const safe = projectRelativePath(String(value));
      if (safe.includes('/')) throw new Error('Document name value cannot contain a directory');
      return safe;
    });
    return safeDocumentPath(resolveProjectPath(projectDir, join(document.path, filename), { allowDocuments: true, allowFramework }));
  };
  const runtimeDir = installed ? join(projectDir, '.0-code', 'run') : dirname(rolePath('state'));
  return {
    projectDir, file, installed, config: effective, providedKeys: Object.keys(config || {}), runtimeDir,
    frameworkDir: installed ? join(projectDir, '.0-code') : SOURCE_ROOT,
    documentPath: rolePath,
    documentRelative: (role, values) => relative(projectDir, rolePath(role, values)).replaceAll('\\', '/'),
    runtimePath(name) {
      if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || /[\x00-\x1f:*?<>|]/.test(name) || name === '.' || name === '..') throw new Error('Invalid runtime file name');
      const destination = join(runtimeDir, name);
      for (const file of [runtimeDir, destination]) {
        try { if (lstatSync(file).isSymbolicLink()) throw new Error('Runtime path cannot use a symlink'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return destination;
    },
    templatePath(name) {
      const own = rolePath('templates', { name });
      return existsSync(own) ? own : join(installed ? join(projectDir, '.0-code') : SOURCE_ROOT, 'templates', normalizeName(name) + '.md');
    },
    engineSettings(engine, explicit = {}) {
      return resolveEngineSettings(engine, explicit, env, effective.engine_settings[engine] || {});
    },
    guardEnvironment: { ...env, SAFETY_GUARD_MODE: env.SAFETY_GUARD_MODE || effective.guard.mode },
  };
}
