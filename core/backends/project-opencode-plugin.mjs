// Portable project entrypoint; the external supervisor retains its independent host snapshot.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadProjectConfig } from '../project-config.mjs';
import { decidePermission, guardAuditRecord, resolveMode } from '../permission-decision.mjs';
export const PROJECT_PLUGIN_PATH='.opencode/plugins/0-code-safety-guard.js';
export const PROJECT_PLUGIN_ENTRY='export { SafetyGuard } from "../../.0-code/core/backends/project-opencode-plugin.mjs";\n';

export const SafetyGuard=async ({directory,worktree}={})=>{
  const project=loadProjectConfig({projectDir:directory||worktree||process.cwd()});
  return {'tool.execute.before':async (input,output)=>{
    const command=output?.args?.command||output?.args?.cmd;if(!command) return;
    const report=resolveMode(project.guardEnvironment);
    if(!report.recognised) console.error(`safety-guard: unknown mode; using ${report.mode}`);
    const event={tool_name:input?.tool||'Bash',tool_input:{command:String(command)}};
    const result=decidePermission(event,report),verdict=result?.hookSpecificOutput;
    try {
      const entry=guardAuditRecord(event,result,report);
      if(entry) {const file=project.runtimePath('guard.log');mkdirSync(dirname(file),{recursive:true});appendFileSync(file,JSON.stringify(entry)+'\n');}
    } catch { /* an unavailable audit log cannot change enforcement */ }
    if(verdict?.permissionDecision==='deny') throw new Error(verdict.permissionDecisionReason);
  }};
};
