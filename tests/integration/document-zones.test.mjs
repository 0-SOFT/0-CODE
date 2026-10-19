import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadProjectConfig } from '../../core/project-config.mjs';
import { doctorProject } from '../../core/project-doctor.mjs';
import { hashBytes } from '../../core/installation-transaction.mjs';
import { installProject, planProjectInstallation, readInstallationReceipt, uninstallProject, upgradeProject } from '../../core/project-installation.mjs';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const scratch = join(dirname(repository.replace(/[\\/]$/, '')), 'scratch', 'tmp');
mkdirSync(scratch, { recursive: true });
const documents = {
  state: { path: '.0-code/docs/STATE.md' },
  roadmap: { path: '.0-code/docs/ROADMAP.md' },
  reports: { path: '.0-code/docs/reports' },
  decisions: { path: '.0-code/docs/decisions' },
  todo: { path: '.0-code/docs/todo' },
  logs: { path: '.0-code/docs/logs' },
  prompts: { path: '.0-code/docs/prompts' },
  templates: { path: '.0-code/docs/prompts/templates' },
  userdocs: { path: '.0-code/docs/userdocs' },
};
const configuration = (extra = {}) => ({ engines: ['claude'], language: 'ru',
  modules: Object.fromEntries(Object.keys(PROJECT_MODULES).map(id => [id, false])), documents, ...extra });
const state = '---\r\nschema_version: 1\r\nproject_name: owner\r\ncurrent_stage: 2\r\ncurrent_version: "7.0.0"\r\n---\r\n# Owner journal\r\n  Preserve trailing spaces.  \r\n';
function fixture(t, files = {}, directories = []) {
  const root = mkdtempSync(join(scratch, 'document-zones-'));
  t.after(() => cleanupTempDir(root));
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  for (const path of directories) mkdirSync(join(root, path), { recursive: true });
  return root;
}
function snapshot(root, directory = '') {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = directory ? directory + '/' + entry.name : entry.name;
    return entry.isDirectory() ? [[path + '/', null], ...snapshot(root, path)]
      : [[path, readFileSync(join(root, path)).toString('base64')]];
  }).sort(([a], [b]) => a.localeCompare(b, 'en'));
}
function assertPreserved(root, before) {
  for (const [path, bytes] of before) {
    if (bytes === null) assert.equal(lstatSync(join(root, path)).isDirectory(), true, path);
    else assert.equal(readFileSync(join(root, path)).toString('base64'), bytes, path);
  }
}
const isDocument = path => /^\.0-code\/docs(?:\/|$)/i.test(path.replaceAll('\\', '/'));
function assertDocumentOwnershipExcluded(receipt) {
  assert.deepEqual(receipt.files.filter(entry => isDocument(entry.path)), []);
  assert.deepEqual(receipt.directories.filter(isDocument), []);
}
function assertOwnedDoctor(root) {
  const owned = doctorProject(root, { env: { ...process.env, PATH: '' } }).checks.find(check => check.id === 'owned-files');
  assert.equal(owned?.ok, true, owned?.reason);
}
function git(root, args) {
  const result = spawnSync('git', ['-c', 'safe.directory=' + root.replaceAll('\\', '/'), ...args], { cwd: root, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'absent-test-gitconfig') } });
  assert.equal(result.error, undefined);
  return result;
}
function assertIgnored(root, path, expected) {
  const result = git(root, ['check-ignore', '--no-index', '-q', '--', path]);
  assert.equal(result.status, expected ? 0 : 1, path + ': ' + result.stderr);
}

test('all nine internal document roles preserve owner bytes and empty directories through the full lifecycle', t => {
  const root = fixture(t, {
    '.0-code/docs/STATE.md': state,
    '.0-code/docs/ROADMAP.md': '# Owner roadmap\r\nKeep exactly.  \r\n',
    '.0-code/docs/prompts/templates/cycle.md': 'Owner template\r\n',
    '.0-code/docs/reports/raw.bin': Buffer.from([0, 255, 13, 10, 128, 1]),
    '.0-code/docs/owner-extension.txt': 'An arbitrary project document.\n',
    '.0-code/docs/logs/owner.jsonl': '{"owner":true}\r\n',
  }, ['.0-code/docs/unused/empty/nested', '.0-code/docs/decisions/empty']);
  const before = snapshot(root, '.0-code/docs');
  const prepared = planProjectInstallation(root, { config: configuration() });
  assert.deepEqual(snapshot(root, '.0-code/docs'), before, 'planning must not write document files');
  assertDocumentOwnershipExcluded(prepared.receipt);
  for (let cycle = 0; cycle < 2; cycle++) {
    const installed = installProject(root, { config: configuration() });
    assert.ok(installed.result.changed > 0);
    assertDocumentOwnershipExcluded(readInstallationReceipt(root));
    const project = loadProjectConfig({ projectDir: root });
    assert.equal(Object.keys(project.config.documents).length, 9);
    for (const [role, document] of Object.entries(documents)) assert.equal(project.documentRelative(role), document.path, role);
    assert.equal(project.templatePath('cycle'), join(root, '.0-code/docs/prompts/templates/cycle.md'));
    assertOwnedDoctor(root);
    assertPreserved(root, before);
    assert.equal(existsSync(join(root, 'docs')), false);
    assert.equal(installProject(root).result.changed, 0);
    assert.equal(upgradeProject(root).result.changed, 0);
    assertDocumentOwnershipExcluded(readInstallationReceipt(root));
    assertPreserved(root, before);
    writeFileSync(join(root, '.0-code/run/transient.json'), '{"runtime":true}\n');
    uninstallProject(root);
    assertPreserved(root, before);
    assert.equal(existsSync(join(root, '.0-code/installation.json')), false);
    assert.equal(existsSync(join(root, '.0-code/core')), false);
    assert.equal(existsSync(join(root, '.0-code/run')), false);
  }
});

test('an owner log ignore file is preserved exactly during installation and removal', t => {
  const bytes = '# Owner policy\r\n*.private\r\n!public.summary.md\r\n';
  const root = fixture(t, { '.0-code/docs/logs/.gitignore': bytes });
  installProject(root, { config: configuration() });
  assert.equal(readFileSync(join(root, '.0-code/docs/logs/.gitignore'), 'utf8'), bytes);
  assertDocumentOwnershipExcluded(readInstallationReceipt(root));
  upgradeProject(root);
  uninstallProject(root);
  assert.equal(readFileSync(join(root, '.0-code/docs/logs/.gitignore'), 'utf8'), bytes);
});

test('unknown files beside the docs zone still refuse fresh installation and owned lifecycle operations', t => {
  for (const path of ['.0-code/core/foreign.bin', '.0-code/docs-old/trap.txt']) {
    const files = { [path]: Buffer.from([255, 0, 17]), '.0-code/docs/owner.txt': 'Keep owner document\r\n' };
    const fresh = fixture(t, files), before = snapshot(fresh);
    assert.throws(() => installProject(fresh, { config: configuration() }));
    assert.deepEqual(snapshot(fresh), before);
    const installed = fixture(t, { '.0-code/docs/owner.txt': 'Keep owner document\r\n' });
    installProject(installed, { config: configuration() });
    mkdirSync(dirname(join(installed, path)), { recursive: true });
    writeFileSync(join(installed, path), files[path]);
    const occupied = snapshot(installed);
    assert.throws(() => upgradeProject(installed), /Unowned/);
    assert.throws(() => uninstallProject(installed), /Unowned/);
    assert.deepEqual(snapshot(installed), occupied);
    const owned = doctorProject(installed, { env: { ...process.env, PATH: '' } }).checks.find(check => check.id === 'owned-files');
    assert.equal(owned?.ok, false);
    assert.match(owned.reason, /Unowned/);
  }
});

test('forged receipt file and directory ownership cannot claim docs through case or slash variants', t => {
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  const root = fixture(t, { '.0-code/docs/owner.bin': bytes }, ['.0-code/docs/empty']);
  installProject(root, { config: configuration() });
  const receiptPath = join(root, '.0-code/installation.json'), receipt = readInstallationReceipt(root);
  const variants = ['.0-code/docs', '.0-code\\docs', '.0-CODE/DoCs', '.0-CODE\\DoCs'];
  for (const prefix of variants) for (const kind of ['files', 'directories']) {
    const path = kind === 'files' ? prefix + (prefix.includes('\\') ? '\\owner.bin' : '/owner.bin') : prefix;
    const forged = kind === 'files' ? { ...receipt, files: [...receipt.files, { path, hash: hashBytes(bytes), originalHash: null }] }
      : { ...receipt, directories: [...receipt.directories, path] };
    writeFileSync(receiptPath, JSON.stringify(forged, null, 2) + '\n');
    const before = snapshot(root);
    assert.throws(() => readInstallationReceipt(root), undefined, kind + ': ' + path);
    assert.throws(() => upgradeProject(root), undefined, kind + ': ' + path);
    assert.throws(() => uninstallProject(root), undefined, kind + ': ' + path);
    assert.deepEqual(snapshot(root), before, kind + ': ' + path);
  }
});

test('a file occupying the reserved docs root refuses installation without changing bytes', t => {
  const root = fixture(t, { '.0-code/docs': Buffer.from([0, 255, 13, 10]) }), before = snapshot(root);
  assert.throws(() => installProject(root, { config: configuration({ documents: {} }) }));
  assert.deepEqual(snapshot(root), before);
});

test('unconfigured links inside owner documents remain refused by installation and lifecycle ownership', t => {
  for (const installed of [false, true]) {
    const root = fixture(t, { 'outside/owner.txt': 'Owner target bytes\r\n' }, ['.0-code/docs']);
    if (installed) installProject(root, { config: configuration() });
    const receipt = installed ? readFileSync(join(root, '.0-code/installation.json')) : null;
    const link = join(root, '.0-code/docs/unconfigured-link');
    try { symlinkSync(join(root, 'outside'), link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      assert.ok(process.platform === 'win32' && ['EISDIR', 'EPERM', 'ENOTSUP'].includes(error.code));
      assert.equal(existsSync(link), false);
      t.diagnostic('Native document link checks were not exercised: this scratch filesystem does not support links.');
      return;
    }
    if (installed) {
      assert.throws(() => upgradeProject(root), /symlink/);
      assert.throws(() => uninstallProject(root), /symlink/);
      assert.deepEqual(readFileSync(join(root, '.0-code/installation.json')), receipt);
    } else {
      assert.throws(() => installProject(root, { config: configuration() }), /symlink/);
      assert.equal(existsSync(join(root, '.0-code/installation.json')), false);
    }
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(join(root, 'outside/owner.txt'), 'utf8'), 'Owner target bytes\r\n');
  }
});

for (const logs of ['.0-code/docs/logs', '.0-code/docs/private-journals', '.0-code/docs/private[logs]', '.0-code/docs/LOGS']) {
  test('Git keeps durable documents addable and excludes fresh internal logs after uninstall: ' + logs, t => {
    const root = fixture(t, {
      '.0-code/docs/prompts/templates/cycle.md': '# Owner template\r\n',
      '.0-code/docs/example/run/notes.md': '# Durable owner notes\r\n',
      '.0-code/docs/run/notes.md': '# More durable owner notes\r\n',
    });
    assert.equal(git(root, ['init', '-q']).status, 0);
    installProject(root, { config: configuration({ documents: { ...documents, logs: { path: logs } } }) });
    const logPaths = [...new Set(['.0-code/docs/logs', logs])].map(path => path + '/session.jsonl');
    for (const path of logPaths) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), '{"owner":true}\n'); }
    writeFileSync(join(root, '.0-code/run/runtime.jsonl'), '{"runtime":true}\n');
    assertIgnored(root, '.0-code/run/runtime.jsonl', true);
    const durable = [documents.state.path, documents.roadmap.path, '.0-code/docs/prompts/templates/cycle.md',
      '.0-code/docs/example/run/notes.md', '.0-code/docs/run/notes.md'];
    const verify = () => {
      for (const path of logPaths) assertIgnored(root, path, true);
      for (const path of durable) assertIgnored(root, path, false);
      assert.equal(git(root, ['add', '--', ...durable]).status, 0);
      const tracked = git(root, ['ls-files']).stdout.trim().split(/\r?\n/);
      for (const path of durable) assert.ok(tracked.includes(path), path);
      assert.equal(tracked.some(path => path.startsWith('.0-code/run/') || logPaths.includes(path)), false);
    };
    verify();
    upgradeProject(root);
    verify();
    uninstallProject(root);
    assert.equal(existsSync(join(root, '.0-code/run')), false);
    verify();
    installProject(root, { config: configuration({ documents: { ...documents, logs: { path: logs } } }) });
    verify();
    assertOwnedDoctor(root);
  });
}
