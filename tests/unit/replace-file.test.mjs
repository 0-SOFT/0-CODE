import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { replaceFileSync } from '../../lib/replace-file.mjs';
import { holdWindowsReadLock } from '../helpers/windows-file-lock.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';

function files(t) {
  const root = mkdtempSync(join(tmpdir(), 'replace-file-'));
  t.after(() => cleanupTempDir(root));
  const staging = join(root, 'new.txt'), destination = join(root, 'old.txt');
  writeFileSync(staging, 'new complete text'); writeFileSync(destination, 'old complete text');
  return { staging, destination };
}

test('ordinary replacement publishes complete bytes and consumes the staged file', t => {
  const f = files(t);
  replaceFileSync(f.staging, f.destination);
  assert.equal(readFileSync(f.destination, 'utf8'), 'new complete text');
  assert.equal(existsSync(f.staging), false);
});

test('validation failure and a missing source preserve the destination', t => {
  const f = files(t), denied = new Error('path is no longer owned'); denied.code = 'EPERM';
  assert.throws(() => replaceFileSync(f.staging, f.destination, { validate: () => { throw denied; } }), e => e === denied);
  assert.throws(() => replaceFileSync(f.staging + '.missing', f.destination), { code: 'ENOENT' });
  assert.equal(readFileSync(f.destination, 'utf8'), 'old complete text');
  assert.equal(readFileSync(f.staging, 'utf8'), 'new complete text');
  assert.throws(() => replaceFileSync(f.staging, f.destination, { timeoutMs: Infinity }), /timeout/);
});

test('a persistent real Windows lock refuses within its bound and preserves both files',
  { skip: process.platform !== 'win32' }, async t => {
    const f = files(t), reader = await holdWindowsReadLock(f.destination, 0);
    try {
      assert.throws(() => replaceFileSync(f.staging, f.destination, { timeoutMs: 50 }), e => ['EPERM','EACCES','EBUSY'].includes(e.code));
      assert.equal(readFileSync(f.destination, 'utf8'), 'old complete text');
      assert.equal(readFileSync(f.staging, 'utf8'), 'new complete text');
    } finally { reader.release(); assert.equal(await reader.closed, 0); }
  });
