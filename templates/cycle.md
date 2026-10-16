---
version: "0.0.1"
stage: 1
---

# Autonomous cycle

Read `.0-code/config.json` and `.0-code/AGENT.md`. Resolve document roles from configuration;
project templates take precedence over the built-in templates.

## Principles

- Work autonomously within the owner's authorization; fix causes and verify real behaviour.
- Use simple code, one source per fact, and small responsibilities.
- Do not invent blockers, mock successful outcomes, or silently skip tasks.
- Write cycle documents in the configured language; keep agent instructions in English.

## Work location

Specify the project, branch, permitted external actions, and protected directories here.

## Required work

Replace this section with any number of tasks of any kind. A cycle prompt is the work unit.
For every acceptance criterion, state the observable evidence required.

For framework releases, require Node 20/22/24 on Windows and Linux in CI and record
unexecuted cells explicitly. Local acceptance includes all installed supported runtimes:
three full default suites in a row with source coverage >=80% on each of Node 22/24,
smoke on both, and at least process/lifecycle CLI checks on Node 20. Repeat full suite
and smoke on 22/24 from a clean public copy. Record exact runtime versions/paths and
verify the selected PATH inside Bash. Download missing runtimes only to scratch with
official SHA-256 verification. Include one normal-environment Node 22 CLI lifecycle,
toolset disabled, real doctor prerequisites and byte restoration of a disposable project;
preserve personal profiles and authentication. See `testing.md` for evidence requirements.

## Steps

1. Start the cycle with `node .0-code/tools/0code.mjs start <this-file>` and an explicit optional limit.
2. Research, compare meaningful alternatives, and write decision records using the configured role.
3. Implement and verify; record genuine findings with priorities P0–P3.
4. Audit and test the final changes; preserve the five stage meanings from AGENT.md.
5. Prepare the report and finish only after all required evidence and authorized publication exist.

## Owner actions

List any necessary owner actions before work starts; do not create new approval requirements.

## Prohibited actions

State the boundaries of this particular cycle. Secrets belong in environment variables.
