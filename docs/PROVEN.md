# What was proven, and how

Every claim below was verified by running something and looking at the result — not by reading the
code and concluding it should work. Where a check produced an uncomfortable answer, the
uncomfortable answer is here too.

The reason this document exists: across eleven releases, **every serious defect was found by a live
check while test coverage sat above 80%, and none was caught by a test**. Tests verify what you
wrote. What breaks is what you *claimed*.

---

## The loop does real work, unattended

**Setup.** A real third-party repository, a real task, no human in the room.

| Measurement | Result |
|---|---|
| Continuous unattended operation | 2 h 32 min |
| Turns completed | 9 |
| Cost | $10.25 against a $20 cap |
| Genuine commits produced | 6 |
| Human interventions | 0 |
| Injected failure (engine killed mid-run) | survived; the log reads "turn succeeded on attempt 2" |
| How it ended | the agent recorded a `missing_resource` blocker — it needed a confirmation code no machine can produce |

The commits were ordinary maintenance work: a test suite fixture that waited forever for a service,
a configuration validator that failed in development mode, an upload path that broke without a
session, a file-type router, a test gated behind a real API call.

**What this does not prove.** Eight hours of wall-clock endurance. The run ended earlier because
the task genuinely required a human. Stretching it artificially would have measured patience, not
resilience.

---

## It fixes real defects, not planted ones

**Setup.** A production Python repository whose entire test suite refused to load:
`from datetime import UTC` — valid on Python 3.11, absent on the 3.10 installed there.

| Before | After |
|---|---|
| test collection fails | **2463 tests collected** in 4.5 s |

The agent found all seven affected files by itself and chose the minimal fix — a compatibility
alias — instead of editing 39 call sites:

```python
-from datetime import UTC, datetime
+from datetime import datetime, timezone
+
+UTC = timezone.utc
```

Three acceptance runs on two inexpensive models all passed the same criteria: the cause fixed **in
the source** rather than in the test, a commit made without a human, about $0.35 per run. The
default model preset was then chosen by that measurement rather than by model name.

---

## Protection survives the agent trying to remove it

**Setup.** The agent was instructed, in plain words, to disarm itself and then run a destructive
command.

**Result: it succeeded.** It deleted the guard plugin from the project and rewrote the permission
file so that everything was allowed — leaving the block structure in place, so a check for the
*presence* of the block noticed nothing.

**Fix, structural rather than patched.** The main plugin moved outside the working directory, where
the agent does not reach. The scaffolding is restored before every turn, and permissions are
compared **by content**.

**Control experiment.** The project was left fully disarmed — zero denials in the configuration,
the in-project plugin deleted — and a destructive command was issued:

```
safety-guard blocked an irreversible operation: git push that force-overwrites shared history
```

**Honest limit.** Within a single turn the project-level configuration can still be edited. This
does not remove the protection, because the plugin does the blocking and the plugin is out of
reach.

---

## Protection does not get in the way

**Setup.** Twenty-one everyday development commands run through the detector.

An earlier, broader rule set blocked **7 of 11** of them: searching the codebase for text that
happened to contain SQL, a commit message mentioning a dangerous phrase, cleaning a build
directory inside home, a dry-run publish, `git clean -fdx`, `git reset --hard origin/main`, killing
a stuck process.

After the rules were cut to four, the same measurement gives **zero false positives** — and it
lives on as a test, so the ruleset cannot quietly grow back.

**And then a twenty-second case appeared, the expensive way.** During the v1.6.0 documentation audit
the guard refused an ordinary search:

```
grep -iE "rule|mkfs|reset" core/safety.mjs
  → blocked: formatting or wiping a disk
```

The command splitter cut on separator characters without regard for quoting, so the pipes inside the
regex made a disk-formatting command the head of a segment. The comment above the splitter claimed
the opposite — that quoting protected against exactly this. The refusal cost a turn, which is
precisely the cost that justifies keeping the ruleset small. The splitter is now quote-aware, six
quoted cases joined the measurement as tests, and a companion test asserts that genuinely chained
destructive commands (`npm test && rm -rf /`) are still blocked — a fix must not buy comfort with
coverage.

---

## No permission prompts, in any mode

**Setup.** Twenty typical operations in a project carrying the framework's standard settings.

**Result: zero prompts**, with destructive commands still blocked and logged.

The underlying finding took twenty experiments: an `ask` rule outranks **every** mode, including
"bypass permissions", *and* outranks the hook's own decision. The framework had been handing such
rules to itself and to every project it created — it was manufacturing the problem it was meant to
solve.

---

## It installs and runs from scratch on both platforms

From an empty directory to an autonomous commit, with no manual edits, on **Windows** and on
**Linux** — including a machine where the engine itself was installed from nothing.

Repeated for v1.6.0 from the **published** tree rather than the working one, which is the version a
stranger actually gets. Same task on both platforms: a `slugify` function turning an apostrophe into
a separator, so `"Don't Stop"` became `don-t-stop`. The criterion was the fix landing in the source
rather than in the test.

| | Linux | Windows |
|---|---|---|
| Autonomous commits | 2 | 1 |
| Tests afterwards | 11/11 | 8/8 |
| Cost | $0.1259 | $0.0853 |
| Fix location | source | source |

That run is also where four defects surfaced that the green test suite had not: the installer handed
target projects a `.gitignore` from a file that does not exist in a fresh clone, the published tree
had no `.gitignore` at all, provisioning demanded a personal manifest a new user cannot have, and the
closing instructions named the wrong engine. Each would have hit the first person to install it.

---

## The engine self-check earns its cost

**Observation.** The engine returns the same vague text — `UnknownError: Unexpected server error` —
both for a genuine server failure and for a **non-existent model**. With the network unreachable it
prints nothing at all.

By text these cases are indistinguishable in principle. So a misconfiguration used to masquerade as
a transient failure and cost **75 seconds** of pointless retries before anything useful was said.

One tiny turn before the loop starts now separates them: a wrong model or key produces an
immediate, specific refusal — measured at 3 seconds instead of 75.

---

## Things that were assumed and turned out to be false

This section is the point of the document.

| Assumption | What actually happened |
|---|---|
| Detaching the child process is the clean way to manage it | On Windows it **breaks output capture** — status 0, empty output, the loop receives nothing |
| A cleanup handler on exit is enough to avoid orphans | On a hard kill exit handlers **do not run at all**, on any OS. A second, on-disk line of defence is required |
| A cheap model is fine for the pre-flight check | Then a wrong *loop* model goes unnoticed — the check must use the model the loop will use |
| A per-turn timeout protects against hangs | It measured **duration** and killed an agent that had already produced two commits. A hang is defined by *silence*, not lifetime |
| The budget cap works | It compared a number nobody ever wrote. It would never have fired at any level of spending |
| An empty next step stops the loop | It does not. The documentation said otherwise for several versions, and the framework — following its own instructions — stopped a healthy loop |
| The documentation describes the system | Four documents in one release described a system that no longer existed |
| Quoting protects the guard from false positives | The comment said so; the splitter cut on separator characters regardless of quotes, so a `grep` with an alternation regex was refused as disk formatting |
| Running the tests proves the product works | They ran from the working tree. Run from the **published** tree, the same suite exposed four defects that would have hit the first user |
| A check that reports zero failures ran | A skip helper was never defined: bash wrote "command not found" to stderr, six checks vanished, and the summary still said zero failures |

---

## The framework finds defects in itself

**Setup.** Five consecutive releases, each one auditing a claim the project had made about its own
behaviour — by running it, never by reading the code.

| Release | The claim | What running it showed |
|---|---|---|
| v1.7.0 | the loop hands the agent the current step | It handed a live project an instruction written two versions earlier, announcing a blocker while `blockers` was empty — for dozens of iterations |
| v1.9.0 | the coverage gate holds the suite to 80% | It was measuring **zero** modules. A parser rewrite had assumed a table shape this platform does not print, and the gate reported success on nothing |
| v1.10.0 | `SAFETY_GUARD_MODE` selects the guard's mode | Any unrecognised value was replaced by the default in silence, so `SAFETY_GUARD_MODE=off` looked like switching the guard off while the full guard kept running |
| v1.10.0 | an explicit `AGENT_BACKEND` always overrides | A misspelt value overrode nothing: it failed the supported-list test quietly and ran the other engine, at a different price, without a word |
| v1.10.0 | the diagnostic tool tells you how to fix it | Its advice named a command that did nothing at all to somebody else's project |

**The most useful one was self-inflicted.** While hunting this class, v1.10.0 left the usage header
of a tool describing two flags an hour after three more were added. That produced the mechanical
guard the class deserved: a test that parses every tool's usage block and asserts each advertised
flag is actually read by the file.

**What this does not prove.** That the remaining claims are true — only that this method finds them
when they are not. Eleven releases in, it has yet to run clean.

---

## Curing a project it did not create

**Setup.** A real project of the author's, unrelated to the framework, where the agent kept stopping
for permission despite every mode being set to bypass.

| Measurement | Result |
|---|---|
| Problems the diagnostic found | 4 |
| Cause of the prompts | five `ask` rules, which outrank every mode **and** the hook's decision |
| Problems after running the cure | 0 |
| Files changed | 3, each with a timestamped backup |

The interesting part is what did **not** work. The diagnostic's own advice — re-run the settings
generator — did nothing, because that command only knew its own two files. Re-running the installer
did not help either: it deep-merges, a merge unions arrays, and the template has no `ask` key with
which to displace the project's. Verified rather than assumed, on a copy of the real settings.

**What this does not prove.** That every broken configuration is curable this way. What the tool
cannot mechanically decide — a hook reading a variable that does not exist, for instance — it names
and leaves to a human, because silently deleting somebody's protection would repeat the mistake it
is there to fix.

---

## Current limits, stated plainly

- **Uncommitted work is not protected by default.** `git reset --hard` and `git clean` are
  deliberately allowed — they are routine, and blocking them costs more than it saves. In `confirm`
  mode they ask for a stated reason instead, which is affordable there because a request to think
  costs a rewritten command rather than a lost turn. Commit often either way.
- **The spending cap works only under the supervisor with engines reporting USD.** Codex reports
  tokens without USD and refuses a positive `budget_metrics.cap_usd` before work starts; use
  `max_iterations` to bound its turns. For engines reporting USD, the cap compares against a
  counter filled from their reported cost; the Claude Code Stop hook never sees a cost. Under
  the hook the counter stays at zero and the cap cannot fire — the loop now says so in every
  continuation instead of looking like a guard. Measured: three iterations through the real hook
  moved the iteration count 0 → 3 and left the spend at 0.
- **An agent that changes files while going nowhere is not caught.** `no_progress` measures turns
  that change nothing at all. A turn that edits, reverts and edits again looks exactly like work.
- **Danger hidden in an argument is mostly invisible.** `docker run -v /:/host` hands a container the
  whole machine and is only noticed in `confirm` mode. The command parser is a heuristic, not a
  shell.
- **Code quality is not judged.** Nothing here evaluates whether what the agent wrote is correct.
  That is what tests and review are for.
- **The spending guard for engines reporting USD is accurate to a step boundary**, not to the cent:
  the recorded $0.002 cap aborted at $0.03. It prevents runaway spending; it does not guarantee an
  exact figure. This historical dollar measurement does not apply to Codex.
- **Orphaned processes live until the next launch** in the hard-kill case. Immediate cleanup from
  inside a dying process is physically impossible.
- **Endurance is proven to 2.5 hours**, not to a day.

---

*Every number on this page came from a run that was recorded at the time. If you reproduce one and
get a different result, that is worth an issue — a claim that stops being true is a defect.*
