# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely, and the project uses
[semantic versioning](https://semver.org/).

> **A note on this file.** Versions before 1.0.0 were developed in a private repository with a
> detailed Russian-language history. That history is not reproduced here; instead each release
> below records what changed and — more usefully — **what was learned**. Where a decision was later
> reversed, the reversal is listed too: this project treats a disproven assumption as a result.

---

## [v1.6.0 / v1.6.1] — 2026-08-16 — the first public release

The framework was prepared for a separate public repository: everything translated to English, the
history rebuilt from zero, and the tree assembled by a command rather than by hand — because manual
copying diverges from the source by the second update, and the divergence is noticed at the worst
possible moment.

The export tool **refuses** rather than warns when it finds a secret or untranslated text. This is
the only place in the project that forbids instead of informing: a published key is compromised
permanently, so the cost of the mistake is not comparable to the inconvenience. Verified by planting
one and watching the export stop.

**What the acceptance found that a green test suite did not.** The suites were run from the
*published* tree instead of the working one — the version a stranger actually gets. Four defects
surfaced, each of which would have hit the first person to install it:

- Bootstrap handed target projects a `.gitignore` copied from the framework root — a file that does
  not exist in a fresh clone. Anyone installing from the public repository would have got a project
  without one, and committed their `.env` on the first try.
- The published tree had **no `.gitignore` at all**, for the same reason, one level up.
- Provisioning demanded a personal MCP manifest that is deliberately not published and that a new
  user cannot have. It failed on first run.
- After `bootstrap.sh --backend opencode`, the closing instructions still said "Start Claude Code" —
  pointing the user at the wrong engine on their very first step.

**A defect in the checks themselves.** A `skip()` helper was called in three places and never
defined. Bash wrote "command not found" to stderr, six checks vanished from the run, and the summary
still reported zero failures. Skips are now counted, printed by name, and reported as their own
field: a suite that quietly shrinks is lying about its own coverage.

**v1.6.1 — a false refusal found by the documentation audit, at the cost of a turn.** The guard
blocked an ordinary code search. The comment above the command splitter claimed that quoting
prevented exactly this; the splitter cut on separator characters without regard for quotes, so the
pipes inside a regex made a disk-formatting command the head of a segment.

The fix took two attempts, because the first was not enough: after the splitter learned about
quotes, a heredoc body still inverted the quote state — one apostrophe several lines up was enough.
Heredoc bodies are now excluded from segmentation entirely, **except** when a shell reads them
(`bash <<'EOF'`), where the body genuinely is commands. Both directions are locked down by tests:
four kinds of heredoc data pass, `bash <<'EOF' rm -rf /` and `npm test && rm -rf /` are still
blocked. A fix must not buy comfort with coverage.

Also corrected: README and CONTRIBUTING promised 117 end-to-end checks, while a fresh clone runs
111 plus 6 announced skips — a number that only added up for the author.

**On the version number.** `v1.6.0` had already been tagged and pushed when the audit found the
guard defect. Moving the tag was blocked by the guard itself, correctly, as a force-overwrite of
shared history. The fixes were given their own version instead of rewriting it.

**Acceptance:** installed from the published tree into a clean directory on Windows and on Linux,
each run to an autonomous commit on a real defect, with the fix landing in the source rather than
in the test — 2 commits and $0.1259 on Linux, 1 commit and $0.0853 on Windows.

---

## [v1.5.0] — 2026-08-13 — production hardening

Six mechanisms for long unattended operation. Every one came from an observation during earlier
work, not from caution.

- **Loop lock.** Two supervisors had been started against the same `docs/STATE.md` and competed for
  writes. A live owner now refuses the second launch; a dead one is taken over, because a crashed
  process must not block autonomy forever.
- **Failure resilience.** A single `UnknownError` from the provider used to end an unattended run.
  Transient failures are now retried with growing backoff; real errors (bad key, unknown model, no
  credit) still stop immediately, because retrying them only burns time.
- **Process groups.** A supervisor killed from the outside left live engine children behind. Two
  lines of defence: signal handlers, plus an on-disk registry that the next launch sweeps — because
  when a parent is killed hard, exit handlers do not run at all.
- **Engine self-check.** One tiny turn before the loop. It catches a changed output format (turns
  "succeed" but come back empty) and a misconfiguration that would otherwise masquerade as a
  transient failure and cost 75 seconds of retries.
- **Honest bootstrap output.** Installation now says plainly whether notifications will work.
- **Spending guard inside a turn** (beyond the plan). Cost is read from the event stream as the
  turn runs. Precision is honest: the guard fires at a step boundary, so a $0.002 cap aborted at
  $0.03 — it prevents runaway spending rather than guaranteeing an exact figure.

**Three planned decisions were reversed by evidence.** Detaching the process on Windows breaks
output capture. Exit handlers never run on a hard kill, so one cleanup path is not enough. The
engine self-check must use the same model the loop uses, or a wrong model goes unnoticed.

**A design error found by the final gate.** The per-turn timeout was meant to catch a hang but
measured duration — and killed honest work after the agent had already produced two commits. A hung
process differs from a working one by *silence*, not by lifetime. The cap now measures silence.

**Final gate:** 2 h 32 min unattended on a real third-party repository, 9 turns, $10.25 of a $20
cap, 6 genuine commits, zero human interventions. An injected failure was survived. The run stopped
on its own when the agent recorded a `missing_resource` blocker — it needed a confirmation code no
machine can produce.

---

## [v1.4.0] — 2026-08-11 — pre-release audit

The method: **verify claims against behaviour**, not read the code. Rationale — across the two
previous versions every serious defect was found by live checks at ≥80% coverage, and none was
caught by a test.

Of 22 claims checked: 17 confirmed, 3 disproven and fixed on the spot, 1 true with a caveat.

- **Critical: the agent disarmed itself.** Asked to remove its own protection, it did — deleting
  the plugin and rewriting the permission values to "allow" while leaving the block in place, which
  the old check did not notice. Fixed structurally: the main plugin now lives outside the working
  directory, and permissions are compared **by content**. Verified: with the project fully
  disarmed, the global guard still blocked `git push --force`.
- The toolset provisioner delegated to a file deleted an hour earlier — neither tests nor smoke
  noticed, because nobody ran that script.
- The budget guard compared a number nobody ever wrote. It would never have fired.
- Bootstrap only knew how to prepare a Claude Code project.

**Live run on a real repository:** a genuine defect (`from datetime import UTC` on Python 3.10)
blocked an entire test suite from loading. The autonomous loop fixed 7 files, choosing a minimal
compatible alias rather than editing 39 call sites. Test collection went from **0 to 2463**.

Also in this release: the second engine adapter that lacked working protection was removed
entirely; blind-spot tests were added, one per *class* of defect; the starting iteration cap
dropped from 1000 to 25.

---

## [v1.3.0] — 2026-08-10 — OpenCode backend

A second execution engine, plugged into the existing `Backend` port: any OpenRouter model, driven
by the external supervisor.

Behaviour was verified empirically rather than from documentation: `opencode run` hangs forever if
standard input stays open; the prompt therefore travels through stdin, which also sidesteps the
Windows command-line limit; the `--format json` event stream is line-delimited JSON; protection
through the `tool.execute.before` plugin genuinely works.

Acceptance ran on a real bug in a real repository — three runs on two cheap models, each finding
the cause, fixing the **source** (not the test) and committing without a human, at about $0.35 per
run. The model preset was then chosen **by measurement**, not by model name.

A core gap surfaced along the way: the supervisor never used model routing, so without an explicit
flag no model was passed at all.

---

## [v1.2.0 / v1.2.1] — 2026-08-10 — permissions without prompts

**The root cause of interrupted autonomy.** Twenty experiments established the decision hierarchy:
an `ask` rule outranks every mode, including "bypass permissions", *and* outranks the hook's
decision. The framework had been handing `ask` rules to itself and to every project it created —
it was manufacturing the problem it was meant to solve.

Fix: the `ask` category no longer exists as a concept. Dangerous commands go to `deny`, routine
ones to `allow`, and the hook became an **arbiter** that returns an explicit allow for safe
operations. Result: 20 typical operations, **zero prompts**, with destructive commands still
blocked under bypass.

**v1.2.1 reversed part of v1.2.0.** A measurement showed the grown rule set blocked 7 of 11
everyday commands. Protection was cut to four rules using a strict criterion: unrecoverable
consequence **and** essentially no legitimate use. Twenty-one everyday operations now pass, and
the false-positive measurement lives on as a test.

---

## [v1.1.0] — 2026-07-02 — headless execution actually executes

Autonomous runs produced plans instead of work: 12 consecutive launches, zero tool calls, zero
commits. Eleven experiments proved the cause — in headless mode every tool that is not explicitly
permitted is *silently* refused, and the framework was passing no permission flags at all.

Two popular explanations were disproven in the process: that `-p` is inherently single-shot, and
that a Stop hook cannot continue a loop in headless mode.

Accepted with 7 genuine commits produced in one unattended run.

---

## [v1.0.0] — production release

The framework reached the point where it could run a real project end to end: state, roadmap, the
loop driver, blockers, model routing, and installation into an arbitrary project.

---

## Earlier versions

v0.0.1 through v0.9.x built the foundation: the Ralph Loop pattern on a Stop hook, atomic state
updates with backups, the orchestrator skill, bootstrap and plugin installation, the multi-backend
core, and the test suite that later grew into the current 234 tests plus 111 end-to-end checks (plus
6 that a fresh clone announces as skipped).
