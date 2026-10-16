# Research cycle

Read `.0-code/config.json`, `.0-code/AGENT.md`, the state and roadmap roles, and the owner's current task. Project conventions and the active prompt take precedence. Write human artifacts in the configured language.

Define the concrete problem and acceptance evidence. Inspect the existing implementation and actual project checks before proposing changes. Verify uncertain external contracts against primary documentation and local experiments. Separate observations from assumptions.

For meaningful architectural choices, compare at least three viable alternatives using the decision template. State costs, grounds, rejected alternatives and a falsifiable outcome. Do not record computed scores.

Write the report in the reports role. Write an execution prompt in the prompts role with ordered tasks, validation, working boundaries and genuine owner dependencies. Update the state through `.0-code/lib/update-state.mjs`; moving the phase or prompt requires a fresh `next_step_prompt` in that same patch. Commit completed work as required by the active cycle.
