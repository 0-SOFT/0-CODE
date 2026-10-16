---
name: orchestrator-wrapper
description: Read the configured state and roadmap, execute the current cycle stage, and update state atomically. The selected driver owns continuation.
origin: 0-code-autonomous-framework
version: 2.0.0
---

# Orchestrator wrapper

Read `.0-code/config.json` and `.0-code/AGENT.md` in an installed project. In a framework source checkout, resolve legacy defaults with `core/project-config.mjs`. The same module defines document paths, name patterns and the framework root. Never assume a document directory from its role name.

Read the state and roadmap roles. Follow the active `current_prompt_file` and `next_step_prompt`; if the cached task is absent, derive the next action from the actual stage and roadmap. Project instructions and the active prompt take precedence over this wrapper.

| Stage | Action |
|---|---|
| 0 | Define the owner's concrete goals and acceptance evidence. |
| 1 | Research actual contracts and compare meaningful alternatives; write a plan and execution prompt. |
| 2 | Execute ordered tasks, verify real behavior, commit completed pieces. |
| 3 | Audit the scope required by the active prompt, record findings and repair them with evidence. |
| 4 | Run the required final checks and release only when their evidence supports completion. |

Human artifacts use the configured language. Project templates take precedence over built-in templates. Reports, decisions, findings and prompts use their configured roles and name patterns.

Update state through `<framework-root>/lib/update-state.mjs`, passing the state role path. A patch moving version, stage or prompt must include `next_step_prompt`. The writer generates its task passport; never edit that passport manually.

Significant architectural choices need at least three viable alternatives, explicit grounds, reasons for rejection and a falsifiable outcome. Never store computed scores. Released acceptance criteria need evidence or an explicit substantive non-completion statement.

Register long-running external processes in `running_jobs`, then do independent work or end the turn. Collect finished results and clear their records; inspect dead and overdue work. Do not poll with sleeping shell loops.

Use the project's inventory and checks before bundled tools. Record genuine blockers in state; do not invent them to stop ordinary work. Iteration and spending limits are opt-in. A spending limit requires a driver that records cost. One folder has one active cycle; separate branches and folders isolate parallel cycles.

The Claude Stop hook or external supervisor owns continuation. Never run both drivers for one folder. End the turn after actual work and an accurate state update.
