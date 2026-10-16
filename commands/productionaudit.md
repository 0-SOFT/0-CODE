# Production audit

Read `.0-code/config.json` and `.0-code/AGENT.md`. Resolve templates through the configured project templates role first, then `.0-code/templates/`. Write human artifacts in the configured language.

Audit sequentially: architecture, codebase, frontend, tests. Use `audit_architecture.md`, `audit_codebase.md`, `audit_frontend.md`, and `audit_tests.md`. For each direction write a research report in the reports role, a ledger in the todo role and a repair prompt in the prompts role using their name patterns. If a direction is inapplicable, record an empty ledger whose coverage explains what was examined and why it does not apply.

Each ledger has this machine header; use one-line values and put reasoning in the body:

```yaml
---
audit: codebase
version: "X.Y.Z"
round: 1
coverage: "specific files and real paths examined"
findings:
  - id: "P1-001"
    level: "P1"
    where: "relative/file:line or a concrete explanation of absent location"
    summary: "specific defect and consequence"
    state: "open"
---
```

`id` severity and `level` must match. States are `open`, `fixed`, `rejected`; fixed and rejected findings need substantive `evidence`. Every ledger needs specific coverage. Store separate direction ledgers so one cannot overwrite another. Validate them with `.0-code/core/audit-ledger.mjs` before declaring a round complete. A missing or invalid ledger is never a clean direction.
