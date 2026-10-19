# Quick start — 2.1.0

Install Node.js 20 or newer, Git and the selected CLI: Claude Code, Codex or OpenCode. Development acceptance for 2.1.0 used Windows and Node 24; it did not cover Linux, macOS or Node 20/22. The minimum Node version and configured CI matrix do not establish execution results. See [validation scope](docs/PROJECT_SETTINGS.md#validation-scope). Log in through the engine's normal mechanism. [INTEGRATE](INTEGRATE.md) gives the agent workflow; [PROJECT_SETTINGS](docs/PROJECT_SETTINGS.md) defines project options, and [ENGINE_SETTINGS](docs/ENGINE_SETTINGS.md) explains owner preferences.

Obtain the public source outside your target project:

```bash
git clone https://github.com/0-SOFT/0-CODE.git
cd 0-CODE
node tools/0code.mjs scan --project /path/to/project --json
```

Optionally check out a chosen release tag. Review the scan, create a separate branch in the target project, and save only its `suggestedConfig` object to a temporary JSON file, for example `/path/to/settings.json`. Choose `engines`, document roles, language and modules. Explicitly choose `toolset.scope`: the default `user` shares one installation across the user's projects and can write native tools/MCP settings under `~/.claude`, `~/.codex` and OpenCode's user config. `project` keeps the source selection and native delivery in the project. To avoid installing tools, disable `modules.toolset`.

The public toolset contains five MCP definitions: `context7`, `playwright`, `chrome-devtools`, `sequential-thinking` and `memory`. Private skill, agent, command and rule bodies are excluded. Check the npm prerequisites in the settings guide before installing; keep valid newer versions with the correct name and entry point. Install only missing or older packages in the chosen scope. These five need no external API key; browser tools need an available browser. Optional account examples remain off until explicitly configured and authorized.

Preview and apply the reviewed configuration from the source checkout:

```bash
node tools/0code.mjs install --project /path/to/project --config /path/to/settings.json --dry-run
node tools/0code.mjs install --project /path/to/project --config /path/to/settings.json
```

Bash `bootstrap.sh` and PowerShell `bootstrap.ps1` pass the same arguments to `install`. Conflicts refuse before writing. Framework files live in `.0-code/`; all nine new document roles default to `.0-code/docs/` (STATE, ROADMAP, reports, decisions, todo, logs, prompts, prompt templates and userdocs). Durable cycle documents are project-owned and should be committed; logs and `.0-code/run/` are ignored. Existing external roles remain valid. When committing the installation, run `git add --renormalize .0-code` before staging the completed changes. Never stage ignored runtime backups.

For Claude without an owned block in `CLAUDE.md`, choose `instructions.claude: session-hook`. The default hook settings location is `.claude/settings.json`; choose `instructions.claude_settings: .0-code/claude/settings.json` for a session overlay and launch with `claude --settings .0-code/claude/settings.json`. Ordinary sessions do not load that overlay automatically. Native SessionStart/SubagentStart hooks load `.0-code/AGENT.md`; hooks must remain enabled. A previous owned `CLAUDE.md` block requires uninstall in `project-file` mode before reinstalling with the saved configuration. See [settings and constraints](docs/PROJECT_SETTINGS.md).

From the target project:

```bash
node .0-code/tools/0code.mjs doctor --json
node .0-code/tools/0code.mjs start <your-cycle-prompt> --max 60
```

Fill `.0-code/templates/cycle.md` with version, goals, branch, boundaries, ordered tasks and acceptance checks, then save it at your project's configured prompt role. `start` reads its frontmatter, atomically sets state and prints the driver command; it does not invoke a model. Follow that command: Codex and OpenCode use the external supervisor, while Claude reloads hooks after a session restart and uses the Stop driver. An external supervisor is also available for Claude. Run only one driver per folder.

Model, effort and login belong to the owner. Unspecified model and effort are inherited; precedence is explicit flags, environment, project configuration, then native engine preferences. Authentication is never copied. Without `--max`, iteration limits are absent. Cost limits require supervisor cost data; interactive hooks cannot measure that cost. A blocker or matching current/released version stops the cycle. Register long external work in `running_jobs` and inspect its status on the next turn.

Upgrade a `.0-code/` installation with `node <new-source>/tools/0code.mjs upgrade --project . --dry-run`, then apply. Upgrade keeps existing document paths. To move standard 2.0.x `docs/*` cycle roles, first finish the cycle, collect jobs and stop the driver. Save a reviewed JSON manifest listing exact cycle files, including existing STATE/ROADMAP and templates needing pointer updates; leave product documents out. From the new source:

```bash
node tools/0code.mjs upgrade --project /path/to/project --relocate-documents /path/to/files.json --dry-run
node tools/0code.mjs upgrade --project /path/to/project --relocate-documents /path/to/files.json
```

Configured standard roles move inside, custom external roles remain, and unlisted product files stay in place. STATE pointers and selected templates are rewritten with original changed bytes archived. Stage deletions and additions together so Git can recognize renames. A customized installation without a receipt instead uses `migrate --config <reviewed-config.json> --adopt-manifest <manifest.json> --dry-run`, then applies that plan. Adoption preserves exact reviewed `bin/`, `claude/` and README extensions and archives replaced code; it cannot relocate documents in the same operation. Preserve custom AGENT rules in a document referenced by `instructions.project_rules`. Both manifest formats and complete examples are in [PROJECT_SETTINGS](docs/PROJECT_SETTINGS.md).

**Automatic migration of old root-based 1.x is separate and requires `config/legacy-installations.json`, excluded from the public tree.** Only a source with published ownership evidence may use that migration after stopping the old cycle. Without evidence, preserve old files and review their ownership before changes.

Remove with `node .0-code/tools/0code.mjs uninstall --dry-run`, then apply. Documents, their directories and adopted extensions remain; original session settings are restored. Runtime and its archives are removed, so export any needed backups first. Reinstalling over retained extensions requires explicit adoption. Independent user tools remain; `uninstall-tools` removes those tools separately and restores their owned native settings. Shared npm packages remain. Doctor accepts internal documents and verifies local ownership, hooks and prerequisites without proving a live MCP connection or all user/managed/CLI overrides. Check the project's real tests before declaring integration complete.
