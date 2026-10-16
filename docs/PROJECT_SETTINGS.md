# Project settings

`.0-code/config.json` is the single project configuration. Its schema is `.0-code/schemas/config.schema.json`; paths and defaults are read through `core/project-config.mjs`. Missing settings preserve the legacy document layout. Flags override environment, which overrides project settings, which overrides engine preferences. Unspecified model and reasoning effort are inherited from the engine.

This is the single configuration table; other guides reference it.

| Field | Default | Contract |
|---|---|---|
| `schema_version` | `1` | Supported configuration format. |
| `framework_version` | Installed `VERSION` | Set by the installer; `VERSION` is the release number source. |
| `engines` | `["claude"]` | Nonempty unique selection from `claude`, `codex`, `opencode`. |
| `language` | `en` | Language of human cycle artifacts; agent instructions remain English. |
| `documents.state.path` | `docs/STATE.md` | Machine state with YAML frontmatter; existing state is preserved. |
| `documents.roadmap.path` | `docs/ROADMAP.md` | Existing plan and acceptance criteria are preserved. |
| `documents.reports` | `docs/reports`, `<version>_<name>.md` | Report directory and filename pattern. |
| `documents.decisions` | `docs/decisions`, `<version>_<name>.md` | Significant decisions and their grounds. |
| `documents.todo` | `docs/todo`, `<version>_<name>.md` | Machine findings ledgers plus human reasoning. |
| `documents.logs` | `docs/logs`, `<date>_<id>.jsonl` | Transcripts and usage artifacts. |
| `documents.prompts` | `docs/prompts`, `<version>_<name>.md` | Active cycle prompts. |
| `documents.templates` | `docs/prompts/templates`, `<name>.md` | Project templates have priority over built-ins in `.0-code/templates`. |
| `documents.userdocs` | `docs/userdocs`, `<version>_<name>.md` | Owner tasks and project context. |
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

Directory roles accept `path` and `name`; file roles accept `path`. Paths must be project-relative, outside `.git` and `.0-code`, without traversal, links or overlapping roles. Name placeholders are `<version>`, `<name>`, `<date>`, `<id>`. A role directory may be the project root. An existing human document cannot be reused as machine state without the required state structure.

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

Use the public source at `https://github.com/0-SOFT/0-CODE`: `scan`, review `suggestedConfig`, save that chosen object to a temporary file, and supply `--config` to `install` or `upgrade`. Preview with `--dry-run` and explicitly choose user or project toolset scope; user delivery can write native user tool/MCP settings, while project delivery stays in project engine directories. Configuration and documents survive upgrade. The public source supports new installations and upgrades of the `.0-code/` layout. Automatic root-based 1.x migration requires `config/legacy-installations.json`, excluded from the public tree. Only a source containing published ownership evidence may run `migrate`; without evidence, preserve old files and review their ownership before changes.
