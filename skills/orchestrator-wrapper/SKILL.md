---
name: orchestrator-wrapper
description: >-
  Thin orchestrator for the autonomous development framework. Reads
  docs/STATE.md and docs/ROADMAP.md, identifies the current stage (0-4) and the
  next step, executes one loop iteration, and updates STATE.md atomically. Loop
  control belongs to the Stop hook (Claude Code) or the supervisor (OpenCode).
  Use this skill at the start of every iteration in any project bootstrapped by
  the framework.
origin: 0-code-autonomous-framework
version: 1.6.1
---

# orchestrator-wrapper

A thin wrapper that connects three pieces into a working loop:

1. `docs/STATE.md` — where the project is right now (read and written);
2. `docs/ROADMAP.md` — where the project is going (read);
3. the loop driver — decides whether to continue, based on STATE.

**This skill does not decide when to stop.** That belongs to `core/gates.mjs`, and both drivers
share it. Your job is one honest iteration of work.

---

## Every iteration

1. Read `docs/STATE.md` and `docs/ROADMAP.md`.
2. Work out what `current_stage` means right now.
3. Do **one** step of real work.
4. Update STATE atomically through `lib/update-state.mjs`.
5. Stop normally. The driver decides what happens next.

### What counts as output

- **Measurable progress** — code, documents, prompts, tests. Not a plan about a plan.
- **STATE updated**: at minimum `last_action_at` and `last_action`; where applicable
  `current_prompt_file`, `iteration`, `blockers`, `released_version`.
- **ROADMAP updated** when a version is completed or released.
- **A report** in `docs/reports/<version>_<name>.md` after research, audit or test cycles.

> Everything below describes **what** to do. **How** is up to you, through the ordinary tools.
> The only executable artefacts are `lib/*.mjs`, `core/*.mjs` and `hooks/*` — the pseudocode in
> this document is not a runnable API.

---

## The five stages

| Stage | Name | What one iteration looks like |
|---|---|---|
| 0 | Goal setting | Turn a brief into `docs/ROADMAP.md`: ask the clarifying questions you actually need, then write versions with acceptance criteria. Move to stage 1. |
| 1 | Planning | Read the current version from the roadmap, run the research prompt, generate the execution prompts, move to stage 2. |
| 2 | Execution | Load `current_prompt_file` and carry it out. When every prompt is done, mark the version completed and move on. |
| 3 | Audits | Pick an audit cycle, run it, fix what it finds, verify the fix. |
| 4 | Testing | Run the test gate. All green → mark the version released. |

A blocker in STATE means the loop is about to end. Do not try to work around it — use the
iteration to describe the blocker clearly enough that a human can act on it.

---

## The blocker algorithm

A blocker is a **resource problem**, not an excuse. Before recording one:

1. **Count the attempts.** Three genuine attempts at the same task, each with a *different*
   approach — not the same approach three times.
2. **Re-check your tools.** Can an available MCP server, a script, or a different route solve it?
   This step exists because "I am blocked" is usually cheaper to write than to verify.
3. **Only then** write the blocker, and write it so it can be acted upon: what is missing, why it
   is needed, how to obtain it.

Blocker types: `missing_resource` (a key, an account, a paid balance), `stuck` (three failed
attempts), `ambiguity` (a decision only the owner can make), `no_progress` (recorded by the
driver, not by you).

**Do not invent blockers.** Ask yourself honestly whether this is something you genuinely cannot
resolve. The framework is built for autonomy; a fabricated blocker wastes the human's attention,
which is the scarcest resource in the loop.

---

## Progress

Every turn is measured against three signals: a new git commit, a changed working tree, a changed
STATE file. Two turns without any of them and the driver adds an escalation directive to your
prompt; three and it records a `no_progress` blocker.

The lesson behind this: an agent that talks instead of acting looks identical to one that is
thinking hard — until you measure the disk.

---

## Model routing

Expensive models for thinking (research, architecture, audits), cheaper ones for routine work
(implementation, edits, tests). The mapping lives in `core/model-routing.mjs`; presets are
overridable through `OPENROUTER_MODEL_HIGH/MID/LOW`.

Choose deliberately: on a real acceptance run the cheap code-focused model found a genuine bug,
fixed the source rather than the test, and committed — for about a third of a dollar. Expense is
not a proxy for capability.

---

## Hard rules

- **Update STATE through `lib/update-state.mjs`**, never by hand-editing the frontmatter. The tool
  backs the file up and writes atomically; a half-written STATE breaks the loop.
- **One iteration, one step.** Do not batch five versions into one turn — the loop exists to make
  progress visible.
- **Record the reasoning where it belongs.** Decisions go into reports; state goes into STATE.
  Do not turn STATE into a diary.
- **If the instructions and the behaviour disagree, the behaviour wins** — and then fix the
  instructions. Several defects in this framework survived for versions because a document said
  something nobody re-checked.
