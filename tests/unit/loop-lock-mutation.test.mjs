import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { acquireLock, refreshLock, releaseLock, readLock, lockPath } from '../../core/loop-lock.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
import { DOCUMENT_DEFAULTS, loadProjectConfig } from '../../core/project-config.mjs';
import { replaceFileSync, retryWindowsFileOperation } from '../../lib/replace-file.mjs';

// Real filesystem operations with one scheduler-controlled pause point. This forces the exact
// stale-cleanup and ownership-update interleavings instead of hoping a timing race reappears.
function scheduledLock(overrides) {
  const source = fs.readFileSync(new URL('../../core/loop-lock.mjs', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
  return vm.runInNewContext(source + '\n({acquireLock,refreshLock,releaseLock,releaseLockEventually})', {
    ...fs, ...overrides, join, dirname, hostname, randomUUID, process, DOCUMENT_DEFAULTS, loadProjectConfig, replaceFileSync,retryWindowsFileOperation,
  }, { filename: 'loop-lock-interleaving-fixture.mjs' });
}
test('an unreadable living-owner lock cannot be treated as free and overwritten',async()=>{
  const dir=fs.mkdtempSync(join(tmpdir(),'lock-unreadable-'));
  try {
    assert.equal(acquireLock({projectDir:dir}).acquired,true);
    const before=fs.readFileSync(lockPath(dir));
    const scheduled=scheduledLock({readFileSync(file,options){
      if(file===lockPath(dir)&&options==='utf8')throw Object.assign(new Error('fixture denied read'),{code:'EACCES'});
      return fs.readFileSync(file,options);
    }});
    assert.throws(()=>scheduled.acquireLock({projectDir:dir,pid:123456}),/fixture denied read/);
    assert.deepEqual(fs.readFileSync(lockPath(dir)),before);
    assert.equal(releaseLock({projectDir:dir}),true,'the failed reader must release its mutation mutex');
  } finally {await cleanupTempDir(dir);}
});
test('a short Windows lock-read refusal recovers without taking a live owner', {skip:process.platform!=='win32'},async()=>{
  const dir=fs.mkdtempSync(join(tmpdir(),'lock-read-retry-'));
  try {
    assert.equal(acquireLock({projectDir:dir}).acquired,true);let calls=0;
    const scheduled=scheduledLock({readFileSync(file,options){
      if(file===lockPath(dir)&&options==='utf8'&&calls++===0)throw Object.assign(new Error('fixture brief reader'),{code:'EACCES'});
      return fs.readFileSync(file,options);
    }});
    assert.equal(scheduled.acquireLock({projectDir:dir,pid:123456}).acquired,false);
    assert.equal(readLock(dir).pid,process.pid);assert.ok(calls>=2);
  } finally {await cleanupTempDir(dir);}
});

function marker(dir, name, pid) {
  const guard = lockPath(dir) + '.guard'; fs.mkdirSync(guard);
  const file = join(guard, name);
  fs.writeFileSync(file, JSON.stringify({ host: hostname(), pid }));
  return { guard, file };
}

for (const replacementPoint of ['before-unlink', 'after-unlink']) {
  test(`reclaiming a dead marker preserves a new live mutex published ${replacementPoint}`, async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'lock-mutation-'));
    const oldName = 'owner-11111111-1111-4111-8111-111111111111.json';
    const newName = 'owner-22222222-2222-4222-8222-222222222222.json';
    try {
      fs.mkdirSync(join(dir, 'docs'));
      const old = marker(dir, oldName, 999999999);
      let replaced = false;
      const scheduled = scheduledLock({ unlinkSync(file) {
        if (file !== old.file || replaced) return fs.unlinkSync(file);
        replaced = true;
        fs.unlinkSync(old.file); fs.rmdirSync(old.guard);
        marker(dir, newName, process.pid);
        if (replacementPoint === 'before-unlink') return fs.unlinkSync(old.file);
      } });
      const result = scheduled.acquireLock({ projectDir: dir });
      assert.equal(replaced, true);
      assert.equal(result.acquired, false);
      assert.deepEqual(fs.readdirSync(old.guard), [newName], 'stale cleanup must not delete the new mutex');
      assert.equal(readLock(dir), null);
    } finally { await cleanupTempDir(dir); }
  });
}

test('a concurrent release cannot delete the lock during an owning heartbeat update', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'lock-mutation-'));
  try {
    assert.equal(acquireLock({ projectDir: dir }).acquired, true);
    let collided = false;
    const scheduled = scheduledLock({ readFileSync(file, options) {
      const value = fs.readFileSync(file, options);
      if (file === lockPath(dir) && !collided) {
        collided = true;
        assert.equal(releaseLock({ projectDir: dir }), false, 'the competing release must not enter the held mutex');
      }
      return value;
    } });
    const now = Date.now() + 1000;
    assert.equal(scheduled.refreshLock({ projectDir: dir, now }), true);
    assert.equal(collided, true);
    assert.equal(readLock(dir).heartbeatAt, new Date(now).toISOString());
    assert.equal(releaseLock({ projectDir: dir }), true, 'release succeeds after the critical section ends');
  } finally { await cleanupTempDir(dir); }
});

test('normal release retries a transient unlink refusal while the synchronous handler stays boolean', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'lock-release-'));
  try {
    acquireLock({ projectDir: dir });
    let refused = true, waits = 0;
    const scheduled = scheduledLock({ unlinkSync(file) {
      if (file === lockPath(dir) && refused) { refused = false; throw Object.assign(new Error('brief file lock'), { code: 'EPERM' }); }
      return fs.unlinkSync(file);
    } });
    assert.equal(scheduled.releaseLock({ projectDir: dir }), false);
    assert.equal(readLock(dir).pid, process.pid);
    refused = true;
    assert.equal(await scheduled.releaseLockEventually({ projectDir: dir }, { wait: async () => { waits++; } }), true);
    assert.equal(waits, 1); assert.equal(readLock(dir), null);
  } finally { await cleanupTempDir(dir); }
});

test('a release retry rechecks ownership and preserves a replacement owner', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'lock-release-'));
  try {
    acquireLock({ projectDir: dir });
    const held = marker(dir, 'owner-33333333-3333-4333-8333-333333333333.json', process.pid);
    let waits = 0;
    const scheduled = scheduledLock({});
    assert.equal(await scheduled.releaseLockEventually({ projectDir: dir }, { wait: async () => {
      waits++; fs.unlinkSync(held.file); fs.rmdirSync(held.guard);
      const foreign = readLock(dir); foreign.pid = 999999999; foreign.liveness = { kind: 'process', id: '999999999' };
      fs.writeFileSync(lockPath(dir), JSON.stringify(foreign));
    } }), false);
    assert.equal(waits, 1); assert.equal(readLock(dir).pid, 999999999);
  } finally { await cleanupTempDir(dir); }
});

test('persistent unlink refusal exhausts only the configured release attempts and retains the owner', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'lock-release-'));
  try {
    acquireLock({ projectDir: dir }); let calls = 0, waits = 0;
    const scheduled = scheduledLock({ unlinkSync(file) {
      if (file === lockPath(dir)) { calls++; throw Object.assign(new Error('persistent file lock'), { code: 'EPERM' }); }
      return fs.unlinkSync(file);
    } });
    assert.equal(await scheduled.releaseLockEventually({ projectDir: dir }, { attempts: 3, wait: async () => { waits++; } }), 'busy');
    // A transient mutation contention can consume an attempt before unlink is reached.
    assert.ok(calls>0&&calls<=3); assert.equal(waits, 2); assert.equal(readLock(dir).pid, process.pid);
  } finally { await cleanupTempDir(dir); }
});

test('a concurrent acquisition cannot be overwritten or deleted by the releasing owner', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'lock-mutation-'));
  try {
    acquireLock({ projectDir: dir });
    let collided = false;
    const scheduled = scheduledLock({ readFileSync(file, options) {
      const value = fs.readFileSync(file, options);
      if (file === lockPath(dir) && !collided) {
        collided = true;
        assert.equal(acquireLock({ projectDir: dir, pid: 123456 }).acquired, false);
      }
      return value;
    } });
    assert.equal(scheduled.releaseLock({ projectDir: dir }), true);
    assert.equal(collided, true);
    assert.equal(acquireLock({ projectDir: dir, pid: 123456 }).acquired, true);
    assert.equal(refreshLock({ projectDir: dir }), false, 'the former owner cannot overwrite the replacement');
    assert.equal(readLock(dir).pid, 123456);
  } finally { await cleanupTempDir(dir); }
});
