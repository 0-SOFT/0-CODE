# Quick start

Install Node.js 20 or newer, Git and the selected CLI: Claude Code, Codex or OpenCode. Node 24 is used for the current coverage checks. Log in through the engine's normal mechanism. [INTEGRATE](INTEGRATE.md) gives the agent workflow; [PROJECT_SETTINGS](docs/PROJECT_SETTINGS.md) defines project options, and [ENGINE_SETTINGS](docs/ENGINE_SETTINGS.md) explains owner preferences.

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

Bash `bootstrap.sh` and PowerShell `bootstrap.ps1` pass the same arguments to `install`. Conflicts refuse before writing. Framework files live in `.0-code/`; existing project code, tools and documents retain priority. When committing the installation, run `git add --renormalize .0-code` before staging the completed changes. Never stage ignored runtime backups.

From the target project:

```bash
node .0-code/tools/0code.mjs doctor --json
node .0-code/tools/0code.mjs start <your-cycle-prompt> --max 60
```

Fill `.0-code/templates/cycle.md` with version, goals, branch, boundaries, ordered tasks and acceptance checks, then save it at your project's configured prompt role. `start` reads its frontmatter, atomically sets state and prints the driver command; it does not invoke a model. Follow that command: Codex and OpenCode use the external supervisor, while Claude reloads hooks after a session restart and uses the Stop driver. An external supervisor is also available for Claude. Run only one driver per folder.

Model, effort and login belong to the owner. Unspecified model and effort are inherited; precedence is explicit flags, environment, project configuration, then native engine preferences. Authentication is never copied. Without `--max`, iteration limits are absent. Cost limits require supervisor cost data; interactive hooks cannot measure that cost. A blocker or matching current/released version stops the cycle. Register long external work in `running_jobs` and inspect its status on the next turn.

Upgrade a `.0-code/` installation with `node <new-source>/tools/0code.mjs upgrade --project . --dry-run`, then apply. **The public source cannot automatically migrate old root-based 1.x without `config/legacy-installations.json`, which is excluded.** Only a source with published ownership evidence may use `migrate --dry-run`, then `migrate`, after stopping the old cycle. Without evidence, preserve old files and review their ownership before changes.

Remove with `node .0-code/tools/0code.mjs uninstall --dry-run`, then apply. Documents and independent user tools remain; `uninstall-tools` removes those tools separately and restores their owned native settings. Shared npm packages remain. Doctor verifies local installation and prerequisites without proving a live MCP connection. Check the project's real tests before declaring integration complete.
