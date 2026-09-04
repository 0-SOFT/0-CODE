# Project: __PROJECT_NAME__

This project is managed by the **Claude Code Autonomous Framework** v__FRAMEWORK_VERSION__.

## Loop

A continuous autonomous Ralph Loop:

- The project state lives in `docs/STATE.md` (YAML frontmatter plus a journal).
- The roadmap lives in `docs/ROADMAP.md` (a sequence of versions with acceptance criteria).
- On every natural stop, `hooks/ralph-loop-stop` decides whether to continue the loop (via
  `decision:block`) or end the session (a blocker, the released version, or a cap).

## Orchestration

Use the `@orchestrator-wrapper` skill on each iteration to:

1. Read `docs/STATE.md` and `docs/ROADMAP.md`.
2. Identify the current stage (0 = goal-setting, 1 = planning, 2 = execution, 3 = audits,
   4 = testing) and the next concrete step.
3. Execute one iteration of work (write code, write prompts, run tests).
4. Update STATE.md atomically via `lib/update-state.mjs`.

> **Move the loop and rewrite the step instruction in the same patch.** A patch that changes
> `current_version`, `current_stage` or `current_prompt_file` must also carry `next_step_prompt`,
> or the write is refused. Use `"next_step_prompt": null` to hand the decision back to STATE.
> `next_step_prompt` is a copy of an instruction, not its source — a copy with no expiry date
> drifts silently, and a live project once spent dozens of iterations on an instruction written
> two versions earlier that announced a blocker which did not exist. The `next_step_prompt_meta`
> passport is written by the tool; never edit it by hand.
5. Stop normally — the Stop hook handles loop continuation.

> **Required tools.** Declare the MCP servers you need in `docs/STATE.md` → `required_tools: [...]`.
> Checking them is **your** job as the orchestrating agent, during planning: compare the list against
> `claude mcp list` and record a `missing_resource` blocker if something you need is absent. No code
> does this for you — `core/preflight.mjs` is a different thing entirely, an engine self-check that
> never looks at `required_tools`. Discovering and selecting the remaining tools is the platform's
> job; the framework does not duplicate it.
>
> **Capability catalogue.** `docs/tools-catalog.json` is a persistent memory of available MCP
> servers, including ones that are not connected right now and therefore invisible to the platform.
> While planning, the orchestrator compares the goal against the available tools and updates the
> catalogue. **Before raising any blocker** it re-checks MCP: can the problem be solved with a tool
> that is already available? This implements two principles — do not invent blockers, and remember
> your tools.

## Long-running work: start it, then end the turn

**A turn is where you act, not where you wait.** It is the loop's only spendable resource, and one
spent asleep produces nothing — which is also exactly what a hung turn looks like from outside.

Do not do this:

```bash
until grep -q DONE log.txt; do sleep 15; done      # the turn is spent, and if the job dies, for ever
```

Do this instead:

```bash
nohup npm test > tmp/suite.log 2>&1 &     # start it in the background
echo $!                                    # note the process id
```

then record it and **end the turn**:

```bash
echo '{"running_jobs":[{"id":"suite","pid":12345,"log":"tmp/suite.log",
      "done_marker":"SUITE FINISHED","expect_by":"2026-01-01T12:00:00Z"}]}'   | node lib/update-state.mjs docs/STATE.md
```

The next continuation tells you where every job stands, before you ask:

```
jobs: running: 1 (suite) | overdue: 0 | died: 0 | finished: 0
```

| State | Meaning | What to do |
|---|---|---|
| `running` | alive, marker not written yet | **do other work** — do not wait |
| `finished` | gone, marker written | read the log, take the result, remove the entry |
| `died` | gone, marker never written | it did **not** finish — investigate, rather than waiting for ever |
| `overdue` | alive, past `expect_by` | not a failure; usually worth a look |

Liveness and the marker are separate on purpose: the absence of a marker means two different things
(still working / died), and that ambiguity is exactly why a polling wait can hang for ever.

Remove an entry once you have taken its result. The register is what is happening **now**, not a log.

## Limits

This project is created **without** an iteration cap and **without** a spending cap: a limit is set
by whoever wants one, not handed out by default.

- `max_iterations` in `docs/STATE.md` — a positive number turns the iteration cap on. Keep it below
  `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, or a session is stopped by that backstop first; the loop says
  so when it happens.
- `budget_metrics.cap_usd` — turns the spending cap on. It is enforced only when the loop runs
  through `core/supervisor.mjs`, which is what receives the cost of a turn from the engine. Under
  the Stop hook nothing fills the counter, and the loop reports the cap as unenforceable rather
  than letting it look like a guard.

With no limit set, two things stop the loop: a blocker, and `released_version == current_version`.
A runaway is still visible: three turns that change nothing produce a `no_progress` blocker, and a
state file that stops changing is reported in every continuation.

## One session drives the loop; the others simply work

Opening a second Claude Code session in this project is **safe**. It will not pick the loop up. Its
stderr carries a line like

```
ralph-loop-stop: the loop is already driven by session 9491c21b…, process 4156, stop-hook,
started 2026-09-01T13:20:11Z. It will be released once that owner goes quiet, or immediately if
you delete docs/.loop.lock. This session is not driving the loop and ends normally.
```

and it behaves like an ordinary session: it ends its turn instead of continuing. That is exactly
what you want when the second window is open for something else.

**What counts as alive.** Ownership is not decided by a process number — the hook's own number is
dead milliseconds after it is written — but by something that lives as long as the session does:
the file its transcript is appended to. While the session is writing, the loop is its own. Once it
has been quiet for half an hour, the next session takes over on its own, with no human involved.

**To take the loop immediately**, do the one thing the refusal names:

```bash
rm docs/.loop.lock
```

**Do not run the Stop hook and the supervisor at once.** The lock will now honestly refuse the
second one, but that is a guard against a mistake, not a mode of operation. Pick one driver.

## A decision is not whatever came to mind first

Measured across this framework's own history: reports naming **at least one rejected alternative** —
11 out of 72, or 15 %. In the rest, a reader has no way to tell a decision chosen from several from
one taken first.

It is not laziness. Where a prompt asked for the alternatives, the alternatives are there and they
are real. The practice lived in a document rather than in a mechanism, so it switched on when
instructed and off when not.

**When to write a decision record.** Not for every choice — only where you are choosing **between
paths that do not reduce to one another**: a new module, a change of contract, the shape of a
mechanism, a threshold that behaviour depends on. A rite performed over the name of a variable will
be performed just as emptily over the choice that mattered.

**Where:** `docs/decisions/<version>_<short-name>.md`. The template and the rules live in
`docs/prompts/templates/decision.md`.

What the machine checks: at least three options (two is a fork, and the second one is usually there
to make the first look chosen); `impact`, `confidence` and `cost` from 1 to 10 for each, **plus a
`basis`** — a measurement or an explicitly named assumption; a `rejected_because` on everything not
chosen; a non-empty `what_would_disprove`.

**Never write the score down.** `(impact × confidence) / cost` is computed on read, and a stored one
is refused: a copy of numbers that live three lines above it will one day disagree with them — the
same defect class versions 1.7.0 and 1.14.0 were each spent on.

**Whether a record exists for the version in flight is printed in the continuation header every
turn.** The mechanism cannot know whether this version needed one; what it does is stop a flat
decision from looking exactly like a considered one.

## The plan re-examines itself

The second measurement is blunter still: versions ever cancelled, dropped or reordered in
`docs/ROADMAP.md` — **zero**, across twenty-five-plus releases. Either the plan was right twenty-five
times running, or it was never checked against what had been built.

Every ten turns the step instruction is **replaced** by a mandatory review: read the remaining
versions against what the finished work has since shown, and answer what changed in the plan and
why. Replaced, not appended — a directive at the end of a long text leaves the agent doing what it
was already doing.

Record the outcome in the same patch:

```bash
echo '{"roadmap_reviewed_at_iteration": 42,
       "roadmap_review_note": "dropped version X: its job is done by mechanism Y, checked both acceptance lists"}' \
  | node lib/update-state.mjs docs/STATE.md
```

A patch without a substantive note is **refused** with exit code 3. "All fine" does not pass: if the
plan did not change, say what you examined and why it holds. A review that cannot fail is not a
review.

The threshold is `roadmap_review_every`; `null`, `0` or a negative number switch the review off
entirely, exactly as they do for every other limit in this framework since v1.9.0.

**What the mechanism does not do.** It makes you look. It cannot make you see, and that is written
down in advance rather than discovered later: its only honest measure is whether the roadmap starts
changing.

## An acceptance criterion is closed by evidence

The measurement this rule came from: versions declaring themselves released carried **forty** open
acceptance criteria that said nothing about themselves. From the roadmap there was no way to tell a
version that fell short of its own bar from one where somebody forgot a tick.

The price of that silence is measured, not supposed. v0.9.0 carried an open criterion — "the >=80 %
threshold for lines **and branches** is met" — and the first real audit run rediscovered exactly that
four versions later: the coverage gate had never checked branches, and the two files that decide
whether the loop continues and whether a dangerous command runs sat at 12.5 %. The roadmap knew.
Nobody read it.

**The rule.** A criterion of a released version is either closed or says out loud that it was not met:

```markdown
  - [x] Tests are green — **proven:** 468 checks, no failures, coverage gate run the way CI runs it
  - [ ] **NOT DONE:** no live run under PM2 ever happened, so restart after a kill is unverified
  - [ ] **WITHDRAWN:** this belonged to Cline, removed in v1.4.0; zero mentions remain in the code
```

The marker is a **shape, not a word**: a bold opening that ends in a colon, followed by a substantive
reason. Deliberately no vocabulary: this module is published and a target project's roadmap may be
written in any language. The reason goes through the same `isSubstantiveReason` used everywhere else,
so a brush-off does not pass.

A guard in `tests/smoke.sh` turns red on a silent criterion, and it is proven able to fail: green on a
clean roadmap, red on a planted one.

**What you must not do:** tick boxes to make the number zero. That is the same defect performed
faster, and it shows in the missing evidence. Of the forty triaged, nine closed — which is how many
had actually been verified.

## Permissions and safety

**No prompts during autonomous work.** Routine operations (file edits, git `add`/`commit`/`push`/
`pull`/`fetch`, running tests) are permitted, so the loop is never interrupted by a confirmation
dialog. The decision is made by the `hooks/safety-guard` arbiter hook, which returns an explicit
"allow" for safe operations — this removes prompts in every environment, whatever the mode selected
in the user interface.

**Protection against irreversible damage is minimal by design.** A measurement showed that a broad
rule set blocked 7 out of 11 everyday development commands by mistake, and every false refusal
costs the loop a turn. A rule is kept only when the consequence is unrecoverable AND there is
essentially no legitimate use for it in a development loop. What remains:

1. destroying the filesystem — the root or the entire home directory (POSIX and Windows);
2. formatting or wiping a disk;
3. mass-killing `claude`/`node` processes by image name — that is the loop killing itself;
4. `git push --force` — rewriting shared history.

Everything else is allowed: losses inside a repository are recoverable from git. Blocked commands
are logged to `~/.claude/safety-guard.log`.

**Four guard modes.** `SAFETY_GUARD_MODE` selects one: `arbiter` (the default — the hook decides on
every call, so no prompts appear), `guard-only` (deny the destructive, stay silent otherwise),
`allow-all` (nothing is ever denied, including `rm -rf /`), and `confirm` (name the consequence and
ask for a stated reason instead of refusing). An unrecognised value keeps the safe default and says
so rather than pretending to have obeyed.

**In `confirm` mode**, a refusal tells you how to proceed: re-issue the command with
`# safety-guard: confirmed <why this is right here>`. Use it when you have weighed the consequence
against the task and still judge the command correct — not as a way around a refusal. The reason
must be specific, and it is written to the log next to the command it justified. Rules with no
legitimate use at all cannot be confirmed, and the refusal says so.

**Still being asked for permission?** An `ask` rule in the settings outranks every mode and the
hook's decision. Run `node tools/doctor-permissions.mjs <project>` to see the cause, then
`node tools/gen-settings.mjs --project <project>` to fix it (a backup is written first).

**Secrets are never blocked.** If a commit includes a file that looks like key storage, the
framework writes one line into the log and, when notifications are configured, sends a message.
It does not interrupt the work — the decision stays with you.

## Stop conditions (Ralph Loop)

The Stop hook ends the session (and sends a Telegram alert, if the notification variables are set)
when:

- a **real blocker** is recorded (a missing key or credential, fundamental ambiguity, three
  consecutive failed attempts at the same task);
- the **roadmap is fully released** (`released_version == current_version`);
- the **iteration limit** is reached (`max_iterations`);
- the **budget cap** is exceeded (`budget_metrics.cap_usd`).

The Stop hook also exits cleanly, without blocking, when:

- another live session already drives the loop (the loop lock — do not interfere);
- `docs/STATE.md` is missing or corrupt (fail open).

## Manual escalation

If you (the human) need to interrupt the loop, add an entry to the `blockers:` array in
`docs/STATE.md`. The loop stops at the next gate.

## Session logs

Every session is saved automatically by `hooks/save-session-log` into
`docs/logs/<YYYY-MM-DD>/<HH-MM-SS>_<id>.summary.md` (readable) and `…_<id>.jsonl` (the full
transcript). This is a **forensic and backup** resource — reach for it when the primary sources are
not enough:

- restoring context after a crash or a compaction;
- debugging loop behaviour ("why did it stop / why did it repeat?");
- recovering the reasoning of a past session that never made it into `docs/reports/`.

**How to read them (this matters for your context budget):**

- **grep first** across `docs/logs/**/*.summary.md` and read only the fragments you need;
- do **NOT** open `*.jsonl` in full — it is the complete transcript, hundreds of kilobytes, and it
  will flood your context;
- `docs/STATE.md` (state) and `docs/reports/` (decisions) come first; logs are for when those are
  insufficient.

## Quick references

- Framework architecture and mechanics: `GUIDELINE.md` at the framework root.
- Failure modes and what to do about them: `docs/failure-modes.md`.
- This project's own documents: `docs/userdocs/` (if present).
- Session logs: `docs/logs/` (grep the `*.summary.md` files; do not read `*.jsonl` in full).
- Reports: `docs/reports/`.
