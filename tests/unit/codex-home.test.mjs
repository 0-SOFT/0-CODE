import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CodexHome, canonicalCodexPath } from '../../core/backends/codex-home.mjs';
import { CodexBackend } from '../../core/backends/codex.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
import { installProject } from '../../core/project-installation.mjs';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';

const scratch = process.env.FRAMEWORK_TEST_TMPDIR || tmpdir();
function fixture(t) {
  mkdirSync(scratch, { recursive: true });
  const base = mkdtempSync(join(scratch, 'codex-home-test-'));
  t.after(() => cleanupTempDir(base));
  const project = join(base, 'project'), personal = join(base, 'personal'), home = join(base, 'owned');
  mkdirSync(project); mkdirSync(personal);
  return { base, project, personal, home, env: { CODEX_HOME: personal } };
}
const fakeLogin = '{"TEST_ONLY":"source-login"}\n';

test('installed personal guard runtime stays in .0-code/run and keeps captured restoration and auth isolation',t=>{
  const f=fixture(t);writeFileSync(join(f.personal,'auth.json'),fakeLogin);
  installProject(f.project,{config:{engines:['codex'],modules:Object.fromEntries(Object.keys(PROJECT_MODULES).map(id=>[id,false]))}});
  const host=new CodexHome({env:f.env,userHome:join(f.base,'user'),stateDir:join(f.base,'unused-state')});
  const ready=host.prepareExecution({cwd:f.project});
  assert.equal(ready.home,join(f.project,'.0-code/run/codex-guard'));
  assert.equal(ready.executionHome,f.personal);assert.equal(existsSync(join(f.base,'unused-state')),false);
  assert.equal(existsSync(join(ready.home,'auth.json')),false);assert.equal(readFileSync(join(f.personal,'auth.json'),'utf8'),fakeLogin);
  const captured=readFileSync(ready.safetyFile);writeFileSync(ready.safetyFile,'damaged');
  const restored=host.prepareExecution({cwd:f.project});assert.ok(restored.restored.includes(ready.safetyFile));
  assert.deepEqual(readFileSync(ready.safetyFile),captured);
  const other=fixture(t);installProject(other.project,{config:{modules:Object.fromEntries(Object.keys(PROJECT_MODULES).map(id=>[id,false]))}});
  const runtime=join(other.project,'.0-code/run/codex-guard');mkdirSync(runtime,{recursive:true});writeFileSync(join(runtime,'owner.txt'),'preserve');
  const unowned=new CodexHome({env:other.env,userHome:join(other.base,'user')});assert.throws(()=>unowned.prepareExecution({cwd:other.project}),/unowned files/);
  assert.equal(readFileSync(join(runtime,'owner.txt'),'utf8'),'preserve');
});

// F: rejects both Node links (EISDIR) and native junctions (Incorrect function).
// Model only the OS path/stat responses; all writes and sentinel checks remain real.
// These are unit tests of link handling, not claims of native junction acceptance.
function redirectedPath(from, to) {
  return path => {
    const tail = relative(from, path);
    const redirected = !tail || (tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail));
    return realpathSync.native(redirected ? join(to, tail) : path);
  };
}
const linkStat = { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };

test('dry-run and backend construction neither launch CLI nor create state or import auth', t => {
  const f = fixture(t);
  writeFileSync(join(f.personal, 'auth.json'), fakeLogin);
  const inspect = () => { throw new Error('CLI must not run'); };
  const b = new CodexBackend({ env: f.env, homeDir: f.home, inspect, launch: inspect });
  const before = readdirSync(f.base);
  const result = b.prepareHome({ cwd: f.project, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.restored, []);
  assert.deepEqual(readdirSync(f.base), before);
  assert.equal(existsSync(f.home), false);
  assert.equal(readFileSync(join(f.personal, 'auth.json'), 'utf8'), fakeLogin);
});

test('one canonical project has one home, sibling projects differ, modelled aliases share identity', t => {
  const f = fixture(t), second = join(f.base, 'second'); mkdirSync(second);
  const h = new CodexHome({ env: f.env, stateDir: join(f.base, 'state') });
  const a = h.plan({ cwd: f.project });
  assert.equal(h.plan({ cwd: join(f.project, '.') }).home, a.home);
  assert.notEqual(h.plan({ cwd: second }).home, a.home);
  assert.equal(existsSync(join(f.base, 'state')), false);
  const alias = join(f.base, 'project-alias');
  const aliased = new CodexHome({ env: f.env, stateDir: join(f.base, 'state'),
    pathAccess: { realpath: redirectedPath(alias, f.project) } });
  assert.equal(aliased.plan({ cwd: alias }).home, a.home);
});

test('the environment override selects an external home without changing personal config', t => {
  const f = fixture(t), config = join(f.personal, 'config.toml');
  writeFileSync(config, '# personal hooks and settings must be left alone\n');
  const h = new CodexHome({ env: { ...f.env, FRAMEWORK_CODEX_HOME: f.home } });
  const result = h.prepare({ cwd: f.project });
  assert.equal(result.home, canonicalCodexPath(f.home));
  assert.equal(result.auth, 'missing');
  assert.equal(readFileSync(config, 'utf8'), '# personal hooks and settings must be left alone\n');
  assert.deepEqual(readdirSync(f.project), []);
});

test('reject homes inside, above or equal to any writable root before disk writes', t => {
  const f = fixture(t);
  for (const homeDir of [f.project, join(f.project, '.codex'), f.base]) {
    const h = new CodexHome({ env: f.env, homeDir });
    assert.throws(() => h.prepare({ cwd: f.project }), /overlaps an agent-writable root/);
  }
  const extra = join(f.base, 'extra'); mkdirSync(extra);
  const h = new CodexHome({ env: f.env, homeDir: join(extra, 'new-home') });
  assert.throws(() => h.prepare({ cwd: f.project, writableRoots: [extra] }), /overlaps/);
  assert.deepEqual(readdirSync(extra), []);
  assert.throws(() => h.plan({ cwd: f.project, writableRoots: [''] }), /writableRoots/);
});

test('a nonexistent suffix behind a modelled junction cannot hide a writable project', t => {
  const f = fixture(t), alias = join(f.base, 'redirect');
  const h = new CodexHome({ env: f.env, homeDir: join(alias, 'not-yet-created', 'home'),
    pathAccess: { realpath: redirectedPath(alias, f.project),
      lstat: path => path === alias ? linkStat : lstatSync(path) } });
  assert.throws(() => h.prepare({ cwd: f.project }), /overlaps/);
  assert.deepEqual(readdirSync(f.project), []);
});

test('personal home overlap and relative home refuse without overwriting user files', t => {
  const f = fixture(t);
  writeFileSync(join(f.personal, 'config.toml'), 'personal=true\n');
  for (const homeDir of [f.personal, join(f.personal, 'child')]) {
    const h = new CodexHome({ env: f.env, homeDir });
    assert.throws(() => h.prepare({ cwd: f.project }), /personal Codex home/);
  }
  const relativeHome = new CodexHome({ env: f.env, homeDir: 'relative-home' });
  assert.throws(() => relativeHome.prepare({ cwd: f.project }), /absolute path/);
  assert.equal(readFileSync(join(f.personal, 'config.toml'), 'utf8'), 'personal=true\n');
});

test('the canonical personal home remains reserved behind a modelled directory alias', t => {
  const f = fixture(t), alias = join(f.base, 'personal-alias');
  writeFileSync(join(f.personal, 'config.toml'), 'personal=true\n');
  const home = new CodexHome({ env: { ...f.env, CODEX_HOME: alias }, homeDir: f.personal,
    pathAccess: { realpath: redirectedPath(alias, f.personal), lstat: path => path === alias ? linkStat : lstatSync(path) } });
  assert.throws(() => home.prepareExecution({ cwd: f.project }), /overlaps the personal Codex home/);
  assert.equal(readFileSync(join(f.personal, 'config.toml'), 'utf8'), 'personal=true\n');
  assert.equal(existsSync(join(f.personal, 'framework-owner.json')), false);
});

test('both personal homes stay reserved without filesystem inspection when CODEX_HOME is overridden', t => {
  const f = fixture(t), userHome = join(f.base, 'owner'), defaultPersonal = join(userHome, '.codex');
  for (const homeDir of [defaultPersonal, join(defaultPersonal, 'child'), f.personal]) {
    const h = new CodexHome({ env: f.env, userHome, homeDir, pathAccess: {
      realpath(path) {
        assert.ok(!path.startsWith(defaultPersonal) && !path.startsWith(f.personal), 'personal paths must not be inspected');
        return realpathSync.native(path);
      },
    } });
    assert.throws(() => h.prepare({ cwd: f.project, dryRun: true }), /personal Codex home/);
  }
  assert.equal(existsSync(userHome), false);
  assert.deepEqual(readdirSync(f.personal), []);
});

test('personal login is never copied and an independent owned login survives restores', t => {
  const f = fixture(t), source = join(f.personal, 'auth.json');
  writeFileSync(source, fakeLogin);
  const h = new CodexHome({ env: f.env, homeDir: f.home });
  const first = h.prepare({ cwd: f.project });
  assert.equal(first.auth, 'missing');
  assert.equal(existsSync(first.authFile), false);
  writeFileSync(first.authFile, '{"TEST_ONLY":"independent-login"}\n');
  writeFileSync(source, '{"TEST_ONLY":"updated-source-login"}\n');
  const second = h.prepare({ cwd: f.project });
  assert.equal(second.auth, 'existing');
  assert.deepEqual(second.restored, []);
  assert.equal(readFileSync(second.authFile, 'utf8'), '{"TEST_ONLY":"independent-login"}\n');
  assert.equal(readFileSync(source, 'utf8'), '{"TEST_ONLY":"updated-source-login"}\n');
});

test('API-key mode and even a legacy import request never copy personal login', t => {
  const f = fixture(t); writeFileSync(join(f.personal, 'auth.json'), fakeLogin);
  const api = new CodexHome({ env: { ...f.env, CODEX_API_KEY: 'TEST_ONLY_API_KEY' }, homeDir: f.home });
  const a = api.prepare({ cwd: f.project });
  assert.equal(a.auth, 'api-key'); assert.equal(existsSync(a.authFile), false);
  assert.doesNotMatch(JSON.stringify(a), /TEST_ONLY_API_KEY/);
  const noImport = new CodexHome({ env: f.env, homeDir: f.home });
  const b = noImport.prepare({ cwd: f.project, importAuth: true });
  assert.equal(b.auth, 'missing'); assert.equal(existsSync(b.authFile), false);
});

test('tampering with both the workspace source and external copy restores the pre-agent bytes', async t => {
  const f = fixture(t), core = join(f.project, 'core'); mkdirSync(core);
  const source = join(core, 'safety.mjs');
  const original = readFileSync(new URL('../../core/safety.mjs', import.meta.url));
  writeFileSync(source, original);
  const h = new CodexHome({ env: f.env, homeDir: f.home, safetySource: source });
  const first = h.prepare({ cwd: f.project });
  writeFileSync(source, 'export function destructiveReason() { return null; }\n');
  writeFileSync(first.safetyFile, 'export function destructiveReason() { return null; }\n');
  const second = h.prepare({ cwd: f.project });
  assert.deepEqual(second.restored, [first.safetyFile]);
  assert.deepEqual(readFileSync(second.safetyFile), original);
  assert.notDeepEqual(readFileSync(source), original);
  const restoredGuard = await import(pathToFileURL(second.safetyFile).href);
  assert.ok(restoredGuard.destructiveReason('git push --force owned-trap'));
  assert.equal(restoredGuard.destructiveReason('git push owned-trap feature'), null);
  unlinkSync(second.safetyFile);
  assert.deepEqual(h.prepare({ cwd: f.project }).restored, [first.safetyFile]);
});

test('a managed file reported as hardlinked refuses before replacing its content', t => {
  const f = fixture(t), other = join(f.base, 'other-owner.mjs');
  writeFileSync(other, 'OTHER_OWNER\n');
  let hardlinked = false;
  const managed = join(f.home, 'guard', 'safety.mjs');
  const h = new CodexHome({ env: f.env, homeDir: f.home, pathAccess: {
    lstat: path => { const stat = lstatSync(path); return hardlinked && path === managed
      ? { isFile: () => true, isSymbolicLink: () => false, nlink: 2 } : stat; },
  } });
  const initial = h.prepare({ cwd: f.project });
  writeFileSync(initial.safetyFile, 'OTHER_OWNER\n'); hardlinked = true;
  assert.throws(() => h.prepare({ cwd: f.project }), /regular, unlinked/);
  assert.equal(readFileSync(other, 'utf8'), 'OTHER_OWNER\n');
  assert.equal(readFileSync(managed, 'utf8'), 'OTHER_OWNER\n');
});

test('a modelled linked artifact directory refuses before touching either directory', t => {
  const f = fixture(t), other = join(f.base, 'other-guard'); mkdirSync(other);
  writeFileSync(join(other, 'safety.mjs'), 'OTHER_OWNER\n');
  let linked = false;
  const guard = join(f.home, 'guard');
  const h = new CodexHome({ env: f.env, homeDir: f.home, pathAccess: {
    lstat: path => linked && path === guard ? linkStat : lstatSync(path),
  } });
  h.prepare({ cwd: f.project });
  linked = true; writeFileSync(join(guard, 'safety.mjs'), 'PRESENT_CONTENT\n');
  assert.throws(() => h.prepare({ cwd: f.project }), /must not be a link/);
  assert.equal(readFileSync(join(other, 'safety.mjs'), 'utf8'), 'OTHER_OWNER\n');
  assert.equal(readFileSync(join(guard, 'safety.mjs'), 'utf8'), 'PRESENT_CONTENT\n');
});

test('one override cannot silently reuse another project home', t => {
  const f = fixture(t), other = join(f.base, 'other-project'); mkdirSync(other);
  new CodexHome({ env: f.env, homeDir: f.home }).prepare({ cwd: f.project });
  const before = readFileSync(join(f.home, 'framework-owner.json'));
  const h = new CodexHome({ env: f.env, homeDir: f.home });
  assert.throws(() => h.prepare({ cwd: other }), /different project/);
  assert.deepEqual(readFileSync(join(f.home, 'framework-owner.json')), before);
  assert.deepEqual(readdirSync(other), []);
});

test('a modelled redirection of a bound home to another directory refuses', t => {
  const f = fixture(t), elsewhere = join(f.base, 'elsewhere'); mkdirSync(elsewhere);
  let redirected = false;
  const h = new CodexHome({ env: f.env, homeDir: f.home, pathAccess: {
    realpath: path => redirected ? redirectedPath(f.home, elsewhere)(path) : realpathSync.native(path),
  } });
  h.prepare({ cwd: f.project });
  redirected = true;
  assert.throws(() => h.prepare({ cwd: f.project }), /changed after project binding/);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test('dry-run on a damaged installed home leaves detector, login and project unchanged', t => {
  const f = fixture(t); writeFileSync(join(f.personal, 'auth.json'), fakeLogin);
  const h = new CodexHome({ env: f.env, homeDir: f.home });
  const first = h.prepare({ cwd: f.project });
  writeFileSync(first.authFile, fakeLogin); // A fixture for an independent login, never an import.
  writeFileSync(first.safetyFile, 'DAMAGED_DETECTOR\n');
  const result = h.prepare({ cwd: f.project, dryRun: true });
  assert.deepEqual(result.restored, []); assert.equal(result.auth, 'existing');
  assert.equal(readFileSync(first.safetyFile, 'utf8'), 'DAMAGED_DETECTOR\n');
  assert.equal(readFileSync(first.authFile, 'utf8'), fakeLogin);
  assert.deepEqual(readdirSync(f.project), []);
});

test('failed detector restoration surfaces the error and leaves personal credentials untouched', t => {
  const f = fixture(t); writeFileSync(join(f.personal, 'auth.json'), fakeLogin);
  const h = new CodexHome({ env: f.env, homeDir: f.home });
  const first = h.prepare({ cwd: f.project, importAuth: false });
  unlinkSync(first.safetyFile); mkdirSync(first.safetyFile);
  assert.throws(() => h.prepare({ cwd: f.project }), /regular, unlinked/);
  assert.equal(existsSync(first.authFile), false);
  assert.equal(readFileSync(join(f.personal, 'auth.json'), 'utf8'), fakeLogin);
});

test('a damaged project owner marker fails closed before restoring other files', t => {
  const f = fixture(t), h = new CodexHome({ env: f.env, homeDir: f.home });
  const first = h.prepare({ cwd: f.project });
  writeFileSync(first.ownerFile, 'CORRUPT_OWNER\n');
  writeFileSync(first.safetyFile, 'UNCHANGED_AFTER_REFUSAL\n');
  assert.throws(() => h.prepare({ cwd: f.project }), /damaged owner marker/);
  assert.equal(readFileSync(first.safetyFile, 'utf8'), 'UNCHANGED_AFTER_REFUSAL\n');
});

test('a modelled dangling link refuses instead of treating the path as uncreated', t => {
  const f = fixture(t), dangling = join(f.base, 'dangling');
  assert.throws(() => canonicalCodexPath(dangling, {
    lstat: path => path === dangling ? linkStat : lstatSync(path),
  }), /Dangling Codex path link/);
  assert.equal(existsSync(dangling), false);
});

test('Windows and XDG state roots select platform locations without creating them', t => {
  const f = fixture(t), local = join(f.base, 'local-appdata'), xdg = join(f.base, 'xdg-state');
  const win = new CodexHome({ env: { ...f.env, LOCALAPPDATA: local }, platform: 'win32' });
  const linux = new CodexHome({ env: { ...f.env, XDG_STATE_HOME: xdg }, platform: 'linux' });
  assert.ok(win.plan({ cwd: f.project }).home.startsWith(join(local, '0-code', 'codex')));
  assert.ok(linux.plan({ cwd: f.project }).home.startsWith(join(xdg, '0-code', 'codex')));
  assert.equal(existsSync(local), false); assert.equal(existsSync(xdg), false);
});
