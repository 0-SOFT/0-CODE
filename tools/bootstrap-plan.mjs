#!/usr/bin/env node
// Read-only bootstrap validation and preview. This never starts an engine.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planProjectInstructions } from '../lib/project-instructions.mjs';
import { provisionCodex } from './provision-codex.mjs';
import { frameworkVersion as sourceVersion } from '../core/project-config.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export async function planBootstrap({ root = ROOT, targetDir, backend = 'claude',
  frameworkVersion, env = process.env } = {}) {
  if (!['claude', 'opencode', 'codex'].includes(backend)) throw new Error('Unknown bootstrap backend');
  targetDir = resolve(targetDir || process.cwd());
  const actualTarget = existsSync(targetDir) ? realpathSync(targetDir) : targetDir;
  if (actualTarget === realpathSync(root)) throw new Error('Target directory equals the framework root');
  frameworkVersion ||= sourceVersion(root);
  const instructions = planProjectInstructions({ root, targetDir, frameworkVersion });
  const codex = backend === 'codex' ? await provisionCodex({ root, targetDir,
    content: instructions.content, env, dryRun: true }) : undefined;
  return { targetDir, backend, instructions, codex };
}

export async function main(argv = process.argv.slice(2)) {
  const options = {}, values = { '--target': 'targetDir', '--backend': 'backend', '--version': 'frameworkVersion' };
  let render = false, dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--render') render = true;
    else if (flag === '--dry-run') dryRun = true;
    else if (values[flag] && argv[i + 1] && !argv[i + 1].startsWith('--')) options[values[flag]] = argv[++i];
    else throw new Error(`Unknown argument or missing value: ${flag}`);
  }
  if (render === dryRun) throw new Error('Select exactly one of --render or --dry-run');
  const plan = await planBootstrap(options);
  if (render) { process.stdout.write(plan.instructions.content); return plan; }
  console.log(`[dry-run] Bootstrap ${plan.backend}: ${plan.targetDir}`);
  console.log('  Copy hooks, lib, core, schemas, prompt templates, skill and framework commands.');
  console.log('  Merge .gitignore and .gitattributes; preserve existing project rules.');
  console.log('  Merge CLAUDE.md; initialise missing STATE, ROADMAP and tools catalogue.');
  console.log('  Render ecosystem.json for the selected engine; set installation markers after success.');
  if (plan.backend === 'claude') console.log('  Merge Claude project settings and preserve an existing status line.');
  if (plan.codex) {
    console.log(`  Codex home: ${plan.codex.home}`);
    console.log(`  Codex instructions: ${plan.codex.instructions.join(', ')}`);
    console.log(`  MCP: ${plan.codex.registered.join(', ') || '(none)'}`);
    for (const name of plan.codex.skipped) console.log(`  MCP skipped: ${name} (${plan.codex.reasons[name]})`);
    console.log('  Validate instructions, home ownership, rules and MCP; install the external configuration.');
    console.log('  Saved login remains untouched. No engine, dependency installation or notification is launched.');
  } else if (plan.backend === 'opencode') {
    console.log('  Prepare OpenCode configuration, AGENTS.md and the protection plugin.');
  }
  return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`bootstrap: ${error.message}`); process.exitCode = 1; });
}
