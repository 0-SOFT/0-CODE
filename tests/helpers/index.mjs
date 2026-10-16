// tests/helpers/index.mjs — shared test fixtures (DRY). Zero dependencies.

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, lstatSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,relative,isAbsolute,sep } from 'node:path';
import {fileURLToPath} from 'node:url';
import { parseYaml } from '../../lib/yaml-mini.mjs';
import {retryWindowsFileOperation} from '../../lib/replace-file.mjs';

// Await this in the test's finally: Windows may retain a temporary directory
// while a process is winding down. A persistent failure still rejects the test.
const cleanupOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };
export async function cleanupTempDir(dir) {
  try {await rm(dir,cleanupOptions);}
  catch(error) {
    if(process.platform!=='win32'||!['ENOTEMPTY','EPERM','EACCES','EBUSY'].includes(error.code))throw error;
    cleanupInOrder(dir);
  }
}
export function cleanupTempDirSync(dir) {
  try {rmSync(dir,cleanupOptions);}
  catch(error) {
    if(process.platform!=='win32'||!['ENOTEMPTY','EPERM','EACCES','EBUSY'].includes(error.code))throw error;
    cleanupInOrder(dir);
  }
}
function cleanupInOrder(directory) {
  const target=resolve(directory),roots=[process.env.FRAMEWORK_TEST_TMPDIR||tmpdir(),fileURLToPath(new URL('../../../scratch/tmp/',import.meta.url))];
  if(!roots.some(root=>{const tail=relative(resolve(root),target);return tail&&!isAbsolute(tail)&&tail!=='..'&&!tail.startsWith('..'+sep);}))
    throw new Error('Cleanup target is outside the test temporary roots');
  const remove=path=>{
    let stat;try {stat=lstatSync(path);} catch(error) {if(error.code==='ENOENT')return;throw error;}
    if(stat.isDirectory()&&!stat.isSymbolicLink()) {
      for(const name of readdirSync(path))remove(join(path,name));
      retryWindowsFileOperation(()=>rmdirSync(path),{retryCodes:['EPERM','EACCES','EBUSY','ENOTEMPTY']});
    } else retryWindowsFileOperation(()=>unlinkSync(path));
  };
  // Postorder deletion avoids the parallel recursive remover's stale directory observations.
  // Links are removed themselves; their targets are never traversed.
  remove(target);
}

// Create a temporary project with docs/STATE.md built from the given frontmatter object.
// Returns { dir, stateFile, cleanup() }. The caller must invoke cleanup() in t.after.
export function mkTempProject(frontmatter = {}, { baseDir = tmpdir() } = {}) {
  mkdirSync(baseDir, { recursive: true });
  const dir = mkdtempSync(join(baseDir, 'ralph-test-'));
  const fm = {
    schema_version: 1, project_name: 'test', current_stage: 2, current_version: '0.0.1',
    blockers: [], session_count: 0, iteration: 0, max_iterations: 60, ...frontmatter,
  };
  const body = '---\n' + serializeFm(fm) + '---\n\n# Journal\n';
  mkdirSync(join(dir, 'docs'), { recursive: true });
  const stateFile = join(dir, 'docs', 'STATE.md');
  writeFileSync(stateFile, body, 'utf8');
  return { dir, stateFile, cleanup: () => { try { cleanupTempDirSync(dir); } catch {} } };
}

// Minimal frontmatter serialisation for fixtures (values are primitives, arrays or objects).
function serializeFm(obj) {
  let out = '';
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) out += v.length === 0 ? `${k}: []\n` : `${k}: ${JSON.stringify(v)}\n`;
    else if (v && typeof v === 'object') out += `${k}: ${JSON.stringify(v)}\n`;
    else if (v === null) out += `${k}: null\n`;
    else out += `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}\n`;
  }
  return out;
}

// Read the STATE.md frontmatter (through the project's real parser).
export function readFrontmatter(file) {
  const raw = readFileSync(file, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  return parseYaml(m[1]);
}

// A fake `claude --output-format json` stdout (for testing parseClaudeJson without the CLI).
export function fakeClaudeJson({ result = 'ok', session_id = 'sess1', total_cost_usd = 0.01 } = {}) {
  return JSON.stringify({ result, session_id, total_cost_usd });
}
