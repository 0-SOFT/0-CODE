# Execution cycle

Read `.0-code/config.json`, `.0-code/AGENT.md`, the state and roadmap roles and the active cycle prompt. Follow project conventions and work within its repository and branch boundaries. Human artifacts use the configured language.

Implement the prompt's tasks in order. Prefer the existing project tools recorded in the inventory. Investigate failures; do not hide them by weakening tests or changing thresholds. Verify significant behavior with real inputs and appropriate project checks. Record findings in the configured todo role with their severity, location, state and evidence.

For long-running external work, register its process, log, completion marker and expected duration in `running_jobs`. Work on independent tasks or end the turn. Collect completed results and clear the registry; inspect dead and overdue jobs.

Commit completed pieces according to the cycle prompt. Write results and remaining limits in the reports role, then update the state atomically using `.0-code/lib/update-state.mjs`. A phase or prompt move must carry `next_step_prompt`. Ask for owner input only when the active task actually requires it; do not invent blockers.
