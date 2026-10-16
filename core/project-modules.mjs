// The optional installed files belong to one module. Shared protocol code remains in the core.
import { MODULE_DEFAULTS } from './project-config.mjs';
export const PROJECT_MODULES = Object.freeze({
  audits:{description:'Audit commands and evidence templates',engines:['claude','codex','opencode'],dependencies:[],files:['core/audit-ledger.mjs','core/acceptance.mjs','commands/productionaudit.md','commands/productionauditloop.md','templates/audit_*.md','templates/testing.md']},
  session_logs:{description:'Session transcripts and supervisor attempt journals',engines:['claude','codex','opencode'],dependencies:[],files:['hooks/save-session-log','hooks/save-session-log.mjs','core/session-log.mjs','core/turn-journal.mjs']},
  token_usage:{description:'Plan-share status line and token reports',engines:['claude','codex'],dependencies:['session_logs'],files:['hooks/usage-statusline','hooks/usage-statusline.mjs','lib/token-report.mjs']},
  telegram:{description:'Optional bot notifications from environment credentials',engines:['claude','codex','opencode'],dependencies:[],files:['lib/telegram-notify.sh','lib/telegram-notify.ps1']},
  pm2:{description:'Process-manager launcher for an external supervisor',engines:['codex','opencode'],dependencies:[],files:['ecosystem.json']},
  mcp_catalog:{description:'Secret-free MCP definitions and schema',engines:['claude','codex','opencode'],dependencies:[],files:['config/mcp-manifest.json','config/mcp-manifest.schema.json']},
  toolset:{description:'Curated skills, agents, commands and rules',engines:['claude','codex','opencode'],dependencies:[],files:['toolset/**']},
});
export function enabledProjectModules(config) {
  const enabled=Object.keys(PROJECT_MODULES).filter(id=>config.modules[id]);
  for(const id of enabled) for(const dependency of PROJECT_MODULES[id].dependencies) {
    if(!config.modules[dependency]) throw new Error(`Module ${id} requires ${dependency}`);
  }
  return enabled;
}
export function describeProjectModules() {
  return Object.fromEntries(Object.entries(PROJECT_MODULES).map(([id,module])=>[id,{...module,default:MODULE_DEFAULTS[id]}]));
}
