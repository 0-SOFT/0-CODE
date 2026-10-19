#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventorySummary, scanProject } from '../core/project-inventory.mjs';
import { findProjectRoot, loadProjectConfig } from '../core/project-config.mjs';
import { installProject, planProjectInstallation, planProjectUninstall, uninstallProject, upgradeProject } from '../core/project-installation.mjs';
import { doctorProject } from '../core/project-doctor.mjs';
import { planProjectStart, startProjectCycle } from '../core/project-start.mjs';
import { planUserInstallation, installUserTools, planUserUninstall, uninstallUserTools, doctorUserTools, recoverUserInstallation } from '../core/user-installation.mjs';
import { applyInstallationPlan, recoverInstallation } from '../core/installation-transaction.mjs';
import { applyInstallationGroup } from '../core/installation-group.mjs';
import { planProjectMigration } from '../core/project-migration.mjs';
const COMMANDS = ['scan', 'install', 'doctor', 'upgrade', 'uninstall', 'start', 'install-tools', 'uninstall-tools', 'doctor-tools','migrate'];
const HELP = `Usage: node tools/0code.mjs <command> [options]

Commands:
  scan            Inspect a project and suggest configuration without writes
  install         Install into .0-code and configured native engine locations
  upgrade         Upgrade an owned installation, preserving project preferences
  migrate         Migrate proven legacy files or relocate owned project documents
  uninstall       Remove owned project files; preserve documents and machine tools
  doctor          Check local installation and MCP prerequisites
  start <prompt>  Bind a cycle prompt and print its driver command
  install-tools   Install the selected machine toolset
  uninstall-tools Remove owned machine tools and restore native settings
  doctor-tools    Check the machine toolset

Options:
  --project <dir>  Project root (default: discovered current project)
  --config <file>  Configuration for install, upgrade, migrate or install-tools
  --source <dir>  Authorized source for install, upgrade, migrate or install-tools
  --backend <id>  claude, codex or opencode for those installation commands
  --max <N>       Positive cycle limit for start
  --dry-run       Preview mutations without applying (not scan or doctor)
  --relocate-documents <file>  Reviewed JSON {schema_version:1,files:[paths]} for upgrade/migrate
  --adopt-manifest <file>  Reviewed hash manifest for a customized installation without a receipt (migrate)
  --json          Machine-readable result
  --help, -h      Show this help without writes

Examples:
  node tools/0code.mjs scan --project ./app --json
  node tools/0code.mjs install --project ./app --config settings.json --dry-run
  node tools/0code.mjs start cycle.md --max 10
`;
export function parseOptions(argv) {
  if(argv.length===1&&['--help','-h','help'].includes(argv[0])
    ||argv.length===2&&COMMANDS.includes(argv[0])&&['--help','-h'].includes(argv[1]))return {command:'help'};
  const command = argv[0];
  if (!COMMANDS.includes(command)) throw new Error('Unknown installer command');
  const options = { command, projectDir: findProjectRoot(), json: false, dryRun: false };
  const seen = new Set();
  const valued = { '--project': 'projectDir', '--config': 'configFile', '--source': 'source', '--backend': 'backend', '--max': 'maxIterations', '--relocate-documents':'documentManifestFile', '--adopt-manifest':'adoptionManifestFile' };
  const permitted = { '--config': ['install', 'upgrade','install-tools','migrate'], '--source': ['install', 'upgrade','install-tools','migrate'], '--backend': ['install', 'upgrade','install-tools','migrate'], '--max': ['start'], '--relocate-documents':['upgrade','migrate'], '--adopt-manifest':['migrate'] };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json' || flag === '--dry-run') {
      if (seen.has(flag) || flag === '--dry-run' && ['scan', 'doctor'].includes(command)) throw new Error('Repeated or inappropriate option');
      options[flag === '--json' ? 'json' : 'dryRun'] = true; seen.add(flag);
    } else if (Object.hasOwn(valued, flag)) {
      if (seen.has(flag) || !argv[i + 1] || argv[i + 1].startsWith('--') || permitted[flag] && !permitted[flag].includes(command)) throw new Error('Missing value or option is not applicable to this command');
      const value = argv[++i]; seen.add(flag);
      if (flag === '--max') {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new Error('--max requires a positive integer');
        options.maxIterations = Number(value);
      } else if (flag === '--backend') {
        if (!['claude', 'codex', 'opencode'].includes(value)) throw new Error('Unknown engine');
        options.backend = value;
      } else options[valued[flag]] = resolve(value);
    } else if (!flag.startsWith('-') && command === 'start' && !options.promptFile) options.promptFile = resolve(flag);
    else if (!flag.startsWith('-') && command === 'install' && !seen.has('--project')) { options.projectDir = resolve(flag); seen.add('--project'); }
    else throw new Error('Unknown option or extra argument');
  }
  if (command === 'start' && !options.promptFile) throw new Error('Specify the cycle prompt file');
  return options;
}
export async function main(argv = process.argv.slice(2), write = text => process.stdout.write(text)) {
  const options = parseOptions(argv), root = options.projectDir;
  if(options.command==='help') {write(HELP);return {command:'help'};}
  let result;
  if (options.command === 'scan') {
    result = scanProject(root);
    if (!options.json) { write(inventorySummary(result)); write('Suggested configuration (no project writes yet):\n'); write(JSON.stringify(result.suggestedConfig, null, 2) + '\n'); }
  } else if(options.command==='doctor-tools') {
    result=doctorUserTools();if(!options.json)write(JSON.stringify(result,null,2)+'\n');
  } else if (options.command === 'doctor') {
    result = doctorProject(root);
    if (!options.json) {
      write(result.checks.map(check => (check.ok ? '✓ ' : '✗ ') + check.id + ': ' + (check.detail || check.reason || 'checked')).join('\n') + '\n');
      for (const warning of result.warnings) write('Warning: ' + warning.reason + '\n');
    }
  } else {
    let prepared;
    if(options.command==='uninstall-tools')prepared=options.dryRun?planUserUninstall():uninstallUserTools();
    else if(options.command==='install-tools') {
      const config=options.configFile?JSON.parse(readFileSync(options.configFile,'utf8')):options.backend?{engines:[options.backend]}:undefined;
      const args={config,...(options.source?{source:options.source}:{})};
      prepared=options.dryRun?planUserInstallation(args):installUserTools(args);
    }
    else if (options.command === 'start') prepared = options.dryRun ? planProjectStart(root, options.promptFile, options) : startProjectCycle(root, options.promptFile, options);
    else if (options.command === 'uninstall') prepared = options.dryRun ? planProjectUninstall(root) : uninstallProject(root);
    else {
      let config = options.configFile ? JSON.parse(readFileSync(options.configFile, 'utf8')) : undefined;
      if (options.backend) {
        const base=config??scanProject(root).suggestedConfig;
        const roles=!config&&options.command==='migrate'?{documents:loadProjectConfig({projectDir:root}).config.documents}:{};
        config={...base,...roles,engines:[options.backend]};
      }
      const args = { ...(config !== undefined ? { config } : {}), ...(options.source ? { source: options.source } : {}) };
      if(options.documentManifestFile)args.documentManifest=JSON.parse(readFileSync(options.documentManifestFile,'utf8'));
      if(options.adoptionManifestFile)args.adoptionManifest=JSON.parse(readFileSync(options.adoptionManifestFile,'utf8'));
      if(!options.dryRun)recoverInstallation(root);
      prepared=options.command==='migrate'?planProjectMigration(root,args):planProjectInstallation(root,{...args,upgrade:options.command==='upgrade'});
      if(prepared.config.modules.toolset&&prepared.config.toolset.scope==='user') {
        if(!options.dryRun)recoverUserInstallation({...args,config:prepared.config});
        const machine=planUserInstallation({...args,config:prepared.config});
        prepared.machinePlan=machine.plans.flatMap(plan=>plan.summary().map(entry=>({...entry,root:plan.root})));
        if(!options.dryRun)applyInstallationGroup(machine.plans,{primary:machine.root});
      }
      if(!options.dryRun)prepared.result=applyInstallationPlan(prepared.plan);
    }
    result = { command: options.command, projectDir: root, dryRun: options.dryRun,
      changed: prepared.result?.changed ?? 0, plan: prepared.plan?prepared.plan.summary():prepared.plans.flatMap(plan=>plan.summary().map(entry=>({...entry,root:plan.root}))),
      ...(prepared.machinePlan?{machinePlan:prepared.machinePlan}:{}),
      ...(prepared.migration?{migration:prepared.migration}:{}),
      ...(prepared.documentMigration?{documentMigration:prepared.documentMigration}:{}),
      ...(prepared.adoption?{adoption:prepared.adoption}:{}),
      ...(prepared.config ? { framework_version: prepared.config.framework_version, modules: prepared.bundle.modules } : {}),
      ...(prepared.prompt ? { prompt: prepared.prompt, drivers: prepared.drivers } : {}) };
    if (!options.json) {
      write(options.dryRun ? 'Read-only plan:\n' : 'Changed files: ' + result.changed + '\n');
      for (const entry of result.plan) write(entry.operation + ' ' + entry.path + '\n');
      for (const driver of result.drivers || []) write('Launch ' + driver.engine + ' from the project: ' + JSON.stringify(driver.argv) + '\n');
      if (options.command === 'install' && !options.dryRun) write('Installation complete. Run doctor; use start for a new cycle prompt.\nATTENTION: the cycle has not started; restart the Claude session to load new hooks.\n');
    }
  }
  if (options.json) write(JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await main(); if (result.ok === false) process.exitCode = 1; }
  catch (error) { process.stderr.write('0-CODE: ' + error.message + '\n'); for (const entry of error.conflicts || []) process.stderr.write(entry.path + ': ' + entry.reason + '\n'); process.exitCode = 1; }
}
