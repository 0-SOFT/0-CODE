import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {runInNewContext} from 'node:vm';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {retryWindowsFileOperation} from '../../lib/replace-file.mjs';
import {cleanupTempDir} from '../helpers/index.mjs';
function cleanup(rmdirSync=fs.rmdirSync) {
  const url=new URL('../helpers/index.mjs',import.meta.url);
  const source=fs.readFileSync(url,'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')
    .replaceAll('import.meta.url',JSON.stringify(url.href));
  return runInNewContext(source+'\ncleanupTempDir;',{
    ...fs,rmdirSync,rm:async()=>{throw Object.assign(new Error('fixture stale recursive directory'),{code:'ENOTEMPTY'});},
    tmpdir,join,resolve,relative,isAbsolute,sep,fileURLToPath,URL,retryWindowsFileOperation,
    process:{platform:'win32',env:process.env},
  });
}
test('a stale recursive removal falls back to actual postorder deletion inside temporary roots',async()=>{
  const root=fs.mkdtempSync(join(process.env.FRAMEWORK_TEST_TMPDIR||tmpdir(),'cleanup-order-'));
  fs.mkdirSync(join(root,'.git','nested'),{recursive:true});
  fs.writeFileSync(join(root,'.git','nested','file'),'owned bytes');fs.writeFileSync(join(root,'.gitignore'),'owned rules');
  await cleanup()(root);assert.equal(fs.existsSync(root),false);
});
test('a persistent directory refusal stays visible and an outside root is refused before deletion',async()=>{
  const root=fs.mkdtempSync(join(process.env.FRAMEWORK_TEST_TMPDIR||tmpdir(),'cleanup-denied-'));
  try {
    await assert.rejects(cleanup(()=>{throw Object.assign(new Error('fixture denied directory'),{code:'EACCES'});})(root),/fixture denied directory/);
    assert.equal(fs.existsSync(root),true);
    await assert.rejects(cleanup()(resolve(tmpdir(),'..')),/outside the test temporary roots/);
  } finally {await cleanupTempDir(root);}
});
