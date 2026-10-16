// The old shell merger no longer exists: fixed project metadata remains untouched by the installer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installProject } from '../../core/project-installation.mjs';
import { PROJECT_MODULES } from '../../core/project-modules.mjs';
import { cleanupTempDir } from '../helpers/index.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const scratch = join(dirname(repo.replace(/[\\/]$/, '')), 'scratch', 'tmp'); mkdirSync(scratch, { recursive: true });
test('literal ignore/attribute patterns, CRLF, empty content and an absent final newline survive repeated installs', t => {
  const samples = ['# owner\n.env\n', '.env.backup\n', 'literal[abc]*?\\name\n-leading\n', '# owner\nlast-line',
    '.env\r\n', ' \n', '', 'duplicate\nduplicate\n'];
  for (const sample of samples) {
    const root = mkdtempSync(join(scratch, 'metadata-')); t.after(() => cleanupTempDir(root));
    for (const file of ['.gitignore', '.gitattributes']) writeFileSync(join(root, file), sample);
    const config = { engines: ['claude'], modules: Object.fromEntries(Object.keys(PROJECT_MODULES).map(id => [id, false])) };
    installProject(root, { config }); assert.equal(installProject(root).result.changed, 0);
    for (const file of ['.gitignore', '.gitattributes']) assert.deepEqual(readFileSync(join(root, file)), Buffer.from(sample));
  }
});
