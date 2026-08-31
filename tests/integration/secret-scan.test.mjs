// tests/integration/secret-scan.test.mjs — the half of the sanitisation gate that only git can
// answer: which files could actually reach a commit.
//
// This replaces a v1.7.1 acceptance test that ran the whole 40-second smoke suite to assert one
// thing. The claim is not weakened by narrowing it — it is split into both of its directions and
// each is proven in isolation, which the coarse end-to-end run never did:
//   - a live config/.env must NOT make the gate fire (the defect this stage fixes);
//   - a secret in a file git WOULD stage must still fire it (the direction that must not be lost
//     while fixing the first).
// Whether the suite as a whole is green stays where it belongs: the release gate runs smoke.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scannableFiles, scanPaths } from '../../lib/secret-scan.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const TOKEN = 'ghp_' + 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8';

function mkRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

test('scan: this repository stages nothing carrying a credential', () => {
  const findings = scanPaths(ROOT, ['toolset', 'config']);
  assert.notEqual(findings, null, 'the repository should be a git work tree');
  assert.deepEqual(
    findings.map(f => `${f.file}:${f.line} ${f.pattern}`), [],
    'a credential is sitting in a file git would commit',
  );
});

test('scan: a live config/.env is out of reach because git would not stage it', () => {
  const files = scannableFiles(ROOT, ['config']);
  assert.notEqual(files, null);
  assert.ok(files.length > 0, 'config/ should contribute scannable files');
  assert.ok(
    !files.includes('config/.env'),
    'config/.env is scannable — the gate would report live values on every working machine',
  );
  // The file exists and is excluded by the ignore policy, not by a special case in the scanner.
  if (existsSync(join(ROOT, 'config', '.env'))) {
    const r = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', 'config/.env'], { cwd: ROOT });
    assert.equal(r.status, 0, 'config/.env is present but not ignored');
  }
});

test('scan: a secret in a TRACKED file is reported, the same secret in an IGNORED file is not', () => {
  const dir = mkRepo();
  try {
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, '.gitignore'), '.env\n');
    writeFileSync(join(dir, 'config', '.env'), `GITHUB_TOKEN=${TOKEN}\n`);
    writeFileSync(join(dir, 'config', 'settings.json'), `{"token":"${TOKEN}"}\n`);
    spawnSync('git', ['add', '-A'], { cwd: dir });

    const findings = scanPaths(dir, []);
    assert.deepEqual(findings.map(f => f.file), ['config/settings.json']);
    assert.equal(findings[0].pattern, 'GitHub token');
    assert.equal(findings[0].line, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scan: an untracked file that no rule ignores is still scanned', () => {
  const dir = mkRepo();
  try {
    // Never added to the index and not ignored: exactly what one `git add .` would sweep up.
    writeFileSync(join(dir, 'notes.txt'), `key=${TOKEN}\n`);
    const findings = scanPaths(dir, []);
    assert.deepEqual(findings.map(f => f.file), ['notes.txt']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scan: outside a git work tree the answer is null, not "clean"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-scan-bare-'));
  try {
    writeFileSync(join(dir, 'leak.txt'), `key=${TOKEN}\n`);
    assert.equal(scannableFiles(dir, []), null);
    assert.equal(
      scanPaths(dir, []), null,
      'returning [] here would let the gate report a pass it never performed',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scan: a binary file is skipped rather than producing noise', () => {
  const dir = mkRepo();
  try {
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    writeFileSync(join(dir, 'plain.txt'), 'nothing here\n');
    assert.deepEqual(scanPaths(dir, []), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
