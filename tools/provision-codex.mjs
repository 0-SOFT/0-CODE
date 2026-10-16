#!/usr/bin/env node
// Install project instructions and external guard artifacts without invoking the CLI.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexBackend, CODEX_VERSION } from '../core/backends/codex.mjs';
import { buildPermissionsBlock } from '../core/permissions-policy.mjs';
import { loadCodexEnvironment, mcpEnvironmentNames } from '../lib/codex-env.mjs';
import { cloudMcpManifest, isCloudMcpMode } from '../lib/cloud-mcp-policy.mjs';
import { loadProjectConfig } from '../core/project-config.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function parseProvisionArgs(argv) {
  const result = { targetDir: process.cwd(), dryRun: false };
  const values = { '--target': 'targetDir', '--manifest': 'manifestPath', '--instructions': 'instructionsPath', '--home': 'homeDir' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') result.dryRun = true;
    else if (flag === '--cloud') result.cloudMode = true;
    else if (values[flag] && argv[i + 1] && !argv[i + 1].startsWith('--')) result[values[flag]] = argv[++i];
    else throw new Error(`Unknown option or missing value: ${flag}`);
  }
  return result;
}

export async function provisionCodex({ targetDir = process.cwd(), root = ROOT,
  manifestPath, instructionsPath, content, homeDir, env = process.env, dryRun = false, cloudMode = false } = {}) {
  targetDir = resolve(targetDir);
  cloudMode ||= isCloudMcpMode(env);
  if (cloudMode) env = { ...env, FRAMEWORK_CLOUD_MODE: '1' };
  manifestPath ||= existsSync(join(root, 'config', 'mcp-manifest.json'))
    ? join(root, 'config', 'mcp-manifest.json') : join(root, 'config', 'mcp-manifest.example.json');
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch { throw new Error('Could not read the Codex MCP manifest'); }
  instructionsPath ||= join(targetDir, 'CLAUDE.md');
  if (content === undefined) {
    if (!existsSync(instructionsPath)) throw new Error('Project instructions are missing: run bootstrap first or pass --instructions');
    content = readFileSync(instructionsPath, 'utf8');
  }
  const envFiles = [join(root, 'config', '.env'), join(root, '.env')];
  const backend = new CodexBackend({ env, homeDir, envFiles });
  // Determine the effective sticky mode from the validated owned snapshot before secrets.
  cloudMode ||= backend.home.cloudMode({ cwd: targetDir });
  if (cloudMode) env = { ...env, FRAMEWORK_CLOUD_MODE: '1' };
  env = loadCodexEnvironment(envFiles, env, mcpEnvironmentNames(cloudMcpManifest(manifest, cloudMode)));
  backend.env = env;
  const policy = buildPermissionsBlock();
  // Check the byte limit, ownership and entire manifest before the first write.
  const previewInstructions = await backend.installInstructions({ targetDir, content, dryRun: true });
  const previewPermissions = await backend.applyPermissions({ policy, targetDir, dryRun: true });
  const previewMcp = await backend.registerMcp(manifest, env, { targetDir, dryRun: true });
  if (dryRun) return { dryRun, cloudMode, home: previewPermissions.home, mode: previewPermissions.mode,
    executionHome: previewPermissions.executionHome, instructions: previewInstructions.planned,
    registered: previewMcp.registered, skipped: previewMcp.skipped, reasons: previewMcp.reasons,
    dropped: previewPermissions.dropped, manifestPath };
  await backend.applyPermissions({ policy, targetDir });
  const mcp = await backend.registerMcp(manifest, env, { targetDir });
  const instructions = await backend.installInstructions({ targetDir, content });
  return { dryRun, cloudMode, home: mcp.home, mode: mcp.mode, executionHome: mcp.executionHome,
    instructions: instructions.written, registered: mcp.registered,
    skipped: mcp.skipped, reasons: mcp.reasons, dropped: mcp.dropped, manifestPath };
}

export async function main(argv = process.argv.slice(2)) {
  const options=parseProvisionArgs(argv);
  const result = await provisionCodex(options);
  const supervisor=join(loadProjectConfig({projectDir:options.targetDir}).frameworkDir,'core','supervisor.mjs');
  const bashSupervisor="'"+supervisor.replaceAll("'","'\\''")+"'";
  const powershellSupervisor="'"+supervisor.replaceAll("'","''")+"'";
  console.log(result.dryRun ? '[dry-run] Codex installation plan' : 'Codex configuration installed');
  console.log('  Guard artifacts:', result.home);
  console.log('  Codex home:', result.executionHome, `(${result.mode})`);
  console.log('  Instructions:', result.instructions.join(', '));
  console.log('  MCP:', result.registered.join(', ') || '(none)');
  for (const name of result.skipped) console.log(`  MCP skipped: ${name} (${result.reasons[name]})`);
  console.log('  Rules requiring the shared detector:', result.dropped.length);
  console.log(`  CLI: npm install -g @openai/codex@${CODEX_VERSION}`);
  if (result.mode === 'personal') {
    console.log('  Uses the device personal login; no second login is needed.');
    console.log('  If this device has not logged in: codex login');
    console.log(`  Run: node ${bashSupervisor} --backend codex`);
    return result;
  }
  const bashHome = "'" + result.home.replaceAll("'", "'\\''") + "'";
  const powershellHome = "'" + result.home.replaceAll("'", "''") + "'";
  console.log('  Sign in independently with CODEX_HOME scoped to login; restore it before starting the supervisor.');
  console.log('  Bash:');
  console.log(`    CODEX_HOME=${bashHome} codex login`);
  console.log(`    FRAMEWORK_CODEX_HOME=${bashHome} node ${bashSupervisor} --backend codex`);
  console.log('  PowerShell:');
  console.log('    $previousCodexHome = $env:CODEX_HOME');
  console.log(`    try { $env:CODEX_HOME = ${powershellHome}; codex login } finally {`);
  console.log('      if ($null -eq $previousCodexHome) { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue }');
  console.log('      else { $env:CODEX_HOME = $previousCodexHome }');
  console.log('    }');
  console.log(`    $env:FRAMEWORK_CODEX_HOME = ${powershellHome}`);
  console.log(`    node ${powershellSupervisor} --backend codex`);
  console.log('  Personal auth.json is never copied; CODEX_API_KEY is also supported.');
  console.log(`  Run: node ${bashSupervisor} --backend codex`);
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => { console.error('provision-codex: installation failed; check the manifest, instructions, environment and home ownership'); process.exitCode = 1; });
}
