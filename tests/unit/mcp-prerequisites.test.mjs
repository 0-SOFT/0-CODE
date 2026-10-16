import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectMcpPrerequisites, compareSemVer } from '../../core/mcp-prerequisites.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
const repo=fileURLToPath(new URL('../../',import.meta.url)),base=join(dirname(repo.replace(/[\\/]$/,'')),'scratch/tmp');mkdirSync(base,{recursive:true});
function fixture(t) {
  const root=mkdtempSync(join(base,'mcp-prerequisite-'));t.after(()=>cleanupTempDir(root));
  const put=(path,text)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),text);};
  const env={NPM_GLOBAL_ROOT:join(root,'node_modules')};
  const server={name:'fixture',npm_package:'@fixture/server@1.2.3',args:['${NPM_GLOBAL_ROOT}/@fixture/server/index.js']};
  const delivery={tools:[{id:'mcp/fixture',kind:'mcp',origin:'framework',engine:'claude',status:'delivered'},
    {id:'mcp/fixture',kind:'mcp',origin:'framework',engine:'codex',status:'delivered'}]};
  const manifest=servers=>put('.0-code/config/mcp-manifest.json',JSON.stringify({servers}));
  return {root,put,env,server,delivery,manifest,inspect:()=>inspectMcpPrerequisites(root,delivery,{env})};
}
test('doctor proves pinned package and entry; missing or wrong versions cannot appear green',t=>{
  const f=fixture(t);assert.deepEqual(inspectMcpPrerequisites(f.root,{tools:[]}),[]);
  assert.equal(f.inspect()[0].ok,false);f.manifest([f.server]);assert.match(f.inspect()[0].reason,/Missing prerequisite/);
  f.put('node_modules/@fixture/server/package.json',JSON.stringify({name:'@fixture/server',version:'9.9.9'}));
  assert.match(f.inspect()[0].reason,/entry is absent/);
  f.put('node_modules/@fixture/server/package.json',JSON.stringify({name:'@fixture/server',version:'1.2.3'}));
  assert.match(f.inspect()[0].reason,/entry is absent/);f.put('node_modules/@fixture/server/index.js','// executable fixture\n');
  assert.equal(f.inspect().length,1);assert.equal(f.inspect()[0].ok,true);
});
test('SemVer minimum preserves newer dependency bytes and rejects invalid or older evidence',t=>{
  const f=fixture(t);f.manifest([f.server]);f.put('node_modules/@fixture/server/index.js','// owner entry\n');
  for(const [version,ok] of [['1.2.3',true],['1.2.3+build.9',true],['1.10.0',true],['2.0.0-beta.1',true],
    ['1.2.2',false],['1.2.3-beta.1',false],['01.2.3',false],['1.2.3-01',false],['broken',false]]) {
    f.put('node_modules/@fixture/server/package.json',JSON.stringify({name:'@fixture/server',version}));
    const path=join(f.root,'node_modules/@fixture/server/package.json'),before=readFileSync(path);
    assert.equal(f.inspect()[0].ok,ok,version);assert.deepEqual(readFileSync(path),before);
    assert.equal(readFileSync(join(f.root,'node_modules/@fixture/server/index.js'),'utf8'),'// owner entry\n');
  }
  f.put('node_modules/@fixture/server/package.json',JSON.stringify({name:'@fixture/wrong',version:'9.9.9'}));
  assert.match(f.inspect()[0].reason,/package name/);
});
test('SemVer numeric, prerelease and metadata precedence follows the complete ordering',()=>{
  const versions=['1.0.0-alpha','1.0.0-alpha.1','1.0.0-alpha.beta','1.0.0-beta','1.0.0-beta.2','1.0.0-beta.11','1.0.0-rc.1','1.0.0','1.0.9','1.0.10'];
  for(let i=1;i<versions.length;i++) {
    assert.equal(compareSemVer(versions[i-1],versions[i]),-1);
    assert.equal(compareSemVer(versions[i],versions[i-1]),1);
  }
  assert.equal(compareSemVer('1.2.3+one','1.2.3+two'),0);
  assert.equal(compareSemVer('1.2.3-a','1.2.3-a'),0);
  for(const invalid of [null,'1.2','1.2.3+','1.2.3-a..b','1.02.3','1.2.3-01'])assert.equal(compareSemVer(invalid,'1.2.3'),null);
});
test('optional credentials remain private and package pins/entry boundaries are validated',t=>{
  const f=fixture(t);f.manifest([{name:'fixture',secrets:['FIXTURE_KEY'],type:'http'}]);
  assert.match(f.inspect()[0].reason,/FIXTURE_KEY/);f.env.FIXTURE_KEY='fixture-value-never-in-output';
  const good=f.inspect();assert.equal(good[0].ok,true);assert.ok(!JSON.stringify(good).includes(f.env.FIXTURE_KEY));
  f.manifest([]);assert.match(f.inspect()[0].reason,/definition is absent/);
  f.manifest([{...f.server,npm_package:'@fixture/server@latest'}]);assert.match(f.inspect()[0].reason,/exact version/);
  f.manifest([{...f.server,args:[]}]);f.put('node_modules/@fixture/server/package.json',JSON.stringify({name:'@fixture/server',version:'1.2.3'}));
  assert.match(f.inspect()[0].reason,/not declared/);
  f.manifest([{...f.server,args:['${NPM_GLOBAL_ROOT}/@fixture/server/../../owner.js']}]);f.put('node_modules/owner.js','// owner');
  assert.match(f.inspect()[0].reason,/outside its package/);
});
test('absent npm executable reports a missing local prerequisite without installing anything',t=>{
  const f=fixture(t);f.manifest([f.server]);
  const result=inspectMcpPrerequisites(f.root,f.delivery,{env:{PATH:'',Path:'',SystemRoot:process.env.SystemRoot}});
  assert.equal(result[0].ok,false);assert.match(result[0].reason,/npm global root is unavailable/);
});
