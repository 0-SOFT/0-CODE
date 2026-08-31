# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely, and the project uses
[semantic versioning](https://semver.org/).

> **A note on this file.** Versions before 1.0.0 were developed in a private repository with a
> detailed Russian-language history. That history is not reproduced here; instead each release
> below records what changed and — more usefully — **what was learned**. Where a decision was later
> reversed, the reversal is listed too: this project treats a disproven assumption as a result.

---

## [v1.11.0] — 2026-08-31 — asking instead of refusing

A refusal tells an agent it may not. A request for a reason makes it say why it should. Proposed by
the framework's owner, and the better answer wherever a command has a legitimate use, because the
framework does not know the task and the agent does.

**Rules now carry a level**, and the level decides what the guard is allowed to do about them:

- **hard** — refusing is the only right answer. There is no task context in which destroying the
  machine or cutting the loop is correct, so asking the agent that proposed it to argue for it could
  only ever produce a wrong answer. The marker is ignored here and the refusal says so.
- **confirmable** — the command has legitimate uses. The guard names the consequence and asks for a
  stated reason. A force push is the canonical case.
- **advisory** — worth a moment's thought, not worth a refusal. These exist only in the new mode.

That last level is why the version pays for itself. The rule set is tiny not because little is
dangerous but because a false refusal costs the loop a turn, and three lost turns end it — the v1.2.0
measurement found a broad rule set blocking 7 of 11 everyday commands. When the cost of being wrong
drops to one rewritten command, things dropped in v1.2.1 can come back: `git clean`, `git reset
--hard`, and mounting the filesystem root into a container, which no rule could see at all because
the dangerous part is an argument to an ordinary command.

**The confirmation travels inside the command**, as a shell comment: `# safety-guard: confirmed
<why>`. That is the design rather than a shortcut. The hook lives for a fraction of a second per
call, so remembering a refusal between calls would mean a file, keys, an expiry and races — a lot of
machinery for one idea. Carrying it in the text costs nothing and buys something better: an agent
cannot confirm by repeating itself, it has to rewrite the command and say why, and the reason then
lands in the log beside what it justified. A marker inside quotes is text somebody is echoing, not a
decision, and it is ignored.

A throwaway reason is not a reason: `ok`, `yes`, `because` are rejected, and so is anything under
four words. The bar is deliberately low — a strict judge of prose would become a new source of false
refusals, which is the cost this mode exists to avoid.

**What the mode trades away is named rather than glossed over.** A hard guarantee becomes a
judgement, and the judgement belongs to the same agent that proposed the command. Hence: opt-in, hard
rules stay hard, and every confirmation is written to the log with a `[confirmed]` tag. An allowed
destructive command that left no trace would be strictly worse than a refusal.

**`--force-with-lease` is no longer blocked.** It refuses to overwrite anything that appeared after
your last fetch, which makes it the careful form and the ordinary way to push a rebased branch of
your own. Blocking it alongside the blind form cost a turn on a routine operation and prevented
nothing.

**The `stuck` blocker was removed from the documentation rather than implemented.** It had been
promised for a long time — three failed attempts at one task, a blocker, the loop ends — and the code
never had it: `attempts_per_task` was written empty by the installer and read by nobody. Both halves
of the idea are invisible to a driver. "The same task" has no machine representation; the original
design stored a task key filled in *by the agent*, which is another hand-maintained field and exactly
the defect class v1.7.0 and v1.10.0 removed. "A failed attempt" is invisible too: a driver sees change
or no change, never success or failure. What is observable, `no_progress` already measures. What
stays uncovered — an agent that changes files while going nowhere — is now written down as uncovered.

**A flaky gate, fixed.** One timing test ticked every 150 ms against a 500 ms cap, and that margin
did not survive the whole suite running in parallel: it failed at random. The margin is now 30x. A
flaky gate is worse than a missing one, because it teaches everyone to re-run until green.

Tests 360 (from 346), 26 source modules at or above 80% of lines, smoke 129/0 from the working
tree and 119/0/10 from the published one.

---

## [v1.10.0] — 2026-08-31 — an off switch, a cure, and a hunt

Four items, raised separately by the framework's owner. Three of them turned out to be the same
defect wearing different clothes: **something written by a person and something done by the machine
diverging without a word.** That class now has nine confirmed instances in this project's history,
which is why this release went looking for more of it on purpose rather than fixing four bugs.

**The guard had no off switch, and had been quietly ignoring the attempt.** Two modes existed and
both denied. Worse, an unrecognised `SAFETY_GUARD_MODE` was replaced by the default in silence, so
`SAFETY_GUARD_MODE=off` looked to its author like switching the guard off while the full guard kept
running. There is now a third mode, `allow-all`, which denies nothing at all — including `rm -rf /` —
and an unrecognised value keeps the safe default *and says so*. The acting mode is written into the
decision and into the log, because a mode that never denies leaves no trace otherwise: the log would
look exactly like a quiet day.

**The doctor could name a disease it could not treat.** `doctor-permissions.mjs` diagnosed a real
project correctly — five `ask` rules, which outrank every permission mode and the hook's decision
alike — and advised running `node tools/gen-settings.mjs`, a command that only ever knew its own two
files and did nothing whatsoever to somebody else's project. Re-running bootstrap did not help
either: it deep-merges, a merge unions arrays, and the template has no `ask` key with which to
displace the project's. Verified, not assumed — the rules survived a bootstrap run on a copy of the
real settings.

The generator now takes `--project`, `--user` and `--dry-run`, writes a backup first, and
distinguishes what the framework owns from what it does not: a project's `.claude/settings.json` is
rebuilt from the policy, while `settings.local.json` and the user-level file are personal and get
surgery instead. The `ask` category is removed outright rather than sorted into `deny`, because
growing the deny list is how v1.2.0 ended up blocking 7 of 11 everyday commands.

Applied to the reporting user's real environment with that command rather than by hand — the point
was to test what shipped. Four problems became zero.

**A hook that had never once fired.** The user-level settings carried a `PreToolUse` hook reading
`$CLAUDE_TOOL_INPUT`, a variable the hook contract does not define. Four checks, none of which could
ever match; three of them duplicated the framework's own guard. It was replaced by delegation to
that guard — one source of destructiveness rules, failing open if the path ever moves — plus the one
genuinely personal rule it carried.

**Then the hunt, which found three more.** Method: check claims by behaviour, never by reading, the
approach that found every serious defect in v1.2.0–v1.3.0 while a green suite at 80% coverage found
none of them.

- `AGENT_BACKEND=opencodee` ran Claude. The value failed the supported-list test quietly and fell
  through to auto-detection, while the file's own header promised that an explicit `AGENT_BACKEND`
  always overrides. A different engine, a different price, no signal. It is now refused.
- A misspelt step type routed to the mid tier in silence, quietly buying a weaker model than the
  step deserved. The fallback is right for a missing argument and wrong for a misspelt one, so the
  known set is exported and a test pins every production call site to it.
- The usage header of `gen-settings.mjs` still described two flags an hour after three more were
  added — this class, committed by this release, while hunting this class. A stale usage line is the
  cheapest lie available: free to write, believed immediately, because the header is the one place
  anyone looks before running a command.

That last one produced the most useful artefact of the release: a test that parses every tool's
usage block and asserts each advertised flag is actually read by the file. The class is now caught
mechanically rather than by whoever happens to look.

**The rule that came out of it**, and that now applies across the framework: where a safe default
exists, keep it and report the substitution; where none exists, refuse. A typo in the guard mode
still gets the full guard, because halting a loop over a typo is worse than continuing safely. A
typo in `AGENT_BACKEND` is refused, because "which engine" has no safe default.

Tests 346 (from 335), 26 source modules at or above 80% of lines, smoke 128/0.

---

## [v1.9.0] — 2026-08-30 — limits stop being a default

A deliberate change of defaults by the owner of the framework: a limit belongs to whoever wants one.
Until now a fresh project was handed `max_iterations: 25`, and an absent field quietly became 1000 —
numbers nobody chose for that work.

**Removing a guard turned out to mean three different things.** The three limits were in three
different states, and only one of them behaved the way the request assumed:

- The **spending cap** was already opt-in. `cap_usd: null` in a new project, and the gate has always
  read 0 and null as "off". Nothing to do but confirm it by experiment, which is what happened.
- The **iteration cap** was the real work: absent, `null`, `0` and negative now all mean the same
  thing, no cap, and a new project is created without one. A positive number behaves exactly as it
  always did — the default is gone, the feature is not.
- The **backstop could not be removed at all.** `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` has a native
  default of 8. Deleting the variable does not produce "no limit"; it produces the harshest limit in
  the system, eight consecutive continuations. So "off" is expressed as a deliberately large number,
  100000, and the number stays finite on purpose: a backstop that never fires protects nothing, and
  a hook stuck in a tight failure loop, where a turn costs milliseconds, still terminates.

That last one exposed a confusion worth naming. The backstop is not a second iteration cap. It
counts consecutive `decision:block` replies *within one session*, while `max_iterations` accumulates
across sessions for a version. They are different units, and the backstop exists to survive a defect
in this framework's own hook. From which follows the rule this release writes down: **the backstop
sits above the loop's own limit.** It had not been: a project carried `max_iterations: 4444` against
a backstop of 1000, so the cap somebody deliberately set was silently not the one that applied.
Now the loop says so. The value also had three copies, the oldest complaint in the 0.4.1 audit
(P2.3); it now has one source and a check for the copy that cannot import it.

**The spending cap was promised in more places than it works.** README and GUIDELINE listed it among
the four stop conditions without qualification. In fact `version_cost_usd` is written by the
supervisor alone, which receives the cost of a turn from the engine; the Stop hook writes iteration,
session and blockers and nothing else. Measured rather than assumed: three iterations through the
real hook moved `iteration` from 0 to 3 and left `version_cost_usd` at 0. So under the Stop hook the
cap could never fire, and the documentation was describing a guard that was not there.

Whether the hook could learn the cost was researched instead of guessed. Its payload carries a
transcript path, and the transcript — 1313 records across 12 record types — contains no cost field of
any kind. It has token counts and a model name. Money is therefore derivable only by keeping a price
table per model, service tier, region and token kind: a copy of somebody else's data with no expiry
date, which is exactly the defect v1.7.0 was written to prevent. A guard reporting a wrong number is
worse than one reporting none, because a wrong number is believed. The derivation is refused, and
the limitation is made visible instead: with a cap set under the Stop hook, every continuation now
says the cap cannot fire and names where it can.

**The price of all this, stated rather than softened.** With no limit set, two things stop the loop:
a blocker, and a finished roadmap. The v1.4.0 danger has not disappeared — any `claude` launched
inside a project folder joins the loop. But the first acceptance run walked straight into the
correction: an accidental probe does *not* run unbounded, because three turns that change nothing
produce a `no_progress` blocker. What runs without a bound is an agent that keeps making real
changes, which is what the owner asked for.

**A regression from v1.8.0, caught by v1.8.0.** The coverage gate was measuring nothing. Its parser
had been rewritten for a tree-shaped table while Node 20 on Windows prints flat paths, so it matched
zero source modules — and the vacuity guard added in the same release refused to let that pass as a
green. The parser now reads both shapes, lives in its own module (importing the runner to reach it
spawned the entire suite as a side effect), and is pinned by tests for each shape: it has now broken
twice in opposite directions, and both times the gate reported success while looking at nothing.

Tests 329 (from 319), 26 source modules at or above 80% of lines, smoke 128/0 from the working tree
and 118/0/10 from the published one, export 112 files with zero secrets and zero untranslated text.

---

## [v1.8.0] — 2026-08-28 — the installer stops promising more than it does

Reported from a live project running v1.7.0. An agent stood idle for more than six hours, waiting on
a background job that had finished five minutes after it started. Three separate defects had lined
up behind that one silence, and the report naming them was accurate enough that two of its three
diagnoses could be checked against this repository's own source — where one of them turned out to be
aimed at the wrong mechanism, and one turned out to be worse than described.

**The installer announced a loop that was not running.** The project had been started without the
framework and adopted it half-way through, from inside a working session. `bootstrap.sh` finished
with "The Ralph Loop is now active" — and it was not: Claude Code reads `.claude/settings.json` when
a session *starts*, so hooks written into that file mid-session are in the file and not in the
process. Nothing brought the agent back when its turn ended, and the human had every reason to
believe something would. The installer now recognises an in-session install and closes with how to
restart instead, as the last thing it prints; a first attempt put that warning in the middle of the
summary, where a live run showed three more sections scrolling past underneath it.

The report suggested failing the install with a non-zero exit code to make the warning impossible to
miss. **Rejected**: the installation genuinely succeeded, a non-zero code would trade a false
success for a false failure, and it would break both scripted installs and this project's own
end-to-end check. Visibility was bought with position instead.

**The installer replaced `.gitignore` and a rule went with it.** The project's own file had a line
hiding a document of root passwords for two servers. `copy_if_missing` — a name that reads as "only
copies when absent" — replaced the file after taking a backup, and the next commit picked up the
secrets. Nothing was lost: the backup was there, and the report says so plainly rather than claiming
data loss. What was wrong was the active file, and the price of being wrong about it is not
symmetrical — a lost formatting rule is an inconvenience, a lost ignore rule is a leak.

Worse than the name was a comment directly above the `.gitignore` call stating that the function
"never overwrites existing files". It always did. A reader checking whether the install was safe
would have found the reassurance and stopped there. Additive files are now merged: existing lines are
never touched, missing ones are appended under a marked header, and a repeated install adds nothing.
All fourteen copy sites were reviewed to find out how many were additive — exactly these two; the
rest are framework artefacts that must match the framework version, and files handled correctly all
along (`CLAUDE.md` appended between markers, settings deep-merged, STATE created only when absent)
were confirmed rather than assumed.

**The loop could not tell a working agent from a waiting one — and the reason was not the one
proposed.** The report suggested adding a `last_action_at` check to the gates. Measured: that would
not have prevented this incident at all. Gates run inside the Stop hook, the Stop hook was never
registered in the running process, and no check inside a thing that never runs can fire.

The real hole was elsewhere and wider. `core/progress.mjs` — three signals, escalation after two
empty turns, a `no_progress` blocker after three — exists, is tested, and was imported by exactly one
file: the OpenCode supervisor. The Claude Code Stop hook, the default driver and the one in the
incident, never referenced it. Meanwhile `SKILL.md` and `docs/failure-modes.md` described the
behaviour as a property of "the driver". **The promise had been false for the default engine across
five releases, because nothing ever compared the document with the code.** The detector is now wired
into the hook, and a guard fails if any driver stops reaching it — the defect is a class, not a case.

Wiring it needed memory: the supervisor is a long-running process that can hold a snapshot in a
variable, while the hook exists only at the end of a turn. Keeping that memory in STATE was the
obvious candidate and is wrong by construction — the hash of STATE is one of the three progress
signals, so the detector's memory would live inside the artefact it measures and every write would
register as progress. It lives beside the loop's other process state instead. One consequence is
stated rather than hidden: the hook measures the interval between its own invocations, so its first
run is a baseline and the count begins one turn later than on the supervisor. Guessing whether the
first turn did anything would have been worse.

**And the suggestion, taken for the case it does fit.** `last_action_at` had been written since the
first version and read by nothing — decoration in a schema. It is now read: if STATE has stood
untouched longer than `stall_timeout_minutes` (20 by default), the continuation text says so, naming
the elapsed time. It never stops the loop; a false stop costs more than a false warning, because the
loop exists to run without a human. What it closes is the case the turn counter cannot see — turns
that happen, take a long time, and produce nothing.

**A second promise turned out to be true for one driver only, and was closed in the same version.**
Checking for others found the secrets notice: README, GUIDELINE and docs/failure-modes all state,
without naming an engine, that a commit picking up a file which looks like key storage earns a line
in the log and a notification. It was wired into the supervisor alone. On the default engine nobody
was watching — which is precisely where the live project committed its file of root passwords, and
only human eyes caught it. Wiring it needed nothing new: the snapshots the progress detector had
just been given are exactly what the notice takes. It informs and still blocks nothing, the decision
this project has held since v1.5.0. The guard now covers every mechanism the documents describe as
belonging to "the driver", not just the one that started this.

Tests: 315, all green, 25 source modules at or above 80% of lines. Smoke: 126 checks from a working
tree, 120 of them from a fresh clone where six declare themselves skipped. Export: 109 files, no
forbidden patterns, nothing untranslated.

---

## [v1.7.1] — 2026-08-26 — one protection policy, stored once

Found by an ordinary act of housekeeping rather than by an audit. The maintainer synchronised the
repository with `git add . && git commit && git push`. That commit carried into the public
repository a directory of page snapshots left behind by an MCP server — artefacts of an entirely
unrelated project — and, in the same breath, added to `templates/gitignore.public` three lines with
a comment written in the maintainer's own hand: *opencode.json inlines REAL secrets, never commit
it.*

**Those three lines were absent from the repository's own `.gitignore`.**

The ignore policy was one statement stored in two files, with no shared source and nothing
comparing them. `tools/provision-opencode.mjs` reads `config/.env` and substitutes live MCP keys and
session strings into the `opencode.json` it generates. The path to a published credential was fully
assembled and three steps long — provision, `git add .`, `git push` — and the last two had just been
performed. Only the first had not: OpenCode had never been provisioned on that machine. Nothing
leaked; a scan of the whole published tree for every credential shape came back clean.

**The direction of the drift was the worst available.** The protection lived in the copy that guards
*other people's* machines and was missing from the copy guarding the machine where the real
`config/.env` sits.

This is the fourth instance of a class v1.7.0 closed three times — the `next_step_prompt` cache,
`framework_version`, and two copies of `SKILL.md`. The first three corrupted an instruction. This
one publishes keys. A copy without a shared source drifts by construction, not by accident, and the
only lasting answer is to stop storing the statement twice.

**The justification for the second copy did not survive measurement.** `tools/export-public.mjs`
had explained it: the development tree's ignore file "mentions internal directories that do not
exist" in the published one. Measured: the loop's own artefacts were already in *both* copies,
because published code creates them for published users too; the remaining development-only entries
are created by nothing in the repository at all — one of them names a directory that has not existed
since the 0.4.x prompts that mention it; and an ignore entry naming a path that does not exist is
inert. The claim was carrying a drifting second copy for nothing.

Both files are now rendered from `lib/ignore-policy.mjs` by `tools/gen-ignore.mjs`. Two files still
exist, because git needs one at the root of each tree — but they are no longer two sources. Smoke
section 14 is the reader half: it fails if either file drifts from the policy, and it asks git
rather than reading lines, because a rule that is written down and a path git actually refuses are
different claims. The rule check and the index check are kept separate: a rule cannot save a path
already in the index, which is exactly how the snapshots reached the public repository. They were
removed from the index with `git rm -r --cached`, and they stay on disk.

**A gate that is red everywhere it is used is not a gate.** The sanitisation check scanned
`config/` wholesale, and therefore read `config/.env` — a file that by design holds live values on
every working machine, is ignored by git, and is never published. The suite was red wherever the
framework was actually used and green only where it was not, which teaches people to ignore red.
Excluding that one filename would have been muting: the next secret-bearing file would arrive and
the exclusion list would become a second policy, drifting away from the first. Instead the scan now
asks git what it *would* stage — the index plus untracked files no rule covers — so no filename is
special-cased and an entry added to the ignore policy leaves the scan through the same door.
Measured here: 511 scannable files against 512 on disk, the single difference being `config/.env`.
A positive invariant replaces the false alarm: that file must be ignored *and* absent from the
index, because excluding something from a scan is honest only while something else still asserts it
cannot be committed. The scanner also masks what it finds; the previous form printed a live token
into the suite's own output.

**What was deliberately not done.** The commit that exposed all this carries no message — the shell
took a three-dot argument literally. It was not amended and history was not rewritten: pushed
history is not rewritten in this project (v1.6.0 established that when a guard refused to move an
already-published tag, and the fixes were given their own version instead), and the force variants
of `git push` sit in the permission denylist. A commit that says nothing is corrected by a changelog
that says something — see below.

**The release gates found two more defects, both of the same family.** The export gate refused to
build the published tree: the commit described below had put Russian strings into a file the
manifest publishes, and the language check caught it — measured, that file went from zero Russian
lines to three. And the coverage gate turned out to have been passing vacuously since v0.9.0. Node
prints its coverage table as a tree — a directory row, then its files indented one level deeper
carrying only their basename — and the parser matched that basename and then demanded a directory
separator inside it. Nothing ever matched, so nothing was ever below the threshold, and every run
printed `OK all source modules (0)`. A green that meant "not looked at", sitting in plain sight
behind a number in brackets that nobody read. It now reconstructs the path from the indentation,
checks 24 modules, and **fails outright if it selects none** — a gate that cannot silently be empty.

That also settled an open question from earlier in the release. A tools module had been recorded at
74.80% line coverage against a documented 80% threshold. Neither figure was wrong: `tools/` was
never inside the gate's scope, and the 74.80% was an artefact — no test imports that module, the
smoke suite spawns it, and while one acceptance test still ran the whole smoke suite inside the
coverage harness, the child process's coverage was being folded into the report. Removing that test
removed the artefact.

### What commit `2c24dd4` actually contained

Its own message is three dots. For the record, it carried:

- **Python MCP servers moved off bare interpreters.** `2captcha`, `manus` and `email` were switched
  from `python -m <module>` and hand-built virtualenvs to console scripts installed with
  `uv tool install <package> --with 'mcp<2'`. Two reasons, both measured: `python -m` fails on any
  system interpreter without write access, and the packages declare `mcp>=1.x` with no upper bound
  while MCP SDK 2.0.0 removed `Server.list_tools` and the `mcp.server.fastmcp` module — unpinned,
  the servers die at startup. `manus` and `email` also stopped being marked as needing manual setup:
  both are on PyPI and install in one portable command.
- **OpenCode provisioning hardened**, and `templates/gitignore.public` gained the entries whose
  absence elsewhere this release is about.
- **Two task documents** under `docs/userdocs/`, which is excluded from publication.
- The same commit also introduced Russian strings into `config/global-settings.template.json`, a
  published file, which broke the export language gate. Repaired here: the hook rework itself was an
  improvement — exec form, JSON on stdin, timeouts in seconds — and only its user-facing strings
  went back to English.

Tests: 287, all green, with the coverage gate finally checking the 24 source modules it was always
supposed to. Smoke: 125 checks from a working tree, 119 of them from a fresh clone where six
declare themselves skipped. Export: 103 files, no forbidden patterns, nothing untranslated.

---

## [v1.7.0] — 2026-08-25 — the step instruction gets an expiry date

Reported from a live project running v1.6.1. The loop would not finish. On every Stop hook, for two
whole chains of work, the agent was handed the same instruction — one written back in the 4.6.0 era,
announcing a blocker named `awaiting_user_direction` — while STATE said `current_version: 6.4.0` and
`blockers: []`. The text contradicted the machine state and still read as the more authoritative of
the two. Dozens of iterations were spent on it, and the loop could not stop at the point where a
human was actually needed: there was no real blocker, and the stale text kept saying "carry on".

**The hook and the gates were working correctly.** `next_step_prompt` is a *cache* of an
instruction; its real source is where the loop stands — version, stage, prompt file, read against
the roadmap. A cache with no invalidation drifts away from its source by construction, not by
accident, and nothing on either the write or the read side ever checked. The same class of defect
was sitting in the framework's own STATE at the time: `framework_version` claimed 1.5.0 while 1.6.1
was out.

**The obvious fix was rejected.** The report proposed dropping the field and deriving the reason
from `current_prompt_file` instead. Measured against the actual data, that trades one problem for
three: a prompt file is a whole version's document while the instruction is a single step (700–2500
characters in the logs); the field is legitimately null (it was null in this very repository at the
time); and feeding a version document to a headless process on every turn is paid for in budget.
The field stays. What it lacked was an expiry date.

**Four guards, aimed at the class rather than the case:**

- `lib/step-instruction.mjs` — one definition of "where the loop stands", used by both the writer
  and the reader, so the two cannot disagree. It lives in `lib/` because the dependency direction
  in this project is core → lib.
- A **barrier on the way in**: a patch that moves `current_version`, `current_stage` or
  `current_prompt_file` without rewriting `next_step_prompt` is refused, and the message names what
  moved. Clearing it on purpose still works (`"next_step_prompt": null`). There is deliberately no
  bypass flag — a bypass would recreate the defect.
- A **passport** minted by `lib/update-state.mjs` on every write, from the merged state, never by
  hand. A field maintained by hand would simply be a second cache with the same disease.
- A **guard on the way out**, plus a machine-truth header. Every continuation reason now opens with
  a block generated from STATE — version, stage, iteration out of the cap, `blockers: none`, prompt
  file — and states that this block outranks anything below it. Projects with no passport (anything
  created before this release) fall back to a conservative heuristic: an instruction naming versions
  that do not include the live one is dropped. Both drivers write the reason for dropping it to
  stderr, because a silent drop would trade one quiet failure for another.

Refusing rather than warning is a deliberate repeat of the reasoning behind the export gate: a
warning in a log is read by nobody, and the price of this particular drift was dozens of wasted
iterations.

**`framework_version` was left alone on purpose.** It is a historical fact — which release created
this project — and overwriting it would erase exactly the answer you need when diagnosing an old
project. The drift was not in the field but in reading two meanings into it. The version *running*
is a separate fact, and it is not stored in STATE at all: it is read from
`.claude-plugin/plugin.json`. The schema now says so.

**Verified by behaviour, not only by tests.** The reproduction from the report was driven through
the real Stop hook: the stale instruction is not handed over, the driver explains why, and the agent
receives the machine truth instead. Tests 256 (from 234), every one of 22 source modules at or above
80% of lines, smoke 119/0 (113 from the published tree), export 96 files with zero secrets and zero
untranslated text.

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
