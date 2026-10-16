// Inspect native files and run only --version / guard controls, never a model or a shell command.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadProjectConfig } from './project-config.mjs';
import { readInstallationReceipt, requireOwnership, validateExistingState } from './project-installation.mjs';
import { resolveMode } from './permission-decision.mjs';
import { runCli } from './backends/spawn-cli.mjs';
import { resolveCodexLaunch } from './backends/codex.mjs';
import { doctorUserTools } from './user-installation.mjs';
import { inspectMcpPrerequisites } from './mcp-prerequisites.mjs';
import { PROJECT_PLUGIN_ENTRY } from './backends/project-opencode-plugin.mjs';
const control = command => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
export function doctorProject(root, { env = process.env } = {}) {
  const checks = [], warnings = [];
  const check = (id, action) => { try { const detail = action(); checks.push({ id, ok: true, ...(detail ? { detail } : {}) }); }
    catch (error) { checks.push({ id, ok: false, reason: error.message }); } };
  let project, receipt;
  check('config', () => { project = loadProjectConfig({ projectDir: root, env }); if (!project.installed) throw new Error('Project config is absent'); });
  check('receipt', () => { receipt = readInstallationReceipt(root); if (!receipt) throw new Error('Installation receipt is absent'); });
  if (!project || !receipt) return { ok: false, checks, warnings };
  check('owned-files', () => {
    requireOwnership(root,receipt);
    return `${receipt.files.length} ownership entries checked`;
  });
  check('state', () => { if (!existsSync(project.documentPath('state'))) throw new Error('Configured state is absent'); validateExistingState(readFileSync(project.documentPath('state'))); });
  check('runtime-ignore', () => {
    if (!readFileSync(join(root, '.0-code/.gitignore'), 'utf8').split(/\r?\n/).includes('run/')) throw new Error('Runtime is not excluded from git');
  });
  const guardEnv = { ...project.guardEnvironment, SAFETY_GUARD_LOG: project.runtimePath('guard.log') };
  for (const engine of project.config.engines) {
    check(`engine-${engine}`, () => {
      const launch = engine === 'codex' ? resolveCodexLaunch({ env }) : { bin: engine, args: [] };
      const result = runCli(launch.bin, [...launch.args, '--version'], { cwd: root, env, encoding: 'utf8', timeoutMs: 10000 });
      if (result.status !== 0) throw new Error('Engine is unavailable or --version failed');
      return String(result.stdout || '').trim().split(/\r?\n/)[0].slice(0, 120);
    });
    // Unknown installation bytes are a diagnostic failure, never a source to execute.
    if(!checks.find(check=>check.id==='owned-files')?.ok)continue;
    if (resolveMode(guardEnv).mode === 'allow-all') {
      warnings.push({ engine, reason: 'Guard is intentionally disabled by project configuration; denial control is not claimed' }); continue;
    }
    check(`guard-${engine}`, () => {
      if (engine === 'opencode') {
        const file = join(root, '.opencode/plugins/0-code-safety-guard.js');
        // Bun loads this ES entrypoint independently of the owner's Node package type.
        // Verify the shim, then resolve its one relative import explicitly in the Node probe.
        const source=readFileSync(file,'utf8');
        if(source.trim()!==PROJECT_PLUGIN_ENTRY.trim())throw new Error('Installed OpenCode entrypoint is not the verified shim');
        const absolute=pathToFileURL(join(project.frameworkDir,'core/backends/project-opencode-plugin.mjs')).href;
        const entry=source.replace('"../../.0-code/core/backends/project-opencode-plugin.mjs"',JSON.stringify(absolute));
        const url='data:text/javascript;base64,'+Buffer.from(entry).toString('base64');
        const program = `const {SafetyGuard}=await import(${JSON.stringify(url)}); const hook=(await SafetyGuard({directory:${JSON.stringify(project.projectDir)}}))["tool.execute.before"]; let denied=false; try {await hook({tool:"bash"},{args:{command:"git push --force"}});}catch{denied=true;} if(!denied) process.exit(2); await hook({tool:"bash"},{args:{command:"git status"}});`;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { cwd: root, env: guardEnv, encoding: 'utf8', windowsHide: true });
        if (result.status !== 0) throw new Error('Installed OpenCode guard did not pass deny/allow controls');
      } else {
        const hook = join(project.frameworkDir, engine === 'codex' ? 'core/backends/codex-hook.mjs' : 'hooks/safety-guard.mjs');
        const outputs = ['git push --force', 'git status'].map(command => spawnSync(process.execPath, [hook],
          { cwd: root, env: { ...guardEnv, CLAUDE_PROJECT_DIR: root }, input: JSON.stringify(control(command)), encoding: 'utf8', windowsHide: true }));
        const result = outputs.map(output => { if (output.status !== 0) throw new Error('Guard process failed'); return output.stdout.trim() ? JSON.parse(output.stdout).hookSpecificOutput?.permissionDecision : null; });
        if (result[0] !== 'deny' || result[1] === 'deny') throw new Error('Installed guard did not pass deny/allow controls');
      }
      return 'Force-push denied, git status accepted; commands were never executed';
    });
  }
  if(receipt.delivery?.tools.some(row=>row.status==='pending-user'))check('machine-tools',()=> {
    const machine=doctorUserTools({env});if(!machine.ok)throw new Error(machine.reason||'Machine tool delivery has unsupported formats');
    for(const row of receipt.delivery.tools.filter(row=>row.status==='pending-user'))if(!machine.delivery.tools.some(tool=>tool.id===row.id&&tool.engine===row.engine&&['delivered','reference'].includes(tool.status)))throw new Error('Machine selection does not include '+row.id+' for '+row.engine);
    return 'One independently owned machine toolset verified';
  });
  if (!receipt.delivery || receipt.delivery.tools.some(row=>row.status==='unsupported')) checks.push({ id: 'native-tools', ok: false, reason: 'Native tool delivery contains unsupported formats' });
  checks.push(...inspectMcpPrerequisites(root,receipt.delivery,{env}));
  return { ok: checks.every(entry => entry.ok), framework_version: receipt.framework_version, checks, warnings };
}
