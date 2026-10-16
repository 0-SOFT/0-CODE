import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
function sources(directory) {
  return readdirSync(directory, {withFileTypes:true}).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : path.endsWith('.mjs') ? [path] : [];
  });
}
test('kernel document paths have one source: project-config defaults', () => {
  const found = [];
  const installedTools=['tools/0code.mjs','tools/mcp-reference-run.mjs'].map(name=>join(root,name));
  for (const file of [...['core','lib','hooks'].flatMap(name => sources(join(root,name))),...installedTools]) {
    const name = relative(root,file).replaceAll('\\','/');
    if (name === 'core/project-config.mjs') continue;
    for (const [index,line] of readFileSync(file,'utf8').split(/\r?\n/).entries()) {
      // Historical comments are allowed; executable examples and diagnostics are not.
      if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue;
      if (/\bdocs[/\\]|['"`]docs['"`]/.test(line)) found.push(`${name}:${index+1}`);
    }
  }
  assert.deepEqual(found, [], 'Use document roles through core/project-config.mjs: '+found.join(', '));
});
