// core/backends/Backend.mjs — the execution backend contract (a port, Dependency Inversion).
//
// v0.8.0, Phase 1. The core (supervisor and gates) depends on THIS interface, not on a concrete
// CLI. Adapters: backends/claude.mjs (Claude Code/CLI), backends/opencode.mjs (OpenCode/OpenRouter).
//
// The base class defines the shape and forces an adapter to implement every method — so a missing
// piece surfaces as an explicit error instead of a silent failure. Each method documents its
// input/output contract.

export class Backend {
  /** @type {string} stable backend identifier ('claude' | 'opencode') */
  get id() { throw new Error('Backend.id must be overridden'); }

  /**
   * Run one agent "turn" (one task taken from next_step_prompt).
   * Headless execution options (v1.1.0; an adapter may ignore the ones that do not apply):
   *   permissionMode — permission mode ('bypassPermissions' by default for claude; 'none' to omit);
   *   strictMcp      — do not load project MCP servers (default true for claude);
   *   maxBudgetUsd   — spending guard for a single turn.
   * @param {{prompt:string, cwd?:string, model?:string, permissionMode?:string, strictMcp?:boolean, maxBudgetUsd?:number}} _opts
   * @returns {Promise<{ok:boolean, output:string, sessionId?:string, costUsd?:number, raw?:any, error?:string}>}
   */
  async runTurn(_opts) { throw new Error(`${this.id}: runTurn() not implemented`); }

  /**
   * Register MCP servers from the secret-free manifest (config/mcp-manifest.json), substituting
   * values from env (.env). Non-portable servers or ones needing setup are skipped with a note.
   * @param {object} _manifest @param {Record<string,string>} _env
   * @returns {Promise<{registered:string[], skipped:string[]}>}
   */
  async registerMcp(_manifest, _env) { throw new Error(`${this.id}: registerMcp() not implemented`); }

  /**
   * Install the agent instructions for a target project from a single source.
   * Claude → CLAUDE.md; OpenCode → AGENTS.md.
   * @param {{targetDir:string, content:string}} _opts
   * @returns {Promise<{written:string[]}>}
   */
  async installInstructions(_opts) { throw new Error(`${this.id}: installInstructions() not implemented`); }

  /**
   * Apply the permission policy (no prompts plus destructive-command blocking) using whatever
   * mechanism the backend provides.
   * Claude → settings.json allow/deny; OpenCode → the permission block in opencode.json.
   * @param {{policy:object, targetDir?:string}} _opts
   * @returns {Promise<{applied:boolean}>}
   */
  async applyPermissions(_opts) { throw new Error(`${this.id}: applyPermissions() not implemented`); }

  /**
   * Restore the backend's scaffolding in the working directory before a turn (v1.3.0).
   *
   * WHY: during the v1.3.0 acceptance run the agent executed `git clean -fd .` — a legitimate
   * cleanup that also wiped untracked files: the permission configuration and THE GUARD PLUGIN
   * ITSELF. Protection that an ordinary command can silently remove is not protection. So the
   * supervisor gives the backend a chance to restore its environment before every turn.
   *
   * Does nothing by default (for Claude Code the scaffolding lives in the project settings).
   * @returns {Promise<{restored: string[]}>}
   */
  async ensureReady(_opts) { return { restored: [] }; }

  /**
   * Cross-platform pre-check of a command for destructiveness (shared by all backends).
   * Returns the reason for blocking, or null. The rules come from core/safety.mjs.
   * @param {string} command @returns {string|null}
   */
  guardCommand(_command) { throw new Error(`${this.id}: guardCommand() not implemented`); }
}
