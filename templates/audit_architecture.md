# Architecture audit

Read `.0-code/config.json`, `.0-code/AGENT.md`, the active prompt and project architecture. Resolve all artifact paths through document roles. Write human artifacts in the configured language.

Check boundaries, dependency direction, ownership, consistency of contracts and configuration, recovery after partial failures, extensibility required by the task and unnecessary complexity. Trace real entry points and prove findings against code or a reproducible experiment. Compare published claims with implementation. Do not infer a defect merely from a preferred style.

Write a research report in the reports role, a machine findings ledger in the todo role and a repair prompt in the prompts role. Follow the ledger contract in the production audit command. Name exact coverage, severity, location and evidence. An inapplicable direction gets an empty ledger with an explicit reason. Do not declare a direction clean if it was not examined.
