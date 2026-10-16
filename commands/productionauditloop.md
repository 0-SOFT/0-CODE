# Production audit loop

Follow the production audit command and the active cycle prompt. Read `.0-code/config.json` for artifact roles and `.0-code/AGENT.md` for cycle rules. Each round examines architecture, codebase, frontend and tests in that order.

1. Audit all four directions and write separate valid machine ledgers with the current round.
2. Load the four ledgers through `.0-code/core/audit-ledger.mjs` and inspect `loopVerdict`. A missing or invalid direction cannot finish a round.
3. Repair open P0, then P1, then P2 findings. Record evidence for fixed or rejected findings; do not downgrade them merely to reduce the count.
4. Audit again with a new round and explicitly stated coverage. A surviving defect must be found again, rather than silently copied as historical state.
5. Stop when `loopVerdict.done` is true and any stronger requirement of the active prompt is satisfied. Report scope, results and remaining limitations in the reports role, then update the state atomically.

A round which does not converge requires investigation of causes and repair strategy. Record a genuine resource blocker when necessary; do not invent a blocker because work is slow. The cycle prompt decides how many clean rounds are required.
