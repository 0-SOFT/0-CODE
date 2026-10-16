import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// tools/export-public.mjs is deliberately not published while tests/ is, so the import is guarded
// and the suite says out loud that it skipped — the same shape as tests/unit/export-language.test.mjs.
const TOOL = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'tools', 'export-public.mjs');
const skip = existsSync(TOOL) ? false : 'the export tool is not part of the published tree';
const load = async () => (await import(pathToFileURL(TOOL).href)).scanDeadLinks;

// v1.23.0: the published CLAUDE_CODE_SETUP.md linked to docs/cloud-setup.md, an internal file, and
// the export said nothing. These pin down what counts as dead and what is none of the check's business.
const published = ['README.md', 'docs/two-modes.md', 'docs/schemas/STATE.schema.json', 'tools/cloud-setup.sh'];

test('a link to a file that is not published is dead; one that is published is not', { skip }, async () => {
  const scanDeadLinks = await load();
  assert.deepEqual(scanDeadLinks('see [guide](docs/cloud-setup.md)', 'CLAUDE_CODE_SETUP.md', published), ['docs/cloud-setup.md']);
  assert.deepEqual(scanDeadLinks('see [modes](docs/two-modes.md)', 'CLAUDE_CODE_SETUP.md', published), []);
});

test('links resolve from the linking file, and a link out of the tree is dead', { skip }, async () => {
  const scanDeadLinks = await load();
  assert.deepEqual(scanDeadLinks('[r](../README.md) [s](./schemas/STATE.schema.json)', 'docs/two-modes.md', published), []);
  assert.deepEqual(scanDeadLinks('[x](../../elsewhere.md)', 'docs/two-modes.md', published), ['../../elsewhere.md']);
});

test('anchors, web and mail links, directories and generated files are not dead', { skip }, async () => {
  const scanDeadLinks = await load();
  const text = '[a](#top) [w](https://example.com/x.md) [m](mailto:a@b.c) [d](docs/schemas) ' +
    '[g](.gitignore) [p](docs/two-modes.md#loop "title")';
  assert.deepEqual(scanDeadLinks(text, 'README.md', published, ['.gitignore']), []);
});

test('only Markdown is read, and links inside code are examples, not links', { skip }, async () => {
  const scanDeadLinks = await load();
  assert.deepEqual(scanDeadLinks('[x](missing.md)', 'tools/cloud-setup.sh', published), []);
  assert.deepEqual(scanDeadLinks('`[x](missing.md)`\n```\n[y](gone.md)\n```', 'README.md', published), []);
});

test('native Windows file lists and nested Markdown paths resolve the same published links', { skip }, async () => {
  const scanDeadLinks = await load();
  const native = published.map(path => path.replaceAll('/', '\\'));
  assert.deepEqual(scanDeadLinks('[setup](tools/cloud-setup.sh)', 'CLAUDE_CODE_SETUP.md', native), []);
  assert.deepEqual(scanDeadLinks('[root](../README.md) [schema](schemas/STATE.schema.json) [generated](generated/settings.json)',
    'docs\\two-modes.md', native, ['docs\\generated\\settings.json']), []);
  assert.deepEqual(scanDeadLinks('[missing](schemas/missing.json) [outside](../../private.md)',
    'docs\\two-modes.md', native), ['schemas/missing.json', '../../private.md']);
});
