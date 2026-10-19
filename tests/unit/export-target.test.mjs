import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync,rmSync,lstatSync,realpathSync,statSync,copyFileSync,symlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join,relative,isAbsolute,resolve,basename,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {cleanupTempDir} from '../helpers/index.mjs';

// The developer-only export tool is omitted from the public tree deliberately.
const TOOL=join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))),'tools','export-public.mjs');
const skip=existsSync(TOOL)?false:'the export tool is not part of the published tree';
const testRoot=process.env.FRAMEWORK_TEST_TMPDIR||tmpdir();
const hash=file=>existsSync(file)?createHash('sha256').update(readFileSync(file)).digest('hex'):null;
// Canonical aliases use an independent filesystem oracle. This also covers filesystems that
// cannot create links. Native CLI cases below still execute the actual exporter without mocks.
function validator(aliases,dangling=[]){
 const map=path=>{for(const [alias,target] of aliases){const tail=relative(alias,path);if(tail===''||(!isAbsolute(tail)&&tail!=='..'&&!tail.startsWith('..'+sep)))return resolve(target,tail);}return path;};
 const context={readFileSync,writeFileSync,existsSync,mkdirSync,readdirSync,statSync,rmSync,copyFileSync,lstatSync:path=>dangling.includes(path)?{}:lstatSync(map(path)),realpathSync:{native:path=>{if(dangling.includes(path))throw Object.assign(new Error('unresolved link'),{code:'ENOENT'});return realpathSync.native(map(path));}},fileURLToPath,dirname,join,relative,sep,resolve,basename,isAbsolute,__moduleUrl:pathToFileURL(TOOL).href,process:{argv:[]}};
 const source=readFileSync(TOOL,'utf8').replace(/^import[\s\S]*?from '[^']+';\r?\n/gm,'').replace(/\bexport /g,'').replaceAll('import.meta.url','__moduleUrl');
 runInNewContext(source+'\nthis.validate = validateExportTarget;',context);
 return context.validate;
}
function canonicalRefusal(f,target,aliases){
 const before=f.snapshot();
 assert.throws(()=>validator(aliases)(target,f.source),/target overlaps the development source tree/);
 assert.deepEqual(f.snapshot(),before);
 if(process.platform!=='win32'){
  for(const [alias,destination] of aliases)symlinkSync(destination,alias,'dir');
  rejected(f,target);
 }
}
function fixture(t){
 const outer=mkdtempSync(join(testRoot,'export-target-'));
 const tail=relative(resolve(testRoot),resolve(outer));
 assert.ok(tail&&tail!=='..'&&!tail.startsWith('..\\')&&!tail.startsWith('../')&&!isAbsolute(tail));
 t.after(()=>cleanupTempDir(outer));
 const source=join(outer,'source');
 for(const directory of ['tools','core','config'])mkdirSync(join(source,directory),{recursive:true});
 writeFileSync(join(source,'tools','export-public.mjs'),readFileSync(TOOL));
 writeFileSync(join(source,'core','safety.mjs'),'export const detector = true;\n');
 writeFileSync(join(source,'bootstrap.sh'),'#!/usr/bin/env bash\nprintf safe\n');
 writeFileSync(join(source,'trap.txt'),'source trap\n');
 writeFileSync(join(outer,'trap.txt'),'outer trap\n');
 writeFileSync(join(source,'config','public-manifest.json'),JSON.stringify({dev_repo:'source',target_repo:'public',include:['core','bootstrap.sh'],exclude:[],forbidden_patterns:{},language_check:{pattern:'[\\u0400-\\u04FF]'}}));
 const observed=[join(source,'tools','export-public.mjs'),join(source,'core','safety.mjs'),join(source,'bootstrap.sh'),join(source,'trap.txt'),join(source,'config','public-manifest.json'),join(outer,'trap.txt')];
 const run=(target,flags=[])=>spawnSync(process.execPath,[join(source,'tools','export-public.mjs'),'--target',target,...flags],{cwd:outer,encoding:'utf8',windowsHide:true});
 return {outer,source,run,snapshot:()=>observed.map(file=>[file,hash(file)])};
}
function rejected(f,target,flags=[]){
 const before=f.snapshot(),entries=readdirSync(f.source).sort();
 const result=f.run(target,flags);
 assert.deepEqual(f.snapshot(),before,'the export must not change source or traps before refusal');
 assert.deepEqual(readdirSync(f.source).sort(),entries,'the export must not create a descendant target');
 assert.equal(result.error,undefined);
 assert.equal(result.status,1);
 assert.match(result.stderr,/target overlaps the development source tree/);
}

test('export refuses its own source directory before deleting source files',{skip},t=>{
 const f=fixture(t);rejected(f,f.source);
});
test('export refuses an ancestor before deleting the source or its outer trap',{skip},t=>{
 const f=fixture(t);rejected(f,f.outer);
});
test('export refuses a nonexistent descendant before creating any target directory',{skip},t=>{
 const f=fixture(t),target=join(f.source,'public','nested');rejected(f,target);assert.equal(existsSync(target),false);
});
test('dry-run and report-only both refuse a source overlap without changing files',{skip},t=>{
 const f=fixture(t);for(const flag of ['--dry-run','--report-only'])rejected(f,f.source,[flag]);
});
test('lexical dot segments and Windows path casing cannot bypass source overlap',{skip},t=>{
 const f=fixture(t);rejected(f,join(f.source,'..','source'));
 if(process.platform==='win32')rejected(f,f.source.toUpperCase());
});
test('a canonical alias outside the source that resolves to the source is refused',{skip},t=>{
 const f=fixture(t),alias=join(f.outer,'alias');canonicalRefusal(f,alias,[[alias,f.source]]);
});
test('a canonical alias ancestor is resolved even when the target tail does not yet exist',{skip},t=>{
 const f=fixture(t),alias=join(f.outer,'alias'),target=join(alias,'missing','public');
 canonicalRefusal(f,target,[[alias,f.source]]);assert.equal(existsSync(join(f.source,'missing')),false);
});
test('a canonical alias outside the source that resolves to a source ancestor is refused',{skip},t=>{
 const f=fixture(t),alias=join(f.outer,'alias');canonicalRefusal(f,alias,[[alias,f.outer]]);
});
test('a lexical descendant alias remains refused even when it resolves outside the source',{skip},t=>{
 const f=fixture(t),destination=join(f.outer,'outside'),alias=join(f.source,'alias');mkdirSync(destination);writeFileSync(join(destination,'trap.txt'),'outside trap\n');
 const before=hash(join(destination,'trap.txt'));canonicalRefusal(f,alias,[[alias,destination]]);assert.equal(hash(join(destination,'trap.txt')),before);
});
test('a canonical alias outside the source to another external directory remains usable',{skip},t=>{
 const f=fixture(t),destination=join(f.outer,'outside'),alias=join(f.outer,'alias');mkdirSync(destination);
 const before=f.snapshot();assert.equal(validator([[alias,destination]])(join(alias,'new','public'),f.source),join(realpathSync.native(destination),'new','public'));assert.deepEqual(f.snapshot(),before);
});
test('short-name source and target aliases preserve canonical paths and overlap refusals',{skip},t=>{
 const f=fixture(t),destination=join(f.outer,'outside long directory'),shortSource=join(f.outer,'SOURCE~1'),shortTarget=join(f.outer,'OUTSID~1');mkdirSync(destination);
 // The filesystem oracle models 8.3 expansion even when the host disables short names.
 const validate=validator([[shortSource,f.source],[shortTarget,destination]]),before=f.snapshot();
 assert.equal(validate(join(shortTarget,'new','public'),shortSource),join(realpathSync.native(destination),'new','public'));
 assert.throws(()=>validate(join(f.source,'new','public'),shortSource),/target overlaps the development source tree/);
 assert.throws(()=>validate(join(shortSource,'new','public'),f.source),/target overlaps the development source tree/);
 assert.deepEqual(f.snapshot(),before);assert.equal(existsSync(join(destination,'new')),false);assert.equal(existsSync(join(f.source,'new')),false);
});
test('an existing unresolved link is refused instead of being treated as a missing tail',{skip},t=>{
 const f=fixture(t),alias=join(f.outer,'dangling'),before=f.snapshot();
 assert.throws(()=>validator([], [alias])(join(alias,'missing','public'),f.source),error=>error.code==='ENOENT');
 assert.deepEqual(f.snapshot(),before);assert.equal(existsSync(alias),false);
});
test('an ordinary external sibling export succeeds and preserves its git history',{skip},t=>{
 const f=fixture(t),target=join(f.outer,'source-public');mkdirSync(join(target,'.git'),{recursive:true});writeFileSync(join(target,'.git','trap.txt'),'git trap\n');writeFileSync(join(target,'old.txt'),'old export\n');
 const before=f.snapshot(),gitBefore=hash(join(target,'.git','trap.txt')),result=f.run(target);
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);assert.deepEqual(f.snapshot(),before);
 assert.equal(hash(join(target,'.git','trap.txt')),gitBefore);assert.equal(existsSync(join(target,'old.txt')),false);
 assert.equal(hash(join(target,'core','safety.mjs')),hash(join(f.source,'core','safety.mjs')));
 assert.equal(hash(join(target,'bootstrap.sh')),hash(join(f.source,'bootstrap.sh')));
});
test('an ordinary external dry-run succeeds without creating its nonexistent target',{skip},t=>{
 const f=fixture(t),target=join(f.outer,'public','nested'),before=f.snapshot(),result=f.run(target,['--dry-run']);
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);assert.deepEqual(f.snapshot(),before);assert.equal(existsSync(target),false);
});

test('generated public MCP catalog is preflighted before any destination write',{skip},t=>{
 const f=fixture(t),manifestPath=join(f.source,'config/public-manifest.json');
 const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
 manifest.generated_in_public={'toolset/catalog.json':'public MCP only'};
 manifest.forbidden_patterns={private_projects:['forbidden-service']};
 writeFileSync(manifestPath,JSON.stringify(manifest));mkdirSync(join(f.source,'toolset'));
 writeFileSync(join(f.source,'config/mcp-manifest.example.json'),JSON.stringify({servers:[{name:'forbidden-service'}]}));
 writeFileSync(join(f.source,'toolset/catalog.json'),JSON.stringify({schema_version:1,based_on:'v1.0.0',elements:[
  {id:'mcp/forbidden-service',kind:'mcp',name:'forbidden-service',source:'config/mcp-manifest.json',status:'default',compatibility:{claude:'native',codex:'native',opencode:'native'}}]}));
 const target=join(f.outer,'public'),result=f.run(target);
 assert.equal(result.status,1);assert.equal(existsSync(target),false);
 assert.match(result.stdout,/toolset[\\/]catalog\.json/);
});

function boundaryFixture(t) {
 const f=fixture(t),target=join(f.outer,'public'),manifestPath=join(f.source,'config/public-manifest.json');
 mkdirSync(target);writeFileSync(join(target,'owner.txt'),'owner bytes\n');
 const before=hash(join(target,'owner.txt'));
 return {...f,target,manifestPath,edit:change=>{
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  writeFileSync(manifestPath,JSON.stringify(change(manifest)));
 },refusal:flags=>{
  const result=f.run(target,flags);assert.equal(result.status,1,result.stderr);
  assert.deepEqual(readdirSync(target),['owner.txt']);assert.equal(hash(join(target,'owner.txt')),before);
  return result;
 }};
}
test('source matches reveal only a rule ID and location in both export modes',{skip},t=>{
 const f=boundaryFixture(t),secret='fixture-private-value-never-display';
 f.edit(m=>({...m,forbidden_patterns:{private:[secret]}}));
 writeFileSync(join(f.source,'core/safety.mjs'),`// second line\nconst data = '${secret}';\n`);
 for(const flags of [[],['--report-only']]) {
  const result=f.refusal(flags),output=result.stdout+result.stderr;
  assert.match(output,/safety\.mjs:2: \[group-0-rule-0\]/);
  assert.ok(!output.includes(secret));assert.ok(!output.includes(secret.slice(0,12)));
 }
});
test('every generated file class is scanned before clearing the destination',{skip},t=>{
 for(const [rel,source] of [['.gitignore','templates/gitignore.public'],['.claude/settings.json','templates/project-settings.json']]) {
  const f=boundaryFixture(t),secret='fixture-private-generated-value';
  mkdirSync(join(f.source,'templates'));writeFileSync(join(f.source,source),secret);
  f.edit(m=>({...m,include:[...m.include,'templates'],generated_in_public:{[rel]:'required'},forbidden_patterns:{private:[secret]}}));
  const result=f.refusal([]);assert.ok(result.stdout.includes(rel));assert.ok(!(result.stdout+result.stderr).includes(secret));
 }
 const f=boundaryFixture(t);mkdirSync(join(f.source,'toolset'));
 writeFileSync(join(f.source,'config/mcp-manifest.example.json'),JSON.stringify({servers:[]}));
 writeFileSync(join(f.source,'toolset/catalog.json'),JSON.stringify({based_on:'fixture',elements:[]}));
 f.edit(m=>({...m,generated_in_public:{'toolset/catalog.json':'required'},forbidden_patterns:{private:['Public tool catalog']}}));
 assert.match(f.refusal([]).stdout,/toolset[\\/]CATALOG\.md/);
});
test('read errors, invalid rules and missing generated templates fail without target changes',{skip},t=>{
 const f=boundaryFixture(t),fault=join(f.outer,'fault.mjs'),secret='fixture-error-value-never-display';
 writeFileSync(fault,`import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
 const read=fs.readFileSync; fs.readFileSync=function(path,...args){
 if(String(path).endsWith('safety.mjs'))throw new Error('${secret}');return read(path,...args);};syncBuiltinESMExports();`);
 const result=spawnSync(process.execPath,['--import',fault,join(f.source,'tools/export-public.mjs'),'--target',f.target],{encoding:'utf8',windowsHide:true});
 assert.equal(result.status,1);assert.ok(!(result.stdout+result.stderr).includes(secret));
 assert.deepEqual(readdirSync(f.target),['owner.txt']);
 f.edit(m=>({...m,forbidden_patterns:{private:['[']}}));f.refusal([]);
 f.edit(m=>({...m,forbidden_patterns:{},generated_in_public:{'.gitignore':'required'}}));f.refusal([]);
});
test('language-only and link-only report violations return failure without writes',{skip},t=>{
 for(const content of [String.fromCharCode(0x440,0x443,0x441), '[missing](absent.md)']) {
  const f=boundaryFixture(t);writeFileSync(join(f.source,'README.md'),content);
  f.edit(m=>({...m,include:[...m.include,'README.md']}));f.refusal(['--report-only']);
 }
});
test('known opaque secrets from env files are checked without recording their values',{skip},t=>{
 const f=boundaryFixture(t),secret='fixture-opaque-credential-value';
 writeFileSync(join(f.source,'.env'),`FIXTURE_KEY='${secret}'\n`);
 writeFileSync(join(f.source,'core/safety.mjs'),`// ${secret}\n`);
 f.edit(m=>({...m,private_sources:{env_files:['.env']}}));
 const result=f.refusal([]);assert.ok(!(result.stdout+result.stderr).includes(secret));
});
test('private filenames fail before writing and the name itself is redacted',{skip},t=>{
 const f=boundaryFixture(t),secret='fixture-private-filename';
 writeFileSync(join(f.source,'core',secret+'.mjs'),'// safe content\n');
 f.edit(m=>({...m,forbidden_patterns:{private:[secret]}}));
 const result=f.refusal([]),output=result.stdout+result.stderr;
 assert.match(output,/private-filename/);assert.ok(!output.includes(secret));
});
