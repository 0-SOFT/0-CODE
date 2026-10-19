import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assembleInstallationBundle } from '../../core/installation-bundle.mjs';
import { normalizeProjectConfig } from '../../core/project-config.mjs';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';
import { frameworkSource } from '../helpers/framework-source.mjs';

test('bundle resolves historical source schema and templates independently of new project roles',t=>{
  const {source}=frameworkSource(t);
  const put=(path,bytes)=>{mkdirSync(dirname(join(source,path)),{recursive:true});writeFileSync(join(source,path),bytes);};
  const stateSchema=Buffer.from('{"title":"Historical schema fixture"}\n');
  put('docs/schemas/STATE.schema.json',stateSchema);
  try { unlinkSync(join(source,'schemas/STATE.schema.json')); } catch(error) { if(error.code!=='ENOENT')throw error; }
  const names=['research','update','roadmap','guideline','decision','audit_arch','testing'];
  for(const name of names) {
    put('docs/prompts/templates/'+name+'.md','# Historical '+name+'\n');
    try { unlinkSync(join(source,'templates/'+name+'.md')); } catch(error) { if(error.code!=='ENOENT')throw error; }
  }
  const config=normalizeProjectConfig({modules:{...Object.fromEntries(Object.keys(PROJECT_MODULES).map(id=>[id,false])),audits:true}});
  const bundle=assembleInstallationBundle(config,{source});
  assert.deepEqual(bundle.files.get('schemas/STATE.schema.json'),stateSchema);
  for(const name of names) assert.equal(bundle.files.get('templates/'+name+'.md').toString(),'# Historical '+name+'\n');
  assert.equal([...bundle.files.keys()].some(path=>path.startsWith('docs/')),false);
  put('schemas/STATE.schema.json','{"title":"Current fixture"}\n');
  for(const name of names) put('templates/'+name+'.md','# Current '+name+'\n');
  const current=assembleInstallationBundle(config,{source});
  assert.deepEqual(current.files.get('schemas/STATE.schema.json'),readFileSync(join(source,'schemas/STATE.schema.json')));
  for(const name of names) assert.equal(current.files.get('templates/'+name+'.md').toString(),'# Current '+name+'\n');
});
