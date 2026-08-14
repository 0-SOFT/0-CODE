# Project: __PROJECT_NAME__

This project is managed by the **Claude Code Autonomous Framework** v__FRAMEWORK_VERSION__.

## Loop

A continuous autonomous Ralph Loop:

- The project state lives in `docs/STATE.md` (YAML frontmatter plus a journal).
- The roadmap lives in `docs/ROADMAP.md` (a sequence of versions with acceptance criteria).
- On every natural stop, `hooks/ralph-loop-stop` decides whether to continue the loop (via
  `decision:block`) or end the session (a blocker, the released version, or a cap).

## Orchestration

Use the `@orchestrator-wrapper` skill on each iteration to:

1. Read `docs/STATE.md` and `docs/ROADMAP.md`.
2. Identify the current stage (0 = goal-setting, 1 = planning, 2 = execution, 3 = audits,
   4 = testing) and the next concrete step.
3. Execute one iteration of work (write code, write prompts, run tests).
4. Update STATE.md atomically via `lib/update-state.mjs`.
5. Stop normally — the Stop hook handles loop continuation.

> **Required tools.** Declare the MCP servers you need in `docs/STATE.md` → `required_tools: [...]`.
> During planning the orchestrator performs a pre-flight check against `claude mcp list`; a missing
> requirement produces a `missing_resource` blocker (fail fast). Discovering and selecting the
> remaining tools is the platform's job — the framework does not duplicate it.
>
> **Capability catalogue.** `docs/tools-catalog.json` is a persistent memory of available MCP
> servers, including ones that are not connected right now and therefore invisible to the platform.
> While planning, the orchestrator compares the goal against the available tools and updates the
> catalogue. **Before raising any blocker** it re-checks MCP: can the problem be solved with a tool
> that is already available? This implements two principles — do not invent blockers, and remember
> your tools.

## Permissions and safety

**No prompts during autonomous work.** Routine operations (file edits, git `add`/`commit`/`push`/
`pull`/`fetch`, running tests) are permitted, so the loop is never interrupted by a confirmation
dialog. The decision is made by the `hooks/safety-guard` arbiter hook, which returns an explicit
"allow" for safe operations — this removes prompts in every environment, whatever the mode selected
in the user interface.

**Protection against irreversible damage is minimal by design.** A measurement showed that a broad
rule set blocked 7 out of 11 everyday development commands by mistake, and every false refusal
costs the loop a turn. A rule is kept only when the consequence is unrecoverable AND there is
essentially no legitimate use for it in a development loop. What remains:

1. destroying the filesystem — the root or the entire home directory (POSIX and Windows);
2. formatting or wiping a disk;
3. mass-killing `claude`/`node` processes by image name — that is the loop killing itself;
4. `git push --force` — rewriting shared history.

Everything else is allowed: losses inside a repository are recoverable from git. Blocked commands
are logged to `~/.claude/safety-guard.log`.

**Secrets are never blocked.** If a commit includes a file that looks like key storage, the
framework writes one line into the log and, when notifications are configured, sends a message.
It does not interrupt the work — the decision stays with you.

## Stop conditions (Ralph Loop)

The Stop hook ends the session (and sends a Telegram alert, if the notification variables are set)
when:

- a **real blocker** is recorded (a missing key or credential, fundamental ambiguity, three
  consecutive failed attempts at the same task);
- the **roadmap is fully released** (`released_version == current_version`);
- the **iteration limit** is reached (`max_iterations`);
- the **budget cap** is exceeded (`budget_metrics.cap_usd`).

The Stop hook also exits cleanly, without blocking, when:

- another live session already drives the loop (the loop lock — do not interfere);
- `docs/STATE.md` is missing or corrupt (fail open).

## Manual escalation

If you (the human) need to interrupt the loop, add an entry to the `blockers:` array in
`docs/STATE.md`. The loop stops at the next gate.

## Session logs

Every session is saved automatically by `hooks/save-session-log` into
`docs/logs/<YYYY-MM-DD>/<HH-MM-SS>_<id>.summary.md` (readable) and `…_<id>.jsonl` (the full
transcript). This is a **forensic and backup** resource — reach for it when the primary sources are
not enough:

- restoring context after a crash or a compaction;
- debugging loop behaviour ("why did it stop / why did it repeat?");
- recovering the reasoning of a past session that never made it into `docs/reports/`.

**How to read them (this matters for your context budget):**

- **grep first** across `docs/logs/**/*.summary.md` and read only the fragments you need;
- do **NOT** open `*.jsonl` in full — it is the complete transcript, hundreds of kilobytes, and it
  will flood your context;
- `docs/STATE.md` (state) and `docs/reports/` (decisions) come first; logs are for when those are
  insufficient.

## Quick references

- Framework architecture and mechanics: `GUIDELINE.md` at the framework root.
- Failure modes and what to do about them: `docs/failure-modes.md`.
- This project's own documents: `docs/userdocs/` (if present).
- Session logs: `docs/logs/` (grep the `*.summary.md` files; do not read `*.jsonl` in full).
- Reports: `docs/reports/`.
