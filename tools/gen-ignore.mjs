#!/usr/bin/env node
// gen-ignore.mjs — render the ignore policy into both trees, or verify that they still match it.
//
// The policy lives in lib/ignore-policy.mjs. This tool is the writer; the smoke guard is the
// reader. Two rendered files exist because git needs a real .gitignore at the root of each tree —
// but they are no longer two sources, which is what let them drift apart.
//
// Usage:
//   node tools/gen-ignore.mjs            — write .gitignore and templates/gitignore.public
//   node tools/gen-ignore.mjs --check    — exit 1 if either file disagrees with the policy
//   node tools/gen-ignore.mjs --dry-run  — print what would be written, touch nothing

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderIgnore, diffEntries } from '../lib/ignore-policy.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// tree -> the file that tree's git actually reads (for `public`, the template the export copies).
// `file` stays posix-shaped: it is what the tool PRINTS, and a message that reads
// templates\gitignore.public on Windows and templates/gitignore.public on Linux describes the
// same file twice. join() below turns it into a real path.
export const TARGETS = [
  { tree: 'working', file: '.gitignore' },
  { tree: 'public', file: 'templates/gitignore.public' },
];

function parseArgs(argv) {
  const o = { check: false, dryRun: false };
  for (const a of argv) {
    if (a === '--check') o.check = true;
    else if (a === '--dry-run') o.dryRun = true;
    else { process.stderr.write(`gen-ignore: unknown argument ${a}\n`); process.exit(2); }
  }
  return o;
}

const opt = parseArgs(process.argv.slice(2));
let failed = 0;

for (const { tree, file } of TARGETS) {
  const path = join(ROOT, ...file.split('/'));
  const rendered = renderIgnore(tree);

  if (opt.check) {
    if (!existsSync(path)) {
      console.error(`  MISSING: ${file} — the tree has no ignore file at all`);
      failed++;
      continue;
    }
    const d = diffEntries(readFileSync(path, 'utf8'), tree);
    if (d.ok) {
      console.log(`  ok: ${file} matches the policy`);
    } else {
      failed++;
      if (d.missingSecrets.length) {
        console.error(`  LEAK RISK: ${file} does not protect ${d.missingSecrets.join(', ')}`);
      }
      if (d.missing.length) console.error(`  missing in ${file}: ${d.missing.join(', ')}`);
      if (d.unexpected.length) {
        console.error(`  present in ${file} but not in the policy: ${d.unexpected.join(', ')}`);
        console.error('  An entry worth keeping belongs in lib/ignore-policy.mjs, not in one copy.');
      }
    }
    continue;
  }

  if (opt.dryRun) {
    console.log(`[dry-run] would write ${file} (${rendered.split('\n').length - 1} lines)`);
    continue;
  }

  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (before === rendered) {
    console.log(`  unchanged: ${file}`);
  } else {
    writeFileSync(path, rendered, 'utf8');
    console.log(`  written: ${file}`);
  }
}

if (opt.check && failed) {
  console.error(`\ngen-ignore --check: ${failed} file(s) disagree with lib/ignore-policy.mjs.`);
  console.error('Run `node tools/gen-ignore.mjs` to re-render them from the single source.');
  process.exit(1);
}
