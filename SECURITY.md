# Security policy

## Reporting a vulnerability

Please report security issues **privately** — open a
[security advisory](https://github.com/0-SOFT/0-CODE/security/advisories/new) rather than a public
issue.

Include what you can: what you observed, how to reproduce it, and what an attacker could do with
it. A proof of concept helps but is not required.

## What is in scope

This framework runs an AI agent with broad permissions on your machine, so the interesting
questions are about the boundaries:

- **Bypassing the guard.** The four irreversible-command rules are enforced by a hook (Claude Code)
  and a plugin (OpenCode). If you find a command shape that slips past the detector, that is a
  valid report. See `core/safety.mjs`.
- **Removing the guard.** The main plugin deliberately lives outside the working directory because
  an agent inside the project was able to delete it. If you find another way to disarm it from
  inside a turn, we want to know.
- **Leaking secrets.** API keys travel through environment variables and must never reach a command
  line, a log, or an error message. A path where one does is a valid report.
- **The export tool.** `tools/export-public.mjs` refuses to publish when it finds a secret pattern.
  A way to smuggle one past it is a valid report.

## What is not a vulnerability

Some behaviour looks alarming but is deliberate, documented, and chosen with the trade-off in mind:

- **The agent can delete uncommitted work.** `git reset --hard` and `git clean` are not blocked —
  they are routine, and blocking them cost more than it saved (a measurement showed 7 false
  refusals out of 11 everyday commands). Commit often.
- **Secrets can be committed.** There is deliberately no ban. The framework writes a line in the
  log and notifies you; the decision stays with the project owner.
- **The agent can write bad code.** Nothing here judges correctness. That is what tests and review
  are for.
- **Within one turn the project-level permission file can be edited.** This is stated openly in the
  documentation. It does not remove protection, because the blocking is done by a plugin outside the
  agent's reach.

If you are unsure whether something belongs in the first list or the second, report it — a wrong
guess in that direction costs nothing.

## Handling your own secrets

- Keys belong in `.env`, which is gitignored. Never in a manifest, never in a command line.
- If a key has been committed and pushed, treat it as exposed from that moment: rotate it, then
  clean the history.
- `config/mcp-manifest.example.json` shows the format: `${VAR}` placeholders only, values supplied
  at provisioning time.
