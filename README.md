# 0-CODE

**Version:** v2.1.0

An autonomous development cycle for **Claude Code, Codex and OpenCode**, integrated into an existing project. One cycle prompt can contain research, implementation, repairs, audits and release work.

[English](README.md) · [中文](README.zh-CN.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md)

## Integrate with your agent

In your project's agent session, ask: **“Integrate 0-CODE from https://github.com/0-SOFT/0-CODE; follow its `INTEGRATE.md`.”** Use a public source checkout outside the target project, optionally at a chosen release tag. The same [short template](INTEGRATE.md) handles **upgrade** and **uninstall** for all three engines.

The agent scans project documents, tools, MCP and check commands, resolves genuine ambiguities, previews changes, installs, runs doctor and commits in a separate branch. Existing project tools take precedence. [Manual quick start](QUICKSTART.md).

## What is installed

Framework code, configuration, schemas, modules and built-in templates live in **`.0-code/`**. Project-owned cycle documents live in **`.0-code/docs/`**; runtime files and backups live in ignored **`.0-code/run/`**. Engines receive their required native hooks, instructions, compatible tool entries and the OpenCode guard plugin. Existing code and documents are preserved; collisions and changed owned files are reported before writes.

The single configuration reference is [PROJECT_SETTINGS](docs/PROJECT_SETTINGS.md). Choose default documents, override individual roles, or map all roles to existing project conventions. The state remains a machine-readable document. Human documents use the configured language; agent instructions stay in English.

Model, reasoning effort and login belong to the owner. Settings resolve as **explicit flags > environment > project configuration > native engine preferences**. Unspecified model and effort are inherited; authentication is never copied. See [engine settings](docs/ENGINE_SETTINGS.md).

The [public tool catalog](toolset/CATALOG.md) contains **five default MCP servers: context7, playwright, chrome-devtools, sequential-thinking and memory**. They need npm packages at or above the tested SemVer minimum, with the correct package name and entry point; preserve valid newer packages. They require no external API key; browser tools also need an available browser. Registration and a green doctor do not prove a live connection. Private skill, agent, command and rule bodies are excluded. Optional account examples in the MCP manifest stay off until explicitly configured and authorized.

Tools default to **one independent installation per user**, shared across that user's projects. Reinstalling the same selection changes nothing. Use project scope to pin a different selection in a project. Project uninstall leaves machine tools; `uninstall-tools` removes the separately owned machine installation and restores its original native settings. Authentication is never copied. See [configuration and prerequisites](docs/PROJECT_SETTINGS.md).

## Documents, migration and ownership in 2.1.0

New installations place all nine document roles under `.0-code/docs/`: `STATE.md`, `ROADMAP.md`, `reports/`, `decisions/`, `todo/`, `logs/`, `prompts/`, `prompts/templates/` and `userdocs/`. Durable documents belong in Git; session logs are ignored. Logs may instead use `.0-code/run/logs/`; permanent roles cannot use runtime. Explicit external roles remain supported, and ordinary upgrade preserves existing paths. Documents are outside the ownership receipt: doctor accepts them, upgrade preserves them, and uninstall keeps them and their directories while removing runtime and backups.

Relocate standard 2.0.x `docs/*` roles explicitly with `upgrade --relocate-documents <files.json>` or `migrate --relocate-documents <files.json>`, first with `--dry-run`. Review the exact file list; unlisted product documentation stays in place. Configured paths, STATE pointers and selected templates are updated, with original changed bytes archived. Custom external paths stay unchanged. Finish the cycle, collect background jobs and stop the driver before relocation or adoption; a live lock or changed input refuses the plan. Stage the resulting moves in Git to retain rename history.

A customized `.0-code/` installation without a receipt uses `migrate --adopt-manifest <manifest.json>` with reviewed SHA-256 hashes and `replace`/`preserve` actions. Only exact listed project extensions under `bin/`, `claude/` and `.0-code/README.md` may be retained; framework code is replaced and archived. Preserved extensions remain editable and survive upgrade/uninstall. Unknown files or hash mismatches refuse; adoption and relocation are separate operations. Keep custom AGENT rules as a document and reference it through `instructions.project_rules` before replacing the generated guide.

Claude can use `instructions.claude: session-hook` without writing `CLAUDE.md`. Set `instructions.claude_settings: .0-code/claude/settings.json` for a session overlay, preserving launcher, MCP and system-prompt files. Launch with `claude --settings .0-code/claude/settings.json`; ordinary Claude sessions do not load that overlay automatically. Compatible settings keep their policies; foreign Stop/guard hooks require review. Uninstall restores original settings. Doctor verifies local hooks, not user/managed/CLI overrides. See [formats, commands and limits](docs/PROJECT_SETTINGS.md).

Development acceptance for 2.1.0 used Windows and Node 24. It did not cover Linux, macOS or Node 20/22; a configured CI matrix is not evidence of execution. See [validation scope](docs/PROJECT_SETTINGS.md#validation-scope) for filesystem and coverage limits.

## Work and maintain

From an installed project:

```bash
node .0-code/tools/0code.mjs doctor --json
node .0-code/tools/0code.mjs start <cycle-prompt> --max 60
node /path/to/new-source/tools/0code.mjs upgrade --project . --dry-run
node .0-code/tools/0code.mjs uninstall --dry-run
```

Fill the single `.0-code/templates/cycle.md` template. `start` atomically sets the state and prints the chosen driver command. Restart Claude to load new hooks; Codex and OpenCode use the external supervisor. One folder has one active cycle. Iteration and spending limits are opt-in; spending limits require supervisor cost data. Register long jobs in state instead of polling with sleeps.

The public checkout supports new installations and upgrades of the `.0-code/` layout. **Automatic migration of old root-based 1.x installations is unavailable without `config/legacy-installations.json`, which is excluded from the public tree.** Use `migrate --dry-run`, then `migrate`, only with a source containing the published ownership evidence. Only byte-proven framework files and exact owned blocks are removed; documents stay in place and runtime is archived or moved with backups. Finish a live old cycle first; without evidence, preserve the old files and review their ownership before changing them.

[Engine settings](docs/ENGINE_SETTINGS.md) explain precedence and personal login. [Claude setup](CLAUDE_CODE_SETUP.md), [development guide](GUIDELINE.md), and [security](SECURITY.md) explain operation and validation. In the source checkout, run `node tests/run.mjs --coverage-min=80` and `bash tests/smoke.sh`; local results are evidence, and CI availability is separate.
