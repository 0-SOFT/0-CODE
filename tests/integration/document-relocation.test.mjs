import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { LEGACY_DOCUMENT_DEFAULTS, DOCUMENT_DEFAULTS, loadProjectConfig } from '../../core/project-config.mjs';
import { installProject, planProjectInstallation, readInstallationReceipt, upgradeProject } from '../../core/project-installation.mjs';
import { migrateProject, planProjectMigration } from '../../core/project-migration.mjs';
import { applyInstallationPlan, hashBytes, recoverInstallation } from '../../core/installation-transaction.mjs';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';
import { checkFreshness } from '../../lib/step-instruction.mjs';
import { cleanupTempDir, readFrontmatter } from '../helpers/index.mjs';
import { frameworkSource } from '../helpers/framework-source.mjs';
import { runBootstrap } from '../helpers/bootstrap-run.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const scratch = join(dirname(repository.replace(/[\\/]$/, '')), 'scratch', 'tmp');
const statePath = 'docs/STATE.md', roadmapPath = 'docs/ROADMAP.md';
const promptPath = 'docs/prompts/1.0.0_cycle.md', templatePath = 'docs/prompts/templates/cycle.md';
const reportPath = 'docs/reports/1.0.0_evidence.md';
const selectedFiles = [statePath, roadmapPath, promptPath, templatePath, reportPath];
const manifest = (files = selectedFiles) => ({ schema_version: 1, files: [...files] });
const target = path => '.0-code/' + path;
const selectedRoles = ['state', 'roadmap', 'reports', 'prompts', 'templates'];
const relocatedDocuments = documents => Object.fromEntries(Object.entries(documents).map(([role, document]) =>
  [role, selectedRoles.includes(role) ? DOCUMENT_DEFAULTS[role] : document]));

function stateBytes(relocated = false) {
  const pointer = path => relocated ? target(path) : path;
  return Buffer.from([
    '---',
    'schema_version: 1',
    'project_name: "relocation fixture"',
    'current_version: "1.0.0"',
    'released_version: "1.0.0"',
    'current_stage: 4',
    'iteration: 12',
    'blockers: []',
    'running_jobs: []',
    `current_prompt_file: "${pointer(promptPath)}"`,
    `next_step_prompt: "Read ${pointer(promptPath)}; consult ${pointer(statePath)} and ${pointer(roadmapPath)}."`,
    'next_step_prompt_meta:',
    '  version: "1.0.0"',
    '  stage: 4',
    `  prompt_file: "${pointer(promptPath)}"`,
    '  at: "2026-01-01T00:00:00Z"',
    'last_action: "Historical note mentions docs/STATE.md."',
    'last_action_at: "2026-01-01T00:00:00Z"',
    '---',
    '',
    '# Exact owner journal  ',
    'Historical docs/STATE.md and docs/prompts/1.0.0_cycle.md stay unchanged here.',
    '',
  ].join('\r\n'));
}

function templateBytes(relocated = false) {
  const pointer = path => relocated ? target(path) : path;
  return Buffer.from(`\ufeff# Owner cycle template  \r\nRead \`${pointer(statePath)}\` and [roadmap](${pointer(roadmapPath)}).\r\nUse ${pointer(promptPath)}.\r\nProduct reference: docs/reports/product-spec.md.\r\n`);
}

function configuration(documents = LEGACY_DOCUMENT_DEFAULTS) {
  return { engines: ['claude'], language: 'ru', documents: structuredClone(documents),
    modules: Object.fromEntries(Object.keys(PROJECT_MODULES).map(id => [id, false])) };
}

function fixture(t, { documents = LEGACY_DOCUMENT_DEFAULTS, legacy = false } = {}) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'document-relocation-'));
  t.after(() => cleanupTempDir(root));
  const framework = frameworkSource(t);
  const put = (path, bytes) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); };
  const report = Buffer.concat([Buffer.from('# Exact historical report\r\ndocs/STATE.md\r\n'), Buffer.from([0, 255, 195, 40])]);
  put(documents.state.path, stateBytes());
  put(documents.roadmap.path, '# Owner roadmap\r\nExact trailing spaces.  \r\n');
  put(promptPath, '---\r\nversion: "1.0.0"\r\nstage: 2\r\n---\r\n# Historical prompt mentions docs/STATE.md.\r\n');
  put(templatePath, templateBytes());
  const reportFile = documents.reports.path + '/1.0.0_evidence.md';
  put(reportFile, report);
  put('docs/product.md', '# Product documentation\r\nKeep these exact bytes.  \r\n');
  put('docs/reports/product-spec.md', '# Product report with a colliding role directory\r\n');
  const config = configuration(documents);
  if (legacy) put('core/gates.mjs', framework.legacyFiles['core/gates.mjs']);
  else installProject(root, { source: framework.source, config });
  return { root, source: framework.source, config, put, report, reportFile };
}

function snapshot(root) {
  const rows = [];
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { rows.push([path + '/', null]); visit(join(directory, entry.name), path); }
      else rows.push([path, readFileSync(join(directory, entry.name)).toString('base64')]);
    }
  };
  visit(root);
  return rows.sort(([a], [b]) => a.localeCompare(b, 'en'));
}

function assertRawMoves(f, prepared, before) {
  for (const path of selectedFiles) {
    assert.equal(existsSync(join(f.root, path)), false, path);
    const bytes = readFileSync(join(f.root, target(path)));
    assert.deepEqual(bytes, path === statePath ? stateBytes(true) : path === templatePath ? templateBytes(true) : before.get(path), path);
    const move = prepared.documentMigration.moves.find(entry => entry.from === path);
    assert.ok(move, path);
    assert.equal(move.to, target(path));
    assert.equal(move.beforeHash, hashBytes(before.get(path)));
    assert.equal(move.afterHash, hashBytes(bytes));
    if (path === statePath || path === templatePath) {
      assert.match(move.backup, /^\.0-code\/run\/document-migration\/[a-f0-9]{64}\.bin$/);
      assert.deepEqual(readFileSync(join(f.root, move.backup)), before.get(path));
    }
  }
}

test('document relocation plans exact files without writes and upgrades bytes, pointers and roles atomically', t => {
  const f = fixture(t), before = snapshot(f.root);
  const bytes = new Map(selectedFiles.map(path => [path, readFileSync(join(f.root, path))]));
  const productBytes = ['docs/product.md', 'docs/reports/product-spec.md'].map(path => [path, readFileSync(join(f.root, path))]);
  const planned = planProjectInstallation(f.root, { source: f.source, upgrade: true, documentManifest: manifest() });
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(planned.documentMigration.moves.length, selectedFiles.length);
  assert.ok(planned.plan.summary().some(entry => entry.path === target(statePath)));
  const upgraded = upgradeProject(f.root, { source: f.source, documentManifest: manifest() });
  assert.ok(upgraded.result.changed > 0);
  assertRawMoves(f, upgraded, bytes);
  assert.deepEqual(loadProjectConfig({ projectDir: f.root }).config.documents, relocatedDocuments(LEGACY_DOCUMENT_DEFAULTS));
  assert.equal(checkFreshness(readFrontmatter(join(f.root, target(statePath)))).status, 'fresh');
  for (const [path, original] of productBytes) assert.deepEqual(readFileSync(join(f.root, path)), original, path);
  const receipt = readInstallationReceipt(f.root);
  assert.equal(receipt.files.some(entry => entry.path.startsWith('.0-code/docs/')), false);
  assert.equal(receipt.directories.some(path => path === '.0-code/docs' || path.startsWith('.0-code/docs/')), false);
  const after = snapshot(f.root), repeated = upgradeProject(f.root, { source: f.source, documentManifest: manifest() });
  assert.equal(repeated.result.changed, 0);
  assert.deepEqual(snapshot(f.root), after);
});

test('upgrade without an explicit document manifest preserves historical external roles and every document byte', t => {
  const f = fixture(t), before = snapshot(f.root);
  const upgraded = upgradeProject(f.root, { source: f.source });
  assert.equal(upgraded.result.changed, 0);
  assert.deepEqual(loadProjectConfig({ projectDir: f.root }).config.documents, LEGACY_DOCUMENT_DEFAULTS);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(join(f.root, target(statePath))), false);
});

test('relocation rewrites Windows separators and case aliases without changing product paths or history', t => {
  const f = fixture(t);
  const sourcePrompt = process.platform === 'win32' ? 'Docs/Prompts/1.0.0_cycle.md' : promptPath;
  const windowsPrompt = sourcePrompt.replaceAll('/', '\\');
  const mixedPrompt = sourcePrompt.replace(/docs\//i, process.platform === 'win32' ? 'Docs\\' : 'docs\\');
  const originalState = stateBytes().toString().replaceAll(`"${promptPath}"`, JSON.stringify(windowsPrompt))
    .replace(/^next_step_prompt:[^\r\n]*/m, 'next_step_prompt: ' + JSON.stringify(`Read ${mixedPrompt}; consult ${statePath} and ${roadmapPath}.`));
  const originalTemplate = templateBytes().toString().replaceAll(statePath, statePath.replaceAll('/', '\\'))
    .replaceAll(promptPath, mixedPrompt).replaceAll('docs/reports/product-spec.md', 'Docs\\Reports\\product-spec.md');
  f.put(statePath, originalState); f.put(templatePath, originalTemplate);
  const before = snapshot(f.root);
  const prepared = planProjectInstallation(f.root, { source: f.source, upgrade: true, documentManifest: manifest() });
  assert.deepEqual(snapshot(f.root), before);
  applyInstallationPlan(prepared.plan);
  const state = readFrontmatter(join(f.root, target(statePath)));
  assert.equal(state.current_prompt_file, target(promptPath));
  assert.equal(state.next_step_prompt_meta.prompt_file, target(promptPath));
  assert.match(state.next_step_prompt, /Read \.0-code\/docs\/prompts\/1\.0\.0_cycle\.md;/);
  assert.ok(existsSync(join(f.root, state.current_prompt_file)));
  assert.equal(state.last_action, 'Historical note mentions docs/STATE.md.');
  assert.match(readFileSync(join(f.root, target(statePath)), 'utf8'), /Historical docs\/STATE\.md and docs\/prompts\/1\.0\.0_cycle\.md stay unchanged here\./);
  const template = readFileSync(join(f.root, target(templatePath)), 'utf8');
  assert.ok(template.includes(target(statePath)) && template.includes(target(promptPath)));
  assert.ok(template.includes('Docs\\Reports\\product-spec.md'));
  for (const [path, bytes] of [[statePath, originalState], [templatePath, originalTemplate]]) {
    const move = prepared.documentMigration.moves.find(entry => entry.from === path);
    assert.deepEqual(readFileSync(join(f.root, move.backup)), Buffer.from(bytes));
  }
  assert.equal(upgradeProject(f.root, { source: f.source, documentManifest: manifest() }).result.changed, 0);
});

test('explicit custom external roles stay external while selected standard roles relocate', t => {
  const documents = { ...LEGACY_DOCUMENT_DEFAULTS, reports: { path: 'product/reports', name: 'custom-<name>.md' } };
  const f = fixture(t, { documents }), files = selectedFiles.filter(path => path !== reportPath);
  const original = readFileSync(join(f.root, f.reportFile));
  upgradeProject(f.root, { source: f.source, documentManifest: manifest(files) });
  assert.deepEqual(loadProjectConfig({ projectDir: f.root }).config.documents, { ...relocatedDocuments(documents), reports: documents.reports });
  assert.deepEqual(readFileSync(join(f.root, f.reportFile)), original);
  assert.equal(existsSync(join(f.root, target(reportPath))), false);
  const before = snapshot(f.root);
  assert.throws(() => planProjectInstallation(f.root, { source: f.source, upgrade: true, documentManifest: manifest([f.reportFile]) }));
  assert.deepEqual(snapshot(f.root), before);
});

test('unselected standard roles preserve owner files and paths and the same manifest replays without writes', t => {
  const f = fixture(t), ownerPath = 'docs/userdocs/owner.md';
  const ownerBytes = Buffer.from('# Owner product documentation\r\nKeep exact bytes.  \r\n');
  f.put(ownerPath, ownerBytes);
  const result = upgradeProject(f.root, { source: f.source, documentManifest: manifest() });
  assert.deepEqual(result.documentMigration.roles.map(entry => entry.role).sort(), [...selectedRoles].sort());
  for (const role of ['decisions', 'todo', 'logs', 'userdocs']) {
    assert.deepEqual(loadProjectConfig({ projectDir: f.root }).config.documents[role], LEGACY_DOCUMENT_DEFAULTS[role]);
    if (role !== 'logs') assert.equal(existsSync(join(f.root, DOCUMENT_DEFAULTS[role].path)), false);
  }
  assert.deepEqual(readFileSync(join(f.root, ownerPath)), ownerBytes);
  const after = snapshot(f.root);
  const repeated = upgradeProject(f.root, { source: f.source, documentManifest: manifest() });
  assert.equal(repeated.result.changed, 0);
  assert.deepEqual(snapshot(f.root), after);
  f.put(target(reportPath), '# Changed recorded target\r\n');
  const changed = snapshot(f.root);
  assert.throws(() => upgradeProject(f.root, { source: f.source, documentManifest: manifest() }));
  assert.deepEqual(snapshot(f.root), changed);
});

test('an empty manifest leaves standard roles external and an unselected roadmap keeps its pointer', t => {
  const f = fixture(t), before = snapshot(f.root);
  assert.equal(upgradeProject(f.root, { source: f.source, documentManifest: manifest([]) }).result.changed, 0);
  assert.deepEqual(snapshot(f.root), before);
  const roadmap = readFileSync(join(f.root, roadmapPath));
  const files = selectedFiles.filter(path => path !== roadmapPath);
  upgradeProject(f.root, { source: f.source, documentManifest: manifest(files) });
  assert.deepEqual(readFileSync(join(f.root, roadmapPath)), roadmap);
  assert.deepEqual(loadProjectConfig({ projectDir: f.root }).config.documents.roadmap, LEGACY_DOCUMENT_DEFAULTS.roadmap);
  assert.ok(readFrontmatter(join(f.root, target(statePath))).next_step_prompt.includes('consult .0-code/docs/STATE.md and docs/ROADMAP.md.'));
  const after = snapshot(f.root);
  assert.equal(upgradeProject(f.root, { source: f.source, documentManifest: manifest(files) }).result.changed, 0);
  assert.deepEqual(snapshot(f.root), after);
});

test('external state and templates require explicit permission for pointer updates while keeping their paths', t => {
  const externalState = 'work/STATE.md', externalTemplate = 'patterns/cycle.md';
  const documents = { ...LEGACY_DOCUMENT_DEFAULTS, state: { path: externalState }, templates: { path: 'patterns', name: '<name>.md' } };
  const f = fixture(t, { documents });
  const originalState = Buffer.from(stateBytes().toString().replaceAll(statePath, externalState));
  const originalTemplate = Buffer.from(templateBytes().toString().replaceAll(statePath, externalState));
  f.put(externalState, originalState); f.put(externalTemplate, originalTemplate);
  const files = [externalState, roadmapPath, promptPath, externalTemplate, reportPath];
  for (const omitted of [externalState, externalTemplate]) {
    const before = snapshot(f.root);
    assert.throws(() => upgradeProject(f.root, { source: f.source, documentManifest: manifest(files.filter(path => path !== omitted)) }));
    assert.deepEqual(snapshot(f.root), before);
  }
  const result = upgradeProject(f.root, { source: f.source, documentManifest: manifest(files) });
  assert.deepEqual(result.documentMigration.updates.map(entry => entry.to).sort(), [externalState, externalTemplate].sort());
  const expectedState = Buffer.from(stateBytes(true).toString().replaceAll(target(statePath), externalState).replaceAll(statePath, externalState));
  const expectedTemplate = Buffer.from(templateBytes(true).toString().replaceAll(target(statePath), externalState));
  assert.deepEqual(readFileSync(join(f.root, externalState)), expectedState);
  assert.deepEqual(readFileSync(join(f.root, externalTemplate)), expectedTemplate);
  for (const [path, original] of [[externalState, originalState], [externalTemplate, originalTemplate]]) {
    const update = result.documentMigration.updates.find(entry => entry.to === path);
    assert.deepEqual(readFileSync(join(f.root, update.backup)), original);
  }
  assert.equal(loadProjectConfig({ projectDir: f.root }).config.documents.state.path, externalState);
  assert.equal(loadProjectConfig({ projectDir: f.root }).config.documents.templates.path, 'patterns');
  assert.equal(existsSync(join(f.root, target(statePath))), false);
});

test('a nested custom role cannot be relocated through its eligible parent directory', t => {
  const documents = { ...LEGACY_DOCUMENT_DEFAULTS, reports: { path: 'docs/prompts/product-reports', name: '<version>_<name>.md' } };
  const f = fixture(t, { documents }), files = selectedFiles.filter(path => path !== reportPath);
  const before = snapshot(f.root);
  assert.throws(() => upgradeProject(f.root, { source: f.source, documentManifest: manifest([...files, f.reportFile]) }));
  assert.deepEqual(snapshot(f.root), before);
  upgradeProject(f.root, { source: f.source, documentManifest: manifest(files) });
  assert.deepEqual(readFileSync(join(f.root, f.reportFile)), f.report);
  assert.equal(loadProjectConfig({ projectDir: f.root }).config.documents.reports.path, documents.reports.path);
  assert.equal(existsSync(join(f.root, target(f.reportFile))), false);
});

test('equally specific shared standard and custom roles refuse an ambiguous selected file', t => {
  const documents = { ...LEGACY_DOCUMENT_DEFAULTS, templates: { path: 'docs/prompts', name: 'custom-<name>.md' } };
  const f = fixture(t, { documents }), sharedTemplate = 'docs/prompts/custom-cycle.md';
  f.put(sharedTemplate, templateBytes());
  const before = snapshot(f.root);
  assert.throws(() => upgradeProject(f.root, { source: f.source,
    documentManifest: manifest([statePath, roadmapPath, sharedTemplate, reportPath]) }), /ambiguous shared roles/);
  assert.deepEqual(snapshot(f.root), before);
});

test('all nine standard roles relocate and a selected log ignore keeps its exact bytes', t => {
  const f = fixture(t);
  const extra = new Map([
    ['docs/decisions/1.0.0_layout.md', Buffer.from('# Cycle decision\r\n')],
    ['docs/todo/1.0.0_followup.md', Buffer.from('# Cycle followup\r\n')],
    ['docs/userdocs/1.0.0_usage.md', Buffer.from('# Selected cycle usage\r\n')],
    ['docs/logs/2026-01-01_session.jsonl', Buffer.from('{"event":"saved"}\r\n')],
    ['docs/logs/.gitignore', Buffer.from('# Owner log policy\r\n*\r\n')],
  ]);
  for (const [path, bytes] of extra) f.put(path, bytes);
  const result = upgradeProject(f.root, { source: f.source, documentManifest: manifest([...selectedFiles, ...extra.keys()]) });
  assert.equal(result.documentMigration.roles.length, 9);
  for (const [path, bytes] of extra) {
    assert.equal(existsSync(join(f.root, path)), false);
    assert.deepEqual(readFileSync(join(f.root, target(path))), bytes);
  }
});

test('identical selected templates share one original-byte archive without duplicate plan paths', t => {
  const f = fixture(t), secondTemplate = 'docs/prompts/templates/another.md';
  f.put(secondTemplate, templateBytes());
  const documentManifest = manifest([...selectedFiles, secondTemplate]);
  const planned = planProjectInstallation(f.root, { source: f.source, upgrade: true, documentManifest });
  const first = planned.documentMigration.moves.find(entry => entry.from === templatePath);
  const second = planned.documentMigration.moves.find(entry => entry.from === secondTemplate);
  assert.equal(first.backup, second.backup);
  assert.equal(planned.plan.summary().filter(entry => entry.path === first.backup).length, 1);
  upgradeProject(f.root, { source: f.source, documentManifest });
  assert.deepEqual(readFileSync(join(f.root, target(templatePath))), templateBytes(true));
  assert.deepEqual(readFileSync(join(f.root, target(secondTemplate))), templateBytes(true));
  assert.deepEqual(readFileSync(join(f.root, first.backup)), templateBytes());
});

test('a state file at the project root uses root runtime paths and remains external', t => {
  const documents = { ...LEGACY_DOCUMENT_DEFAULTS, state: { path: 'STATE.md' } };
  const f = fixture(t, { documents });
  f.put('STATE.md', stateBytes().toString().replaceAll(statePath, 'STATE.md'));
  f.put(templatePath, templateBytes().toString().replaceAll(statePath, 'STATE.md'));
  const result = upgradeProject(f.root, { source: f.source, documentManifest: manifest(selectedFiles.map(path => path === statePath ? 'STATE.md' : path)) });
  assert.equal(result.documentMigration.updates.find(entry => entry.to === 'STATE.md').from, 'STATE.md');
  assert.equal(loadProjectConfig({ projectDir: f.root }).config.documents.state.path, 'STATE.md');
  assert.equal(existsSync(join(f.root, '.loop.lock.guard')), false);
  assert.equal(existsSync(join(f.root, '.loop.lock')), false);
  assert.equal(readFrontmatter(join(f.root, 'STATE.md')).current_prompt_file, target(promptPath));
});

test('a template role at the project root updates only an explicitly selected matching file', t => {
  const documents = { ...LEGACY_DOCUMENT_DEFAULTS, templates: { path: '.', name: '<name>.md' } };
  const f = fixture(t, { documents }), rootTemplate = 'cycle.md';
  f.put(rootTemplate, templateBytes());
  const product = Buffer.from('# Product README\r\nKeep exact trailing spaces.  \r\n');
  f.put('README.md', product);
  const files = selectedFiles.map(path => path === templatePath ? rootTemplate : path);
  const result = upgradeProject(f.root, { source: f.source, documentManifest: manifest(files) });
  assert.equal(result.documentMigration.updates.find(entry => entry.to === rootTemplate).from, rootTemplate);
  assert.deepEqual(readFileSync(join(f.root, rootTemplate)), templateBytes(true));
  assert.deepEqual(readFileSync(join(f.root, 'README.md')), product);
  assert.equal(loadProjectConfig({ projectDir: f.root }).config.documents.templates.path, '.');
});

test('legacy migration uses the same relocation plan and preserves unrelated product files', t => {
  const f = fixture(t, { legacy: true }), before = snapshot(f.root);
  const bytes = new Map(selectedFiles.map(path => [path, readFileSync(join(f.root, path))]));
  const options = { source: f.source, config: f.config, documentManifest: manifest() };
  const planned = planProjectMigration(f.root, options);
  assert.equal(planned.documentMigration.moves.length, selectedFiles.length);
  assert.deepEqual(snapshot(f.root), before);
  const migrated = migrateProject(f.root, options);
  assertRawMoves(f, migrated, bytes);
  assert.equal(existsSync(join(f.root, 'core/gates.mjs')), false);
  assert.deepEqual(readFileSync(join(f.root, 'docs/product.md')).toString('base64'), before.find(([path]) => path === 'docs/product.md')[1]);
  assert.deepEqual(loadProjectConfig({ projectDir: f.root }).config.documents, relocatedDocuments(LEGACY_DOCUMENT_DEFAULTS));
  const after = snapshot(f.root);
  assert.equal(migrateProject(f.root, { source: f.source, documentManifest: manifest() }).result.changed, 0);
  assert.deepEqual(snapshot(f.root), after);
});

test('invalid, missing, duplicate and out-of-role manifest entries refuse before any write', t => {
  const f = fixture(t);
  const invalid = [
    null,
    { schema_version: 2, files: selectedFiles },
    { schema_version: 1, files: 'docs/STATE.md' },
    manifest([...selectedFiles, statePath]),
    manifest([...selectedFiles, 'docs/reports/missing.md']),
    manifest([...selectedFiles, 'docs/product.md']),
    manifest([...selectedFiles, '.0-code/core/gates.mjs']),
    manifest([...selectedFiles, '../outside.md']),
    manifest([...selectedFiles, 'docs/reports']),
    manifest(selectedFiles.filter(path => path !== statePath)),
  ];
  for (const documentManifest of invalid) {
    const before = snapshot(f.root);
    assert.throws(() => planProjectInstallation(f.root, { source: f.source, upgrade: true, documentManifest }), JSON.stringify(documentManifest));
    assert.deepEqual(snapshot(f.root), before);
  }
});

test('an occupied destination refuses relocation without replacing source or target bytes', t => {
  const f = fixture(t);
  f.put(target(reportPath), '# Existing owner evidence at the destination\r\n');
  const before = snapshot(f.root);
  assert.throws(() => upgradeProject(f.root, { source: f.source, documentManifest: manifest() }));
  assert.deepEqual(snapshot(f.root), before);
});

test('a live installed or historical loop lock refuses relocation before writes', t => {
  for (const lockPath of ['.0-code/run/.loop.lock', 'docs/.loop.lock']) {
    const f = fixture(t);
    f.put(lockPath, JSON.stringify({ pid: process.pid, engine: 'supervisor', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
    const before = snapshot(f.root);
    assert.throws(() => upgradeProject(f.root, { source: f.source, documentManifest: manifest() }));
    assert.deepEqual(snapshot(f.root), before);
  }
});

test('an unfinished STATE or uncollected jobs refuse relocation even without a loop lock', t => {
  const f = fixture(t);
  const states = [
    stateBytes().toString().replace('released_version: "1.0.0"', 'released_version: "0.9.0"'),
    stateBytes().toString().replace('running_jobs: []', 'running_jobs: [{"id":"unfinished","pid":1}]'),
  ];
  for (const state of states) {
    f.put(statePath, state);
    const before = snapshot(f.root);
    assert.throws(() => upgradeProject(f.root, { source: f.source, documentManifest: manifest() }));
    assert.deepEqual(snapshot(f.root), before);
  }
});

test('malformed runtime markers refuse relocation instead of treating unknown ownership as absent', t => {
  const f = fixture(t);
  for (const [path, bytes] of [
    ['.0-code/run/.loop.lock', '{broken'],
    ['docs/.loop.lock', JSON.stringify({ pid: process.pid })],
    ['.0-code/run/.loop-children', JSON.stringify({ pids: ['unknown'] })],
    ['docs/.loop-children', 'null'],
  ]) {
    f.put(path, bytes);
    const before = snapshot(f.root);
    assert.throws(() => upgradeProject(f.root, { source: f.source, documentManifest: manifest() }));
    assert.deepEqual(snapshot(f.root), before);
    unlinkSync(join(f.root, path));
  }
});

test('a cycle acquiring its lock after upgrade or legacy migration planning prevents every document write', t => {
  for (const legacy of [false, true]) {
    const f = fixture(t, { legacy });
    const options = { source: f.source, upgrade: true, documentManifest: manifest() };
    const planned = legacy ? planProjectMigration(f.root, { ...options, config: f.config }) : planProjectInstallation(f.root, options);
    f.put(legacy ? 'docs/.loop.lock' : '.0-code/run/.loop.lock', JSON.stringify({ pid: process.pid, engine: 'supervisor', startedAt: new Date().toISOString() }));
    const before = snapshot(f.root);
    assert.throws(() => applyInstallationPlan(planned.plan));
    assert.deepEqual(snapshot(f.root), before);
  }
});

test('a file changed after planning prevents publication of the entire relocation', t => {
  const f = fixture(t);
  const planned = planProjectInstallation(f.root, { source: f.source, upgrade: true, documentManifest: manifest() });
  f.put(reportPath, '# Evidence edited after review\r\n');
  const before = snapshot(f.root);
  assert.throws(() => applyInstallationPlan(planned.plan));
  assert.deepEqual(snapshot(f.root), before);
});

test('a failure after document publication rolls back files, config, pointers and private archives', t => {
  const f = fixture(t), before = snapshot(f.root);
  const planned = planProjectInstallation(f.root, { source: f.source, upgrade: true, documentManifest: manifest() });
  const lastChange = planned.plan.changes.at(-1);
  assert.equal(lastChange.path, '.0-code/run/document-migration/index.json');
  let observedPublishedDocuments = false;
  Object.defineProperty(lastChange, 'mode', { get() {
    observedPublishedDocuments = !existsSync(join(f.root, statePath)) && existsSync(join(f.root, target(reportPath)))
      && loadProjectConfig({ projectDir: f.root }).config.documents.state.path === target(statePath);
    return -1;
  } });
  assert.throws(() => applyInstallationPlan(planned.plan));
  assert.equal(observedPublishedDocuments, true, 'The injected invalid mode must fail after document writes');
  assert.deepEqual(snapshot(f.root), before);
});

test('crash recovery refuses a live cycle lock and restores the original installation after it stops', t => {
  const f = fixture(t), before = snapshot(f.root);
  const planned = planProjectInstallation(f.root, { source: f.source, upgrade: true, documentManifest: manifest() });
  const move = planned.documentMigration.moves.find(entry => entry.from === statePath);
  const stateChange = planned.plan.changes.find(entry => entry.path === move.to);
  f.put(move.to, stateChange.after);
  unlinkSync(join(f.root, move.from));
  const journal = { schema_version: 1, missingDirectories: ['.0-code/docs'], runtimeIgnoreCreated: false,
    cycleLockPaths: planned.plan.cycleLockPaths,
    changes: planned.plan.changes.map(entry => ({ path: entry.path,
      before: entry.before === null ? null : entry.before.toString('base64'), beforeHash: entry.beforeHash,
      beforeMode: entry.beforeMode, afterHash: entry.afterHash })) };
  assert.deepEqual([...journal.cycleLockPaths].sort(), ['.0-code/run/.loop.lock', 'docs/.loop.lock'].sort());
  f.put('.0-code/run/installation-transaction.json', JSON.stringify(journal));
  f.put('.0-code/run/.loop.lock', JSON.stringify({ pid: process.pid, engine: 'supervisor', startedAt: new Date().toISOString() }));
  const interrupted = snapshot(f.root);
  assert.throws(() => recoverInstallation(f.root));
  assert.deepEqual(snapshot(f.root), interrupted);
  unlinkSync(join(f.root, '.0-code/run/.loop.lock'));
  assert.equal(recoverInstallation(f.root).recovered, true);
  assert.deepEqual(snapshot(f.root), before);
});

test('unchanged moved documents retain Git rename detection and relocation leaves the index untouched', t => {
  const f = fixture(t);
  const git = args => {
    const result = spawnSync('git', args, { cwd: f.root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git(['init']);
  git(['config', 'core.autocrlf', 'false']);
  git(['add', '--all']);
  git(['-c', 'user.name=Verification', '-c', 'user.email=verification@invalid.local', 'commit', '-m', 'Historical external documents']);
  const index = readFileSync(join(f.root, '.git/index'));
  upgradeProject(f.root, { source: f.source, documentManifest: manifest() });
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), index);
  git(['add', '--all']);
  const changes = git(['diff', '--cached', '--name-status', '-M']).split(/\r?\n/);
  for (const path of [reportPath, promptPath, roadmapPath]) assert.ok(changes.includes(`R100\t${path}\t${target(path)}`), changes.join('\n'));
  assert.equal(git(['ls-files', '.0-code/run']).trim(), '');
});

test('the actual CLI previews and applies an explicit manifest without dry-run writes', async t => {
  const f = fixture(t), manifestFile = join(f.root, 'relocation.json');
  writeFileSync(manifestFile, JSON.stringify(manifest()));
  const args = [join(repository, 'tools/0code.mjs'), 'upgrade', '--project', f.root, '--source', f.source,
    '--relocate-documents', manifestFile, '--json'];
  const before = snapshot(f.root);
  const preview = await runBootstrap(process.execPath, [...args, '--dry-run']);
  assert.equal(preview.status, 0, preview.stderr);
  const dryRun = JSON.parse(preview.stdout);
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.documentMigration.moves.length, selectedFiles.length);
  assert.deepEqual(snapshot(f.root), before);
  const applied = await runBootstrap(process.execPath, args);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).documentMigration.moves.length, selectedFiles.length);
  assert.deepEqual(readFileSync(join(f.root, target(reportPath))), f.report);
  const after = snapshot(f.root), repeated = await runBootstrap(process.execPath, args);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).changed, 0);
  assert.deepEqual(snapshot(f.root), after);
});
