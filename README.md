# 0-CODE — an autonomous development loop for Claude Code and OpenCode

> **Version:** v1.6.1 · MIT licence · zero runtime dependencies

Give an AI agent a goal and a roadmap. It plans, writes code, runs tests, commits, and keeps going
across sessions — until the work is done, the budget runs out, or it hits something only a human
can solve.

**This is not a wrapper that runs one prompt.** It is the missing loop: state that survives
restarts, gates that decide when to stop, guards that survive the agent trying to remove them, and
a supervisor that keeps working after the network drops.

```bash
cd my-project
bash /path/to/0-code/bootstrap.sh          # Claude Code (default)
bash /path/to/0-code/bootstrap.sh --backend opencode   # OpenCode + any OpenRouter model
claude                                     # the loop takes over from here
```

---

## What actually happens

```
   goal in docs/ROADMAP.md
            │
            ▼
   ┌────────────────────┐     reads      ┌──────────────────────┐
   │  the agent works   │◄───────────────│  docs/STATE.md       │
   │  (writes, tests,   │                │  where the loop is   │
   │   commits)         │───────────────►│  right now           │
   └─────────┬──────────┘     updates    └──────────────────────┘
             │
             ▼  session ends
   ┌────────────────────┐
   │  the loop driver   │  continue?  → push the agent back to work
   │  decides           │  stop?      → blocker · done · iteration cap · budget cap
   └────────────────────┘
```

Two drivers, same rules: a **Stop hook** for Claude Code (the loop lives inside one process) and an
**external supervisor** for OpenCode (one process per turn). The decision logic is shared —
`core/gates.mjs` — so both behave identically.

---

## Why you might want this

| Problem with a bare agent | What the loop does |
|---|---|
| Loses context and initiative between sessions | State lives in `docs/STATE.md`; a new session picks the loop up where the last one died |
| One network blip kills an unattended run | Transient failures are retried with backoff; real errors stop immediately |
| A wrong model name looks like a server error | A cheap self-check before the loop refuses to start and says exactly what is wrong |
| Spending is discovered after the fact | Cost accumulates in state, and a per-turn guard aborts mid-turn when the cap is passed |
| Two copies race over the same project | A file lock: a live owner refuses the second launch, a dead one is taken over |
| The agent deletes its own guardrails | The guard plugin lives outside the working directory and is restored before every turn |

Every row above exists because it actually happened during development, not because it sounded
prudent. The evidence is in [docs/PROVEN.md](docs/PROVEN.md).

---

## Safety, honestly

Protection is **deliberately minimal**. A measurement showed that a broad rule set blocked 7 out of
11 everyday commands by mistake — and each false refusal costs the loop a turn. A rule is kept only
when the consequence is unrecoverable **and** there is essentially no legitimate use for it in a
development loop:

1. destroying the filesystem — root or the entire home directory;
2. formatting or wiping a disk;
3. mass-killing the agent's own processes by image name — the loop killing itself;
4. `git push --force` — rewriting shared history.

Everything else is allowed. Losses inside a repository are recoverable from git, and autonomy is
worth more than a rule that fires on `git clean`.

**Secrets are never blocked.** If a commit picks up a file that looks like key storage, you get one
line in the log and a notification if you configured one. The decision stays yours.

**What this cannot do:** it will not stop an agent from writing bad code, and it will not protect
uncommitted work. Commit often.

---

## Backends

| | Claude Code | OpenCode |
|---|---|---|
| Loop driver | Stop hook, inside one session | External supervisor, one process per turn |
| Models | Opus / Sonnet / Haiku | Anything on OpenRouter (Kimi, DeepSeek, …) |
| Unattended | yes | yes |
| Guard against irreversible commands | PreToolUse hook | plugin outside the project directory |
| Instructions file | `CLAUDE.md` | `AGENTS.md` |

Choose with `--backend` at install time or `AGENT_BACKEND` at run time.

---

## Requirements

| | |
|---|---|
| Node.js | 18 or newer |
| `claude` | 2.1.118+ (for the Claude Code backend) |
| `opencode` | 1.18+ and an `OPENROUTER_API_KEY` (for the OpenCode backend) |
| Bash | Git for Windows on Windows — the hooks run under bash |
| `jq`, `curl` | JSON parsing in hooks, notifications |

---

## Install

Bootstrap copies `hooks/`, `lib/`, `core/`, `docs/schemas/` and the orchestrator skill into your
project, creates `CLAUDE.md`, `docs/STATE.md` and `docs/ROADMAP.md`, merges `.claude/settings.json`
without touching your own hooks, and writes an installation marker so a second run is a no-op.
(The `templates/` directory is NOT copied into the target project — templates are read from the
framework directory.)

```bash
# Linux / macOS
bash /path/to/0-code/bootstrap.sh [--backend claude|opencode]

# Windows (PowerShell)
pwsh C:\path\to\0-code\bootstrap.ps1
```

Then either start `claude` in the project, or for OpenCode:

```bash
AGENT_BACKEND=opencode node core/supervisor.mjs --state docs/STATE.md
```

---

## Stopping the loop

Exactly four things stop it, and all of them are visible in `docs/STATE.md`:

- a **blocker** you or the agent wrote into `blockers:`;
- `released_version == current_version` — the roadmap is finished;
- the **iteration cap** (`max_iterations`, 25 in a fresh project);
- the **budget cap** (`budget_metrics.cap_usd`).

An empty `next_step_prompt` does **not** stop the loop — it means "decide from STATE and ROADMAP".

---

## Documentation

| | |
|---|---|
| [QUICKSTART.md](QUICKSTART.md) | from zero to the first autonomous commit |
| [GUIDELINE.md](GUIDELINE.md) | architecture and mechanics, and why each decision was made |
| [docs/PROVEN.md](docs/PROVEN.md) | what was verified by experiment, with numbers and limits |
| [docs/failure-modes.md](docs/failure-modes.md) | what breaks, how it looks, what to do |
| [STRUCTURE.tree](STRUCTURE.tree) | annotated map of every file |
| [CONTRIBUTING.md](CONTRIBUTING.md) | how to work on this project |
| [SECURITY.md](SECURITY.md) | reporting vulnerabilities |

---

## Tests

```bash
node tests/run.mjs --coverage-min=80    # 234 tests, coverage gate over source modules
bash tests/smoke.sh                     # 111 end-to-end checks, plus 6 skipped aloud
```

Both run on Windows and Linux with no external test framework — the project has zero dependencies,
including in its test tooling.

---

## Licence

MIT. See [LICENSE](LICENSE).
