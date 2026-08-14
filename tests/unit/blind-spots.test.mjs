import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// BLIND SPOT tests (v1.4.0). Each one targets a specific defect that slipped past the existing
// tests and past 80% coverage, and was only found by a live check. These test CLASSES of defects
// rather than individual cases.

// Class 1: a script references a file that does not exist.
// A real case: provision-toolset.sh delegated to a tools/ script that had been deleted an hour
// earlier. Neither the tests nor smoke noticed — nobody ran the script.
test('blind spot: every file referenced by a script exists', () => {
  const scripts = ['bootstrap.sh', 'provision-toolset.sh', 'tests/smoke.sh'];
  const broken = [];
  for (const s of scripts) {
    const path = join(ROOT, s);
    if (!existsSync(path)) { broken.push(`${s} (the script itself is missing)`); continue; }
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(/(?:tools|lib|core|hooks)\/[\w.\-\/]+\.mjs/g)) {
      if (!existsSync(join(ROOT, m[0]))) broken.push(`${s} → ${m[0]}`);
    }
  }
  assert.deepEqual(broken, [], 'a script references a file that does not exist');
});

// Class 2: a documentation claim diverges from the behaviour.
// A real case: the README promised that bootstrap copies templates/ — it does not.
test('blind spot: the README does not promise copying that bootstrap never performs', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const bootstrap = readFileSync(join(ROOT, 'bootstrap.sh'), 'utf8');
  const block = readme.slice(readme.indexOf('Bootstrap:'), readme.indexOf('Bootstrap:') + 700);
  for (const m of block.matchAll(/`([\w.\-]+)\/`/g)) {
    const directory = m[1];
    if (directory === 'templates') {
      assert.ok(/NOT copied/.test(block),
        'if templates/ is mentioned, the README must explain that it is NOT copied');
    }
  }
  // core/ is mandatory: without it both hooks failed silently (a real v1.2.0 defect)
  assert.match(bootstrap, /core/, 'bootstrap must copy core/');
});

// Class 3: a method reports success having done nothing.
// A real case: one backend's applyPermissions returned applied:true although no mechanism existed.
test('blind spot: applyPermissions reports honestly', async () => {
  const { OpenCodeBackend } = await import('../../core/backends/opencode.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const d = mkdtempSync(join(tmpdir(), 'blind-'));
  try {
    const r = await new OpenCodeBackend().applyPermissions({
      policy: { allow: [], deny: ['Bash(rm -rf /)'] }, targetDir: d,
    });
    assert.equal(r.applied, true);
    assert.ok(existsSync(r.file), 'the reported file must exist on disk');
    const cfg = JSON.parse(readFileSync(r.file, 'utf8'));
    assert.ok(Object.values(cfg.permission.bash).includes('deny'),
      'a report of applied:true must be backed by real denials in the file');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Class 4: a notification silently fails to send, and its absence must not break the loop.
// A real case: the v1.3.0 blocker never reached the user — the Telegram variables were unset.
// The audit refined the picture: without tokens the script itself exits with code 1 (which is
// correct — it states the reason), while the loop stays safe because the CALLERS check the
// variables BEFORE calling. We assert both ends of the invariant.
test('blind spot: without tokens the script states the reason and the loop keeps working', () => {
  const r = spawnSync('bash', [join(ROOT, 'lib', 'telegram-notify.sh'), 'subject', 'body'],
    { encoding: 'utf8', timeout: 15000, env: { ...process.env, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' } });
  assert.notEqual(r.status, 0, 'silent success without tokens is unacceptable');
  assert.match(String(r.stderr || r.stdout || ''), /TELEGRAM_BOT_TOKEN/, 'the reason must be stated');

  // Callers must guard the call with a variable check — otherwise exit code 1 reaches the loop.
  for (const file of ['hooks/ralph-loop-stop.mjs', 'core/supervisor.mjs']) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const i = text.indexOf('telegram-notify.sh');
    assert.ok(i > 0, `${file} must reference the notification sender`);
    const window = text.slice(i, i + 260);
    assert.match(window, /TELEGRAM_BOT_TOKEN[\s\S]*TELEGRAM_CHAT_ID/,
      `${file}: the call must be guarded by a variable check`);
  }
});

// Class 5: a default was chosen without justification.
// A real case: max_iterations=1000 in a fresh project turned an accidental run into a thousand
// iterations.
test('blind spot: the starting iteration limit is sensible', () => {
  const bootstrap = readFileSync(join(ROOT, 'bootstrap.sh'), 'utf8');
  const m = bootstrap.match(/^max_iterations:\s*(\d+)/m);
  assert.ok(m, 'bootstrap must set a starting limit');
  assert.ok(Number(m[1]) <= 50, `a starting limit of ${m[1]} is too high for an accidental run`);
});

// Class 6: a document header falls behind reality.
// A real case (the v1.5.0 audit): the README declared version 1.0.0 and GUIDELINE declared 0.4.0
// while the framework had reached 1.4.0. Such a claim goes stale silently because nobody checks it
// — exactly the class of defect the claims audit exists for.
test('blind spot: the versions in document headers match plugin.json', () => {
  const { version } = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const majorMinor = version.split('.').slice(0, 2).join('.');   // compare down to the minor version

  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8').slice(0, 400);
  const mReadme = readme.match(/\*\*Version:\*\*\s*v?([\d.]+)/);
  assert.ok(mReadme, 'the README header must carry a version');
  assert.ok(mReadme[1].startsWith(majorMinor),
    `the README declares ${mReadme[1]} while the framework is at ${version}`);

  const guide = readFileSync(join(ROOT, 'GUIDELINE.md'), 'utf8').slice(0, 600);
  const mGuide = guide.match(/\*\*Framework version:\*\*\s*v?([\d.]+)/);
  assert.ok(mGuide, 'the GUIDELINE header must carry a version');
  assert.ok(mGuide[1].startsWith(majorMinor),
    `GUIDELINE declares ${mGuide[1]} while the framework is at ${version}`);
});
