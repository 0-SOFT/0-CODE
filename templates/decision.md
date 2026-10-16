---
decision: "short name of the choice"
version: "X.Y.Z"
question: "what alternatives are being compared and why this choice matters"
options:
  - id: "first"
    summary: "first viable approach"
    impact: 5
    confidence: 5
    cost: 5
    basis: "measurement with its result, or an explicitly stated assumption"
    rejected_because: "concrete cost or weakness that lost the comparison"
  - id: "second"
    summary: "second viable approach"
    impact: 5
    confidence: 5
    cost: 5
    basis: "measurement with its result, or an explicitly stated assumption"
    rejected_because: "concrete cost or weakness that lost the comparison"
  - id: "third"
    summary: "third viable approach"
    impact: 5
    confidence: 5
    cost: 5
    basis: "measurement with its result, or an explicitly stated assumption"
chosen: "third"
what_would_disprove: "observable evidence that would invalidate this choice"
---

# Decision

Place the completed record in the decisions role using its configured name pattern, beginning with the version and an underscore. Write prose in the configured language.

Explain the trigger, evidence, selected approach, tradeoffs, scope and remaining uncertainty. Use at least three viable alternatives for a significant architectural choice. Every option needs impact, confidence and cost from 1 to 10, and grounds. Every rejected option needs a reason. Do not store a calculated score; the reader computes it.

The machine header uses one-line values: folded and literal YAML blocks are unsupported. `.0-code/core/decision-record.mjs` validates the record.
