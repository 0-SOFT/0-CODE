import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { runCliAsync, setChildRegistryFile, liveChildCount } from '../../core/backends/spawn-cli.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';

test('a real Windows child survives the CIM response and exits with complete output',
  { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'child-liveness-'));
    const registry = join(root, 'children.json');
    t.after(async () => { setChildRegistryFile(null); await cleanupTempDir(root); });
    setChildRegistryFile(registry);
    // The child completes only after the launcher's actual asynchronous identity callback
    // has persisted its birth evidence. A fixed sleep would not prove CIM had answered.
    const script = `
      const { readFileSync } = require('node:fs');
      process.stdout.write('start\\n');
      const deadline = setTimeout(() => {
        process.stderr.write('CIM identity was never bound\\n'); process.exit(2);
      }, 30000);
      const poll = setInterval(() => {
        let entry;
        try { entry = JSON.parse(readFileSync(process.argv[1], 'utf8')).children
          .find(record => record.pid === process.pid); }
        catch (error) {
          if (error.code === 'ENOENT' || error instanceof SyntaxError) return;
          throw error;
        }
        if (!entry?.identity) return;
        clearInterval(poll); clearTimeout(deadline);
        process.stdout.write('CIM-bound\\nend\\n');
        process.stderr.write('complete\\n');
      }, 25);
    `;
    const result = await runCliAsync(process.execPath, ['-e', script, registry], { timeoutMs: 45000 });
    t.diagnostic(JSON.stringify({ node: process.version, executable: process.execPath,
      status: result.status, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr }));
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout, 'start\nCIM-bound\nend\n');
    assert.equal(result.stderr, 'complete\n');
    assert.equal(liveChildCount(), 0);
  });

test('Windows abort after CIM binding stops the real child tree and preserves an unrelated process',
  { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'child-tree-'));
    const bystander = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'],
      { stdio: 'ignore', windowsHide: true });
    const bystanderClosed = new Promise(resolve => bystander.once('close', resolve));
    t.after(async () => {
      bystander.kill('SIGKILL'); await bystanderClosed;
      setChildRegistryFile(null); await cleanupTempDir(root);
    });
    await new Promise((resolve, reject) => { bystander.once('spawn', resolve); bystander.once('error', reject); });
    const registry = join(root, 'children.json');
    setChildRegistryFile(registry);
    const script = `
      const { readFileSync } = require('node:fs');
      const deadline = setTimeout(() => process.exit(2), 30000);
      const poll = setInterval(() => {
        let entry;
        try { entry = JSON.parse(readFileSync(process.argv[1], 'utf8')).children
          .find(record => record.pid === process.pid); }
        catch (error) { if(error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error; }
        if(!entry?.identity) return;
        clearInterval(poll); clearTimeout(deadline);
        const worker = require('node:child_process').spawn(process.execPath,
          ['-e','setTimeout(()=>{},60000)'], {stdio:'ignore',windowsHide:true});
        worker.once('spawn', () => process.stdout.write('tree:' + worker.pid + '\\n'));
      }, 25);
    `;
    let output = '', descendant;
    const result = await runCliAsync(process.execPath, ['-e', script, registry], {
      timeoutMs: 45000, onChunk(chunk) {
        output += chunk;
        const match = /tree:(\d+)\n/.exec(output);
        if (match) { descendant = Number(match[1]); return 'abort'; }
      },
    });
    assert.equal(result.aborted, true, JSON.stringify(result));
    assert.equal(result.timedOut, false);
    assert.notEqual(result.cleanupRefused, true);
    const alive = pid => { try { process.kill(pid, 0); return true; } catch(error) {
      if(error.code === 'ESRCH') return false; throw error;
    } };
    const deadline = Date.now() + 5000;
    while ((alive(result.pid) || alive(descendant)) && Date.now() < deadline) await delay(25);
    assert.equal(alive(result.pid), false, 'the owned leader must stop');
    assert.equal(alive(descendant), false, 'the owned descendant must stop');
    assert.equal(bystander.exitCode, null); assert.equal(bystander.signalCode, null);
    assert.equal(alive(bystander.pid), true, 'the unrelated process must survive');
    assert.equal(liveChildCount(), 0);
  });
