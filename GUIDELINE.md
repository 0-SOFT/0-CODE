# Development guide

**Framework version:** v2.0.4

0-CODE runs a cycle described by one prompt in an existing project through Claude Code, Codex or OpenCode. Obtain the source from `https://github.com/0-SOFT/0-CODE`. Use [INTEGRATE](INTEGRATE.md) for lifecycle operations and [PROJECT_SETTINGS](docs/PROJECT_SETTINGS.md) for the single configuration contract. In an installed project, framework code lives in `.0-code/`; a source checkout keeps `core/`, `lib/`, `hooks/` and `tools/` at its own root.

The core owns drivers, atomic state, loop gates, progress detection, one-cycle locking, the shared guard, engine adapters and installation lifecycle. Audits, transcripts, usage reports, notifications, PM2, MCP and tools are configurable modules. Dependencies flow through the common configuration reader; document paths are roles. Project inventory and owner tools take precedence. Paths such as `docs/reports`, `docs/todo` and `docs/prompts` describe roles in an installed project; the framework's own private development records are excluded from this distribution.

Claude uses native hooks or the external supervisor; Codex and OpenCode use the supervisor. Run one driver per folder. Model, effort and native login belong to the owner; unspecified choices are inherited, and explicit flags, environment and project configuration override native preferences in that order. See [ENGINE_SETTINGS](docs/ENGINE_SETTINGS.md). Authentication is never copied.

The public catalog delivers only five default MCP: context7, playwright, chrome-devtools, sequential-thinking and memory. Private skill, agent, command and rule bodies are excluded. Choose user or project scope explicitly; user delivery can change native user tool/MCP settings and has separate removal through `uninstall-tools`. npm versions in the manifest are tested SemVer minima: preserve valid newer packages with the correct name and entry point. These five need no external API key; browser tools need a browser. Optional account examples require explicit setup. Doctor checks local prerequisites, not live authorization or connections.

When `session_logs` is enabled, the supervisor writes redacted attempt journals for all three engines into the configured logs role, including failures and retries. Claude hooks also capture native transcripts. Journals do not duplicate token accounting or count as agent progress. Keep logs out of version control.

Stages remain 0 goals, 1 planning, 2 execution, 3 audits, 4 tests. The active prompt defines scope and order. Significant decisions record three viable alternatives, grounds, rejection reasons and a falsifiable outcome. Findings are machine ledgers with explicit coverage; fixed and rejected findings need evidence. Released acceptance criteria must explain their evidence or non-completion.

Update state through `.0-code/lib/update-state.mjs`. A patch moving the version, stage or prompt must include the next task; the writer produces its passport. Register background processes in `running_jobs` with exactly one completion signal: `done_marker` is literal text in the log, `done_file` is a readable result path. Truncate the log or remove the previous result file before launch; files older than `started_at` are ignored. `finished` means collect the result, and `ok=false` still means failure. Inspect completed/dead/overdue results and clear collected records. One active cycle per folder; use separate branches and work folders for independent cycles.

Development checks from the source checkout:

```bash
node tests/run.mjs --coverage-min=80
bash tests/smoke.sh
node tools/gen-ignore.mjs --check
```

The coverage gate measures source lines. Branch percentages are reported separately. The private catalog generator, private corpus and legacy migration evidence checks are excluded from the public source. Smoke explicitly reports the absent private tool-corpus check; public tests do not prove the excluded private workflows. Smoke exercises real isolated lifecycle, ownership, guard and document checks. Tests must use temporary native profiles and never inherit a personal installation destination. Report actual local results and CI availability separately.

New installations and upgrades of the `.0-code/` layout are supported. Automatic migration of root-based 1.x requires `config/legacy-installations.json`, which is excluded from the public source. A source containing published ownership evidence can preview and apply `migrate`; it preserves unknown files and documents, backs up changes and refuses an active old cycle. Without that evidence, preserve old files and review ownership before changes.

Public export is a development-only preflight into a disposable directory outside the source. It excludes owner configuration, reports, prompts, credentials and private stock bodies. Publication and editing a public clone require a separate owner instruction. [SECURITY](SECURITY.md) explains ownership and credentials boundaries.
