# Project settings

`.0-code/config.json` is the single project configuration for 2.1.0. Its schema is `.0-code/schemas/config.schema.json`; paths and defaults are read through `core/project-config.mjs`. New installations default to internal cycle documents. Existing configured paths survive upgrade; historical source trees and projects without a configuration retain the legacy document fallback when read. Flags override environment, which overrides project settings, which overrides engine preferences. Unspecified model and reasoning effort are inherited from the engine.

### Validation scope

Development acceptance for 2.1.0 was completed locally on Windows with Node 24. Linux, macOS and Node 20/22 were not covered by that acceptance. Node 20 is the minimum prerequisite; a configured CI matrix does not prove execution or compatibility on every listed platform.

Native symlink checks were unavailable on the validation filesystem. A zero skipped-test count does not mean those conditional checks ran. The acceptance enforced at least 80% line coverage per measured source module; branch coverage was measured without a pass threshold. A green doctor verifies local ownership, hooks and prerequisites, not a live model turn, a live MCP connection or every native settings override.

### Configuration reference

This is the single configuration table; other guides reference it.

| Field | Default | Contract |
|---|---|---|
| `schema_version` | `1` | Supported configuration format. |
| `framework_version` | Installed `VERSION` | Set by the installer; `VERSION` is the release number source. |
| `engines` | `["claude"]` | Nonempty unique selection from `claude`, `codex`, `opencode`. |
| `language` | `en` | Language of human cycle artifacts; agent instructions remain English. |
| `instructions.claude` | `project-file` | `project-file` adds an owned `CLAUDE.md` block for Claude; `session-hook` loads `.0-code/AGENT.md` through native context hooks and never writes `CLAUDE.md`. |
| `instructions.claude_settings` | `.claude/settings.json` | Alternatively `.0-code/claude/settings.json`, requiring Claude and `session-hook`; explicitly load that session overlay. |
| `instructions.project_rules` | Absent | Unique project-relative document paths read from the generated AGENT guide; files must exist and cannot address framework code or runtime. |
| `documents.state.path` | `.0-code/docs/STATE.md` | Machine state with YAML frontmatter; existing state is preserved. |
| `documents.roadmap.path` | `.0-code/docs/ROADMAP.md` | Existing plan and acceptance criteria are preserved. |
| `documents.reports` | `.0-code/docs/reports`, `<version>_<name>.md` | Report directory and filename pattern. |
| `documents.decisions` | `.0-code/docs/decisions`, `<version>_<name>.md` | Significant decisions and their grounds. |
| `documents.todo` | `.0-code/docs/todo`, `<version>_<name>.md` | Machine findings ledgers plus human reasoning. |
| `documents.logs` | `.0-code/docs/logs`, `<date>_<id>.jsonl` | Ignored transcripts and usage artifacts; `.0-code/run/logs/` is also allowed. |
| `documents.prompts` | `.0-code/docs/prompts`, `<version>_<name>.md` | Active cycle prompts. |
| `documents.templates` | `.0-code/docs/prompts/templates`, `<name>.md` | Project templates have priority over built-ins in `.0-code/templates`. |
| `documents.userdocs` | `.0-code/docs/userdocs`, `<version>_<name>.md` | Owner tasks and project context. |
| `modules.audits` | `true` | Audit commands, templates and evidence checks. |
| `modules.session_logs` | `true` | Supervisor attempt journals for all three engines; Claude hook transcripts and summaries. |
| `modules.token_usage` | `true` | Usage status line and reports; requires `session_logs`. |
| `modules.telegram` | `false` | Optional notifications using environment bot credentials. |
| `modules.pm2` | `false` | Launcher for an external Codex/OpenCode supervisor; requires PM2 separately. |
| `modules.mcp_catalog` | `true` | Secret-free MCP source definitions and schema. |
| `modules.toolset` | `true` | Selected catalog entries; public distribution contains five default MCP only. |
| `toolset.scope` | `user` | One shared user installation, or `project` to pin a project selection. |
| `toolset.defaults` | `true` | Select catalog entries classified as default. |
| `toolset.enable` / `disable` | `[]` | Catalog IDs such as `mcp/context7`; unavailable and removed IDs cannot be enabled. |
| `guard.mode` | `arbiter` | `arbiter`, `guard-only`, `confirm`, `allow-all`; see the engine guide. |
| `engine_settings.<engine>` | Engine preferences | Optional model, effort, timeout, idle timeout, retry and engine-specific overrides described below. |
| `inventory` | Scanner result | Installer-maintained project documents, tools, MCP, checks and ownership evidence; scan does not write. |

Directory roles accept `path` and `name`; file roles accept `path`. Paths must be project-relative, outside `.git` and framework code, without traversal, links or conflicting roles. `.0-code/docs/` is the document zone; only `logs` may instead use `.0-code/run/logs/` or a descendant. Permanent roles cannot use runtime. Explicit external paths such as `work/status.md` remain supported; changing paths in config alone does not move files. Name placeholders are `<version>`, `<name>`, `<date>`, `<id>`. A role directory may be the project root. An existing human document cannot be reused as machine state without the required state structure.

### Ownership and lifecycle

| Zone or entry | Owner and behavior |
|---|---|
| Installed code, schemas, built-in templates, config and generated `.0-code/AGENT.md` | Receipt-managed framework files. Upgrade checks ownership before replacing them; changed owned bytes require review. |
| `.0-code/docs/` and explicitly configured external cycle documents | Project-owned, outside the installation receipt. Doctor accepts the internal zone; upgrade never overwrites or removes its documents. Uninstall retains documents and directories, including empty directories. Commit durable documents. |
| `.0-code/run/` | Ignored runtime, transaction journals and migration/adoption archives. Uninstall removes this zone and its backups; save needed archives outside it beforehand. |
| Session logs | Ignored under the configured log role. Internal logs are isolated from durable roles and excluded from Git; legacy tracked logs require the project's own review before untracking. |
| Adopted exact `.0-code/bin/*`, `.0-code/claude/*`, `.0-code/README.md` entries | Retained project extensions recorded separately from replaceable code. They survive upgrade/uninstall and may be edited, while framework-owned native settings entries remain checked. Unknown neighboring code files still refuse. |
| Native instruction blocks, hook settings, tool registrations and OpenCode plugin | Minimal engine-discovered integration, limited to selected engines. Uninstall removes owned additions and restores original settings; project-owned values remain. Machine tools have their own receipt and separate uninstall command. |

### Explicit relocation of standard 2.0.x documents

Ordinary upgrade preserves configured paths. To relocate standard external roles (`docs/STATE.md`, `docs/ROADMAP.md`, `docs/reports`, `docs/decisions`, `docs/todo`, `docs/logs`, `docs/prompts`, `docs/prompts/templates`, `docs/userdocs`) to the corresponding `.0-code/docs/` paths, first finish the cycle, collect all `running_jobs` and stop the driver. An untouched initial state or a finished state with matching current/released version is required; merely stopping the process is insufficient. Live locks and child processes refuse. Save a commit or backup first.

Create a reviewed JSON file outside the installation, for example `/path/to/files.json`. List exact existing cycle files, never a directory or a product document. This example assumes each listed file exists; adapt it to the project:

```json
{
  "schema_version": 1,
  "files": [
    "docs/STATE.md",
    "docs/ROADMAP.md",
    "docs/reports/1.0.0_result.md",
    "docs/prompts/1.0.0_cycle.md",
    "docs/prompts/templates/cycle.md"
  ]
}
```

From the new source checkout, preview and then apply the same manifest:

```bash
node tools/0code.mjs upgrade --project /path/to/project --relocate-documents /path/to/files.json --dry-run
node tools/0code.mjs upgrade --project /path/to/project --relocate-documents /path/to/files.json
node tools/0code.mjs doctor --project /path/to/project --json
```

`migrate` accepts the same flag when its installation migration is applicable. A role still at its standard legacy path switches to the internal default only when the manifest selects at least one of its files. Roles without selected files keep their existing paths, including external `userdocs`; custom external roles remain. The file list authorizes individual moves, not ownership of an entire directory. Existing STATE and ROADMAP must be included when their roles move. STATE or template files needing reference updates must also be selected, even if their custom role stays external. Unlisted files, including product documentation in a shared `docs/`, remain byte-for-byte in place. Review the preview's preserved-file list and add every cycle file you intend to move.

STATE `current_prompt_file`, `next_step_prompt` and its metadata pointer, plus selected template references, follow mapped paths. Other document contents remain unchanged. Original bytes of rewritten files and the operation index are archived in `.0-code/run/document-migration/`; arbitrary prose links are not globally rewritten. Destination collisions, ambiguous shared roles, unsupported pointer syntax and inputs changed between plan and apply refuse. Reapplying the same manifest is idempotent while the recorded migration evidence and resulting files remain intact. Stage deletions and additions together; Git can recognize unchanged files as renames without a separate `git mv` step.

### Adopting a customized installation without a receipt

This is separate from relocation and from historical root-based 1.x migration. Use a reviewed new source checkout, never the modified installed CLI. Finish the cycle, collect jobs, stop drivers and save a backup first. Existing config and document roles must be readable and retained. A normal installation with an ownership receipt uses upgrade; do not delete a receipt to bypass modified-code checks.

Review every ordinary file in `.0-code/` outside `docs/` and `run/`. The adoption manifest must list each such file exactly once; the receipt path itself is forbidden. Compute each file's SHA-256, for example:

```bash
node -e "const fs=require('node:fs'),c=require('node:crypto');console.log(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" /path/to/project/.0-code/core/project-config.mjs
```

Save `/path/to/adoption.json` with this shape. The following is an abbreviated structural example: replace hash placeholders with measured 64-character lowercase hex digests and include every reviewed file, including config and AGENT:

```json
{
  "schema_version": 1,
  "files": [
    {"path": ".0-code/core/project-config.mjs", "sha256": "<measured-sha256>", "action": "replace"},
    {"path": ".0-code/bin/0code", "sha256": "<measured-sha256>", "action": "preserve"},
    {"path": ".0-code/claude/settings.json", "sha256": "<measured-sha256>", "action": "preserve"}
  ]
}
```

`replace` authorizes replacement of those exact old bytes with the new distribution. It cannot retain modified framework code. `preserve` is limited to exact project extensions under `.0-code/bin/`, `.0-code/claude/` and `.0-code/README.md`; extensions cannot be marked `replace`. Documents/runtime cannot authorize replacement, and no external path is allowed in this manifest. Unknown files, links, duplicate paths, mismatched hashes, changed inputs or a live cycle refuse. `--adopt-manifest` and `--relocate-documents` cannot be combined.

Preserve custom rules from the old `.0-code/AGENT.md` as a durable project document, for example `.0-code/docs/adopted/AGENT.md`, compare its bytes, and reference it through `instructions.project_rules`. The generated guide and upgrade retain that reference; an archive alone would not keep rules active. Make a reviewed copy of the old config outside the installation, retain all document roles, language, modules, guard, engine settings and custom checks, and add the needed instruction settings. For a retained Claude session launcher:

```json
{
  "instructions": {
    "claude": "session-hook",
    "claude_settings": ".0-code/claude/settings.json",
    "project_rules": [".0-code/docs/adopted/AGENT.md"]
  }
}
```

Merge this fragment into the saved full config; do not replace the full config with it. Review `inventory.tools` against the actual tree using scan. Missing or unsupported tools remain diagnostic failures until resolved; keep the original inventory in the backup, and preserve custom checks. Then use the new source:

```bash
node tools/0code.mjs migrate --project /path/to/project --config /path/to/reviewed-config.json --adopt-manifest /path/to/adoption.json --dry-run
node tools/0code.mjs migrate --project /path/to/project --config /path/to/reviewed-config.json --adopt-manifest /path/to/adoption.json
node tools/0code.mjs upgrade --project /path/to/project --dry-run
node tools/0code.mjs doctor --project /path/to/project --json
```

All replaced originals, including config and AGENT, are archived under `.0-code/run/adoption/` with `index.json`. Retained bin, MCP, system-prompt and README bytes stay in place. Compatible session settings preserve deny, env, MCP choices and native hook/status policies while adding missing framework entries. Foreign Stop/guard hooks or an incompatible status line require a separate integration decision; adoption does not waive those checks. Uninstall preserves documents and retained extensions, restores original session settings and removes runtime archives. After uninstall, remaining extensions require another explicit adoption before installation. Commit the accepted installation before creating a new worktree.

Common engine overrides are `model`, `effort`, `timeoutMs`, `idleTimeoutMs`, `networkRetries`. Claude also accepts `strictMcp`, `permissionMode`; Codex accepts `sandbox`, `homeMode`, `homeDir`, `instructionsMaxBytes`, `strictVersion`, `config`. Operational defaults: idle 99 minutes, turn 9999 hours, retries without a framework cap. `0` milliseconds disables that timeout. Model and effort have no framework default. See [ENGINE_SETTINGS](ENGINE_SETTINGS.md) for environment variables and native behavior.

For a minimal core installation, disable every module. Disabling session logs also requires disabling token usage. Enabling toolset MCP requires `mcp_catalog`; source definitions keep placeholders and resolve secrets only at launch. A tool with the same native name already owned by the project overrides the corresponding stock tool. Format compatibility and unsupported fields are reported in the delivery receipt.

The public [tool catalog](../toolset/CATALOG.md) contains five default MCP definitions. Private skill, agent, command and rule bodies are excluded. The [example manifest](../config/mcp-manifest.example.json) gives their tested npm versions and entry points:

| MCP | npm package | Tested SemVer minimum |
|---|---|---|
| context7 | `@upstash/context7-mcp` | `4.0.2` |
| playwright | `@playwright/mcp` | `0.0.79` |
| chrome-devtools | `chrome-devtools-mcp` | `1.7.0` |
| sequential-thinking | `@modelcontextprotocol/server-sequential-thinking` | `2026.7.4` |
| memory | `@modelcontextprotocol/server-memory` | `2026.7.4` |

The manifest is authoritative. Doctor accepts valid SemVer at or above the tested minimum, including the SemVer ordering of prereleases, and separately checks package name and entry point. Preserve a valid newer package; install only absent or older prerequisites in the chosen scope, for example `npm install -g @upstash/context7-mcp@4.0.2` when that package is absent or older. A malformed version, wrong name or missing entry needs review rather than a blind downgrade. `npm root -g` locates packages; `NPM_GLOBAL_ROOT` explicitly overrides it, including for an isolated package directory. Toolset scope controls framework delivery, not npm's global destination. These five need no external API key; browser-dependent MCP also requires an available browser. Native registrations and package presence do not prove a live connection or account authorization. Doctor checks local prerequisites without launching a model or contacting an account. Optional account examples require explicit configuration, their documented environment/setup and authorization; they remain off by default. Uninstalling 0-CODE does not remove shared npm packages.

User tools are stored under `ZERO_CODE_USER_DIR` or `~/.local/share/0-code`. Native locations respect `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_CONFIG_HOME`. The machine receipt records one engine set and those locations. To change that engine set or its locations, remove the owned machine installation under the original environment first. No project registry or version store is maintained. A changed owned file refuses removal; unrelated native settings are preserved.

### Claude instructions without editing CLAUDE.md

Set `"instructions": {"claude": "session-hook"}` in the configuration passed to `install` or `upgrade`. The framework instruction remains in `.0-code/AGENT.md`. By default `.claude/settings.json` adds `SessionStart` and `SubagentStart` command hooks for normal project sessions. Alternatively set `instructions.claude_settings` to `.0-code/claude/settings.json`, which requires Claude and `session-hook`. Launch with `claude --settings .0-code/claude/settings.json`, the framework supervisor, or a reviewed retained launcher that passes this overlay. Ordinary Claude sessions do not load the internal overlay automatically, and project `.claude/settings.json` is not changed by that overlay integration. Restart the session after installation. Startup, resume, clear and compaction reload the context. The project's own `CLAUDE.md` remains available to Claude through its normal discovery.

This mode never creates, edits or removes `CLAUDE.md`, including during uninstall. An upgrade or migration that would need to remove a previous owned `CLAUDE.md` block refuses before writes. Save the current config outside `.0-code`, uninstall under `project-file` mode to restore the original instruction bytes, and reinstall with the saved config plus `session-hook`. Cycle documents are preserved by uninstall. A custom legacy installation without ownership evidence still requires a reviewed migration.

Document roles, computed filenames and explicit supervisor/state-updater targets cannot address the root `CLAUDE.md` in this mode, including case aliases. Other explicitly configured external document roles remain supported.

Hooks must remain enabled: `--bare`, safe mode, user or managed hook restrictions, CLI overrides and `disableAllHooks` can prevent delivery. Doctor checks registered wrappers, their output and project/local `disableAllHooks`; it does not claim to evaluate user, managed or CLI overrides. See the [Claude hook reference](https://code.claude.com/docs/en/hooks#sessionstart). The default `project-file` mode remains suitable when normal instruction discovery is preferred.

Root instruction blocks follow selected engines: `CLAUDE.md` for Claude in `project-file` mode, `AGENTS.md` for Codex/OpenCode. Native skills, commands, agents, rule pointers, hook settings, OpenCode's plugin entry and MCP registrations remain in engine-discovered locations. Their source bodies stay inside `.0-code`; a project toolset avoids machine writes, while user scope explicitly selects a shared machine installation.

Background jobs belong to the configured state document's `running_jobs` array. Record `id`, `pid`, `log`, `started_at`, `expect_by` and exactly one completion signal: `done_marker` is literal text in `log`; `done_file` is a readable regular result file, absolute or relative to the project. Windows path resolution preserves UNC roots; POSIX backslashes remain filename characters. Truncate each log or remove the old result file before launch; result files older than `started_at` are ignored. A completion signal takes precedence over PID liveness, but `finished` never asserts success: read the log/result and preserve an `ok=false` outcome. Supplying both signals or a non-string value is diagnosed without stopping the driver.

Use the public source at `https://github.com/0-SOFT/0-CODE`: `scan`, review `suggestedConfig`, save that chosen object to a temporary file, and supply `--config` to `install` or `upgrade`. Preview with `--dry-run` and explicitly choose user or project toolset scope; user delivery can write native user tool/MCP settings, while project delivery stays in project engine directories. Configuration and documents survive upgrade. The public source supports new installations, upgrades, explicit relocation and manifest adoption of the `.0-code/` layout. Automatic root-based 1.x migration requires `config/legacy-installations.json`, excluded from the public tree. Only that historical migration requires a source with published ownership evidence; without it, preserve old root files and review their ownership before changes.
