import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { lockCohort } from '../helpers/loop-lock-cohort.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
import { acquireLock, readLock, lockPath, LOCK_TTL_MS } from '../../core/loop-lock.mjs';
import { holdWindowsReadLock } from '../helpers/windows-file-lock.mjs';

const moduleUrl = new URL('../../core/loop-lock.mjs', import.meta.url).href;
test('a temporary Windows reader does not prevent publishing the next loop owner',{skip:process.platform!=='win32'},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lock-reader-'));let reader;
  try {
    mkdirSync(join(dir,'docs'));writeFileSync(lockPath(dir),JSON.stringify({pid:999999999,host:hostname(),engine:'supervisor'}));
    reader=await holdWindowsReadLock(lockPath(dir));
    const result=acquireLock({projectDir:dir});assert.equal(result.acquired,true);assert.equal(readLock(dir).pid,process.pid);
    assert.equal(await reader.closed,0);
  } finally {reader?.release();if(reader)await reader.closed;await cleanupTempDir(dir);}
});
for (const initial of ['free', 'dead', 'stale']) {
  test(`16 living processes get one owner when the initial lock is ${initial}`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'lock-cohort-'));
    try {
      mkdirSync(join(dir, 'docs'));
      if (initial !== 'free') writeFileSync(lockPath(dir), JSON.stringify({
        pid: initial === 'dead' ? 999999999 : process.pid, host: hostname(), engine: 'supervisor',
        ...(initial === 'stale' ? { liveness: { kind: 'heartbeat', id: 'old-session' } } : {}),
        heartbeatAt: new Date(Date.now() - (initial === 'stale' ? LOCK_TTL_MS + 1000 : 0)).toISOString(),
      }));
      const result = await lockCohort(dir, moduleUrl);
      t.diagnostic(`16 contenders: ready in ${result.startupMs} ms, measured in ${result.elapsedMs} ms`);
      assert.equal(result.allAlive, true, 'all contenders must remain alive until every result is measured');
      assert.equal(result.acquired, 1, JSON.stringify(result.rows));
      assert.equal(readLock(dir).pid, result.rows.find(row => row.acquired).pid);
      assert.ok(result.rows.filter(row => !row.acquired).every(row => row.state === 'busy' || row.state === 'alive'));
      if (initial === 'dead') assert.equal(result.observed, 1, 'only the mutex holder examines the obsolete owner');
    } finally { await cleanupTempDir(dir); }
  });
}
test('cohort retains stderr and exits between readiness and the claim instead of losing the failure',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lock-failure-'));
  try {
    await assert.rejects(lockCohort(dir,moduleUrl,{count:16,workerSource:
      `process.stderr.write('fixture worker startup failed');process.send({type:'ready'});process.exit(7);`}),
      /Worker .*exited: 7\/null; stderr=fixture worker startup failed/);
  } finally {await cleanupTempDir(dir);}
});
