# 0-CODE — an autonomous development loop for Claude Code and OpenCode

> **Version:** v1.20.0 · MIT licence · zero runtime dependencies

Give an AI agent a goal and a roadmap. It plans, writes code, runs tests, commits, and keeps going
across sessions — until the work is done, the budget runs out, or it hits something only a human
can solve.

**This is not a wrapper that runs one prompt.** It is the missing loop: state that survives
restarts, gates that decide when to stop, guards that survive the agent trying to remove them, and
a supervisor that keeps working after the network drops.

```bash
git clone https://github.com/0-SOFT/0-CODE.git

cd my-project
bash /path/to/0-CODE/bootstrap.sh          # Claude Code (default)
bash /path/to/0-CODE/bootstrap.sh --backend opencode   # OpenCode + any OpenRouter model
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
| A turn is spent asleep waiting for a test run | Long jobs are recorded in state; every turn reports whether each is running, overdue, finished or **dead** — in milliseconds, because checking is not waiting |
| A second session in the same project fights the first for the loop | Ownership is proved by something that lives as long as the claimant does; the second session is told who holds the loop and works as an ordinary session |
| The agent takes the first idea that works | A decision record with at least three options, each scored and grounded in a measurement or a named assumption; whether one exists is printed every turn |
| A plan written once is followed for ever | Every so many turns the step instruction is *replaced* by a review of the remaining plan against what the work has since shown |
| "Ready for release" rests on the agent's word | Audit findings become a machine-readable ledger, and `/productionauditloop` runs until P0–P2 reach zero **by that data**, not by declaration |
| A released version's acceptance criteria say nothing | Each one is closed with evidence or declares itself unmet; a guard turns red on a criterion that stays silent |

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

**Three modes, and switching off is explicit.** `SAFETY_GUARD_MODE` picks one:

| Mode | What it does |
|---|---|
| `arbiter` (default) | the hook decides on every call, so no prompt appears anywhere |
| `guard-only` | denies the destructive, stays silent otherwise — ordinary prompts come back |
| `allow-all` | nothing is ever denied, including `rm -rf /` |
| `confirm` | names the consequence and asks the agent to argue for it, instead of refusing |

**The confirm mode** exists because the framework does not know your task and the agent does. A rule
with legitimate uses — a force push, wiping untracked files — is refused with the consequence spelled
out and a way to proceed: re-issue the command with `# safety-guard: confirmed <why this is right
here>`. A throwaway reason is not accepted, and every confirmation is written to the log, so a
decision can be reviewed afterwards rather than merely trusted.

Two things stay out of that bargain. Rules where no task context could make the answer "yes" —
destroying the filesystem, formatting a disk, killing every session — cannot be confirmed at all.
And the mode carries extra rules that exist nowhere else (`git clean`, `git reset --hard`, mounting
the filesystem root into a container): a request to think costs a rewritten command, where a refusal
costs the loop a turn, so this mode can afford to notice more.

A value the guard does not recognise keeps the safe default **and says so**, instead of pretending to
have obeyed: `SAFETY_GUARD_MODE=off` used to look like switching the guard off while the full guard
kept running. The acting mode is written into the decision and into `~/.claude/safety-guard.log`, so
"I turned it off" is something you can check rather than remember.

**Secrets are never blocked.** If a commit picks up a file that looks like key storage, you get one
line in the log and a notification if you configured one. The decision stays yours.

**Still being asked for permission?** An `ask` rule in the settings outranks every mode *and* the
hook's decision, so no toggle can remove that prompt. Find out why, then fix it:

```bash
node tools/doctor-permissions.mjs <project>      # names the cause
node tools/gen-settings.mjs --project <project>  # fixes it, with a backup
```

**What this cannot do**, stated plainly rather than discovered later:

- it will not stop an agent from writing bad code, and it will not protect uncommitted work;
- the command parser is a heuristic, not a shell — exotic quoting can fool it in either direction;
- danger expressed as an argument rather than a command is mostly invisible: `docker run -v /:/host`
  hands a container the whole machine and is only noticed in `confirm` mode;
- a script the agent writes and then runs is one opaque command to the guard;
- four rules can only ever be wrong in four ways, which is the point of keeping the set that small;
- **the Stop hook cannot survive the platform going down** — it lives inside the process that dies,
  so there is no turn to run and nothing to restart it. `core/supervisor.mjs` is an external driver
  and does survive it, retrying transient failures with a growing pause.

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

The framework lives outside the project it drives, so get it first:

```bash
git clone https://github.com/0-SOFT/0-CODE.git
```

Then install it into your project:

```bash
# Linux / macOS
bash /path/to/0-CODE/bootstrap.sh [--backend claude|opencode]

# Windows (PowerShell)
pwsh C:\path\to\0-CODE\bootstrap.ps1
```

Then either start `claude` in the project, or for OpenCode:

```bash
AGENT_BACKEND=opencode node core/supervisor.mjs --state docs/STATE.md
```

---

## Stopping the loop

By default **two** things stop it, and two more are available on request. All four are visible in
`docs/STATE.md`:

- a **blocker** you or the agent wrote into `blockers:`;
- `released_version == current_version` — the roadmap is finished;
- the **iteration cap** (`max_iterations`) — **off unless you set it**;
- the **budget cap** (`budget_metrics.cap_usd`) — **off unless you set it**, and enforced only
  under `core/supervisor.mjs`: nothing fills the spend counter when the Stop hook drives the loop,
  so a cap set there is reported as unenforceable rather than left to look like a guard.

Since v1.9.0 both caps are opt-in. A fresh project has neither, so in practice two things stop it:
a blocker and a finished roadmap. What still makes a runaway visible is the no-progress detector —
three turns that change nothing and the loop writes itself a `no_progress` blocker — and the
silence watchdog, which reports a state file that has stopped changing.

An empty `next_step_prompt` does **not** stop the loop — it means "decide from STATE and ROADMAP".

---

## Documentation

| | |
|---|---|
| [QUICKSTART.md](QUICKSTART.md) | from zero to the first autonomous commit |
| [GUIDELINE.md](GUIDELINE.md) | architecture and mechanics, and why each decision was made |
| [docs/two-modes.md](docs/two-modes.md) | the two ways to drive the loop, side by side: what each can and cannot do |
| [docs/PROVEN.md](docs/PROVEN.md) | what was verified by experiment, with numbers and limits |
| [docs/failure-modes.md](docs/failure-modes.md) | what breaks, how it looks, what to do |
| [STRUCTURE.tree](STRUCTURE.tree) | annotated map of every file |
| [CONTRIBUTING.md](CONTRIBUTING.md) | how to work on this project |
| [SECURITY.md](SECURITY.md) | reporting vulnerabilities |

---

## Tests

```bash
node tests/run.mjs --coverage-min=80    # the whole suite, with the coverage gate over source modules
bash tests/smoke.sh                     # end-to-end checks; a fresh clone announces the ones it skips
```

Both run on Windows and Linux with no external test framework — the project has zero dependencies,
including in its test tooling.

---

## Licence

MIT. See [LICENSE](LICENSE).
