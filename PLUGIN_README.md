# Installing as a Claude Code plugin

> An alternative to bootstrap: install the framework once, globally, instead of copying it into
> every project.

## Two installation modes

| Mode | When to use it | Where the framework code lives |
|---|---|---|
| **Bootstrap** | A one-off deployment into a specific project | Copied into `<project>/hooks`, `lib`, `core` |
| **Plugin** | You use the framework regularly across several projects | Installed once, projects only carry `docs/STATE.md` and `CLAUDE.md` |

Plugin mode saves disk space and simplifies upgrades: update the plugin once and every project
gets the new version.

## Installing the plugin locally

```bash
claude --plugin-dir /path/to/0-code
```

After that, inside a target project it is enough to create a minimal `docs/STATE.md` and
`CLAUDE.md` (see below).

## Installing from a ZIP archive

```bash
# pack
zip -r 0-code.zip .claude-plugin hooks lib core skills docs/schemas

# install
unzip 0-code.zip -d ~/.claude/plugins/0-code
claude --plugin-dir ~/.claude/plugins/0-code
```

## What the plugin wires up automatically

The manifest `.claude-plugin/plugin.json` declares:

- `hooks/hooks.json` — the `ralph-loop-stop` Stop hook through the polyglot `run-hook.cmd`;
- `skills/orchestrator-wrapper/SKILL.md` — the orchestrator skill.

The plugin loader finds both by itself.

`lib/` and `core/` are not declared as plugin components — they are **used** by the components
above: the Stop hook reads `${CLAUDE_PLUGIN_ROOT}/lib/parse-state.mjs`, imports
`${CLAUDE_PLUGIN_ROOT}/core/gates.mjs`, and so on.

## Minimal initialisation of a target project

### `docs/STATE.md`

```markdown
---
schema_version: 1
project_name: "my-project"
current_stage: 0
current_version: "0.0.1"
previous_version: null
current_prompt_file: null
last_action_at: "2026-01-01T00:00:00Z"
last_action: "initialized"
last_session_id: null
blockers: []
open_findings: []
audit_cycle: null
verification_pending: false
session_count: 0
iteration: 0
max_iterations: 25
attempts_per_task: {}
progress_metrics:
  last_3_sessions_diff_lines: []
  last_3_sessions_test_diff: []
budget_metrics:
  version_cost_usd: 0
  cap_usd: null
framework_version: "1.5.0"
next_step_prompt: "Stage 0. Read the project brief in docs/userdocs/ if it exists, or ask the user to describe the project, then produce docs/ROADMAP.md."
---

# Journal

- 2026-01-01 — initialised in plugin mode.
```

### `CLAUDE.md`

```markdown
# Project: my-project

This project uses the autonomous development framework through a plugin.

@orchestrator-wrapper on every iteration.
```

### Running it

```bash
cd /path/to/my-target-project
claude
```

Give it the first prompt — the orchestrator takes over.

## Bootstrap versus plugin

| | Bootstrap | Plugin |
|---|---|---|
| Disk space per project | about 1 MB (a copy of hooks, lib, core) | almost none (STATE.md plus CLAUDE.md) |
| Upgrading the framework | rerun bootstrap in every project | update the plugin once |
| Host dependencies | Node, bash, jq | Node, bash, jq, plus the installed plugin |
| Deploying to a new machine | copy the repository, run bootstrap.sh | copy the repository, run `claude --plugin-dir` |
| Best for | forking and per-project customisation | plain usage through stable releases |

## Validation

```bash
claude plugin validate /path/to/0-code
```

It should report a valid plugin with no errors.

## If plugin mode does not work

See [docs/failure-modes.md](docs/failure-modes.md) for the general catalogue. Specifically for
plugin mode, check:

1. `claude --version` — it must support `--plugin-dir`;
2. `${CLAUDE_PLUGIN_ROOT}` really expands inside the hook. To verify, add
   `echo "PLUGIN_ROOT=$CLAUDE_PLUGIN_ROOT" >&2` at the top of `ralph-loop-stop`;
3. `node` is available on PATH — the hooks import `lib/*.mjs` and `core/*.mjs`.

## Scope

This covers **local installation** through `--plugin-dir` only. Publishing to a plugin marketplace
is a separate matter.
