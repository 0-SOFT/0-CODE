# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely, and the project uses
[semantic versioning](https://semver.org/).

> **A note on this file.** Versions before 1.0.0 were developed in a private repository with a
> detailed Russian-language history. That history is not reproduced here; instead each release
> below records what changed and — more usefully — **what was learned**. Where a decision was later
> reversed, the reversal is listed too: this project treats a disproven assumption as a result.

**Current release: v1.20.0.** Measured on 2026-09-18, from the published tree run as a real git
repository: **476 tests** (5 announced as skipped there, because they exercise a tool that is
deliberately not published), **132 smoke checks** with 6 announced as skipped, **31 source modules**
at or above 80 % of lines, **124 files** exported with no secrets and nothing untranslated. Branch
coverage is reported but deliberately not gated — the lowest is `hooks/ralph-loop-stop.mjs` at 12.5 %,
which is what a module exercised only through a subprocess looks like from here.

---

## [v1.20.0] — 2026-09-18 — the commands reached nobody, and the tree never said where to find itself

The release that made the repository publishable. Two of the three defects below were found by
someone trying to *use* the project rather than read it, which is the only kind of finding that
counts here.

### The audit commands were distributed nowhere

`/productionaudit` and `/productionauditloop` existed only in the framework's own `.claude/commands/`,
and nothing shipped them: not the installer, not the plugin, not the publication manifest. Measured on
a real target project running framework 1.18.1 — `core/audit-ledger.mjs` was there, all four audit
templates were there, and the two command files were not. Everything the commands need arrived; only
the commands did not.

**The first fix was wrong, and running it is what showed that.** It copied `.claude/commands/`
wholesale — which is the *maintainer's own working set*, and it held a personal command carrying the
IP address of a private server. That installer would have shipped somebody's infrastructure into
every project it touched.

So the boundary was made structural rather than a list of names, exactly as it already is for the
skill: `commands/` is the framework's source, `.claude/commands/` its local working copy. A list has
to be remembered; a directory cannot be forgotten. A guard now holds the two copies to be identical
where a name exists in both, and separately asserts that no personal command leaked into the
distributed set — verified by planting a divergence and watching it turn red.

The installer treats an absent `commands/` as normal rather than fatal: a published tree may
legitimately carry none yet, and failing over an optional artefact turns a missing convenience into a
broken install. That is what happens here — the commands are written in Russian and the published tree
is English-only, so they stay behind the language gate until translated. The *mechanism*
(`core/audit-ledger.mjs`) ships and works.

### Nothing in the tree said where to get the tree

Found while walking the publication checklist. The acceptance test for publishing reads: *a stranger
can clone the repository and reach the first autonomous commit without once asking the author.* The
measurement:

```
git clone / repository URL in README.md, QUICKSTART.md, GUIDELINE.md, CONTRIBUTING.md:  0
```

Every install instruction began at `bash /path/to/0-code/bootstrap.sh` — a path the reader has no way
to obtain. The documentation described operating the thing and never described acquiring it, which is
invisible from inside a checkout and fatal from outside one. Clone lines were added to `README.md` and
`QUICKSTART.md`, and the placeholder path corrected to the real repository name.

### Two files claimed a version that did not exist

`bootstrap.sh` and `tests/smoke.sh` carried comments dated `v1.20.0` while the changelog's newest
entry was v1.19.0 and `docs/STATE.md` reported v1.19.0 as released. The work was real and the
bookkeeping was missing, so tagging the tree `v1.19.0` would have pointed a tag at content that
release never contained. This entry is that bookkeeping.

### Also

- `LICENSE` carried a placeholder copyright holder; it now names the actual one.

### Gates

476 tests (471 passed, 5 announced skips), smoke 132/0/6, 31 source modules at or above 80 % of
lines, export clean — all measured from the published tree run as a real git repository.

---

## [v1.19.0] — 2026-09-02 — the public tree catches up, and the gate that guards it had a hole

Six releases of work had never reached the public repository. Moving them across turned up two
defects that a straight copy would have shipped, and one that would have gone out unnoticed.

### The numbers had drifted for the second time, so they were removed instead

```
README.md        claimed 378 tests, 119 end-to-end
GUIDELINE.md     claimed 360 tests, 129 smoke
CONTRIBUTING.md  claimed 378 tests, 119 end-to-end
measured                476 tests, 137 smoke
```

Three files, three different stale figures, disagreeing with each other as well as with reality. The
v1.12.0 entry in this file describes fixing exactly this by hand — "numbers from six releases
earlier" — and six releases later it was back. Fixing it by hand a third time is doing the same thing
and expecting a different result, so the choice of remedy was written down first.

The measurement that decided it: of 33 places in published documents carrying a number, **26 are
historical** — per-release figures in this changelog, which are facts about the past and must *not*
match today. A guard would therefore need a marker to tell live from historical, and once there is a
marker you are most of the way to generating the block anyway. Meanwhile the live surface is five
numbers in three files, and in two of them the number sits in a code comment describing what a
command printed once. A comment should say what a command *does*.

So the live numbers are gone from prose, and the one that remains lives at the top of this file. The
arithmetic was not close — 31.5 against 12, 10 and 9.6 — and the record says which option lost to
what. It also says what would disprove the choice: if this header itself goes stale by the next
release, one visible place was not enough and the block has to be generated.

### Six versions of mechanisms nobody could have discovered

```
long-running work / running_jobs   documented only in the failure catalogue
one owner per loop, liveness       documented only in the failure catalogue
two-modes.md                       NOWHERE — the file existed, nothing linked to it
decision records                   NOWHERE
roadmap review                     NOWHERE
/productionaudit, /productionauditloop   NOWHERE
acceptance criteria                NOWHERE
```

This is the inverse of the defect this project usually finds. Normally a claim stops matching the
behaviour; here the behaviour was never claimed at all. A reader would have received the code and had
no way to learn it was there — worse than a stale number, because a stale number is at least visible.

Each now appears where someone looking for it would look: a row in the README table, a section in the
guideline, and a link to `docs/two-modes.md` from the documentation index. The annotated structure map
had also been broken since v1.13.0 — a new module was inserted *into the middle of another module's
description*, splitting it — and four later modules were missing from a map whose job is to list every
file.

### The gate that guards publication could not see the file it should have caught first

The export refuses to publish secrets or untranslated text, and it announced a clean tree. An
independent check then found **212** matches of the forbidden alphabet in `.gitattributes`, comments
that would have gone public.

The gate selected files **by extension**, and a name with no extension matched nothing in its list.
Four published files are in that position: `.gitattributes`, `LICENSE`, `hooks/ralph-loop-stop` and
`config/.env.example`. It is the same shape as the guard defect fixed one release earlier — a rule
written against the form of a name when the danger is in the content — and it had no tests at all,
which is why it survived.

**The first fix almost shipped with its own hole, of the same family.** Deciding "is this text?" by
looking for a NUL byte means a file that is text in every other respect but contains one is skipped
in silence — and the very test file written for this fix contained a real NUL, so the repaired gate
looked straight past its own untranslated fixtures and called the tree clean again. The root was not
the NUL: "no verdict" and "clean" were the same answer, which is the distinction v1.13.0 exists for
and v1.18.0 already repeated once. A file that is neither plainly text nor a known binary is now
reported rather than skipped.

The gate now has tests, and they are written to survive publication: they skip themselves aloud in a
tree where the tool is absent, and they build their forbidden sample from code points so that the
test does not smuggle in the thing it tests for.

### The public tree

Refreshed to v1.19.0 and audited from inside itself, as a real git repository: 476 tests with 5
announced skips, 131 smoke checks with 6 announced skips, every source module at or above 80 % of
lines, and an independent sweep finding zero forbidden characters and zero binary bytes across 126
files. Internal directories — prompts, reports, decisions, session logs, the owner's own notes — are
absent, and `config/.env.example` carries names with every value empty.

**Nothing was published.** The commit sits in the local public repository, which has no remote
configured; releasing it is the owner's action, by hand.

---

## [v1.18.1] — 2026-09-02 — a hard rule with a hole in the only shell that matters

A one-rule release, and the rule is the one whose failure cost the most in this project's history.

`core/safety.mjs` has forbidden killing Claude or node **by image name** since v1.2.1, for a reason
its own comment states plainly: it takes down every session on the machine, including the loop's own.
On 2026-09-01 an agent in this repository ran

```
taskkill //FI "IMAGENAME eq claude.exe" //F
```

the guard **allowed** it, and a Claude Code session belonging to an unrelated project died mid tool
call. Measured after the fact, side by side:

```
taskkill /IM claude.exe /F                     -> deny
taskkill //FI "IMAGENAME eq claude.exe" //F    -> allow
```

Neither half of the second spelling is exotic. The doubled slash is what MSYS/git-bash requires on
Windows so the shell does not rewrite `/F` into a path — it is how every Windows flag has to be
written in the shell this framework actually runs its commands in. And `/FI "IMAGENAME eq ..."` is
the documented filter syntax, not a trick. The rule matched one spelling of the thing it forbids.

**The root is not the missing spelling.** A rule written against a command line will always be one
spelling behind, because the next accident writes it differently again. What is dangerous is
**selecting processes by name**; which flag expresses the selection is an accident. The rule now says
that: the image-name flag in either slash form, the filter form that names the selector in its value
rather than its flag, and PowerShell's `-Name`, which is the same selector in the other shell on this
platform.

Killing one process by its id stays allowed in every spelling, because that is the legitimate way to
stop something and refusing it would cost the loop a turn every time it cleaned up after itself.
Talking about the command — an `echo`, a `grep`, a commit message — is still text rather than an act,
which matters because the tests for this rule contain the strings.

**Worth naming for what it says about verification.** The rule was covered by tests, and the tests
passed, because they exercised the spelling the author had in mind. The incident was found by reading
a session log, and the hole was found by putting the exact failing command through the live hook
rather than through the module. That is the same method that found every serious defect in v1.2.0 and
v1.3.0: check the claim by behaviour, at the boundary where it is actually used.

Tests 471, all source modules at or above 80 % of lines, 137 smoke checks, export clean. No live
engine run was performed, and nothing was published.

---

## [v1.18.0] — 2026-09-01 — an acceptance criterion stops being decoration

The first version of this project raised by a mechanism rather than by a person or a plan: the
roadmap review shipped in v1.16.0 fired for the first time and found what nobody had looked at.

```
open acceptance criteria ..................................... 46
  saying out loud that they were not met ..................... 2
  saying nothing ............................................ 44
```

Forty of the silent ones belonged to versions declaring themselves RELEASED. From the roadmap there
was no way to tell a version that fell short of its own bar from one where somebody forgot a tick.

**The price of that silence was measured the same day.** v0.9.0 had carried an open criterion — "the
>=80 % threshold for lines **and branches** is met" — since release. The first real audit run
(v1.17.0) rediscovered exactly that, four versions later: the coverage gate had never checked
branches, and the two files that decide whether the loop continues and whether a dangerous command
runs sat at 12.5 %. The roadmap knew. Nobody read it.

### The arithmetic disagreed with the author, and was right

Where to put the check was decided in the open. The instinct was a barrier at the moment of release,
the way both existing barriers in this project work. The numbers said otherwise: 28 against 18, and
the difference was cost — a barrier would have coupled the state tool to the format of a document it
has no other reason to know, for two points of impact out of nine. It is the first time the mechanism
shipped in v1.16.0 changed a decision instead of confirming one.

### The rule had to be derived from data three times

The marker for a deliberately open criterion is a **shape, not a word** — a bold opening ending in a
colon, then a reason — because this module is published, the export guard refuses Cyrillic, and a
target project's roadmap may be in any language. Whether a version counts as released is read from
its status word, not its title: all 32 versions carry one, in English, in backticks. And a reason
that **wraps onto the next line** is still one reason — reading only the first line, the guard called
one of the two deliberately excused criteria silent, because the words that made it substantial were
one line below.

### Forty triaged

```
closed with evidence ..................................  9
declared not met, or withdrawn ........................ 31
still silent ..........................................  0
```

Nine out of forty is the honest share of what had ever been verified. Withdrawn as moot: everything
about Cline (removed in v1.4.0, zero mentions left in the code), the VS Code mode, MANUS_API_KEY,
santa-method, attempts_per_task. Withdrawn separately: a criterion asking for "a direct YES on whether
the functionality is guaranteed" — it closes with a word rather than evidence, which is the class this
version exists to end.

Not met and now saying so: the fifty-step run, restart under PM2, an autonomous OpenCode run, the
cost comparison, long-prompt delivery, twenty operations without permission prompts, a real commit on
Kimi K3. Several of those need live engine runs, forbidden since the incident in v1.15.0.

### The guard was itself the thing it guards against

Its first version did **not** turn red on a planted silent criterion. The module was imported by an
absolute Windows path as a bare specifier — modules do not load that way — the error went to
/dev/null, and empty output was read as "clean".

The root was not the path. Absence of output meant **two different things**: "clean" and "the check
did not run". That is the same distinction v1.13.0 exists for, where a missing completion marker meant
both "still working" and "died". A guard against unfalsifiable checks was an unfalsifiable check.
It now prints a word when clean, so emptiness means breakage — proven by planting one and watching it
fail.

### Found after the release, by running the suite from the published tree

The release notes above were written from the working tree. Running the same suite from the tree the
manifest actually produces turned up **six failures**, and the split is worth recording.

Five were an artefact of how the check was made rather than of the code: the exported directory was
not a git repository, and the ignore-policy and secret-scan tests ask git directly — deliberately,
since a rule that is written down and a path git actually refuses are different claims. Initialised
as a repository, which any published tree is, all five pass.

The sixth was real and was this version's own. The test pinning the roadmap measurement read
`docs/ROADMAP.md` unconditionally — a file the manifest deliberately does not publish, because it is
the plan for developing the framework rather than part of the product. So it passed where it was
written and failed where it would be used. **v1.12.0 records exactly this blind spot**, in almost the
same words, about a guard that hard-coded an unpublished development tool. One release later, the
same author repeated it.

The test now asserts something true in both trees: where the roadmap exists its numbers are pinned,
and where it does not, the property that matters is that its absence accuses nobody of anything.

Tests 468, coverage gate run the way CI runs it, 137 smoke checks in the working tree and 131 plus 6
announced skips from the published one, export clean at 123 files. No live engine run was performed,
and nothing was published.

---

## [v1.17.0] — 2026-09-01 — an audit becomes data, and the first real one found four defects in the gates

`/productionauditloop` is meant to run until P0 + P1 + P2 = 0. That condition cannot rest on the
agent's word: an agent able to declare the loop finished will finish it by declaring, and the
declaration will be sincere — it is very easy to believe you are done. So findings had to become
countable by something that is not the agent.

### Where the ledger lives, and the measurement that overturned the assumption

The work began from "the `docs/todo` format is already half-structured, just parse it". Across the
ten existing files:

```
checklist lines .................................... 231
matching the tidy `- [ ] **P0-001**` shape .........  19
not matching ....................................... 212   (92 %)
findings carrying a file:line ......................  14
```

The mismatches are meaningful rather than sloppy — `**P2-002 + P2-003**` is one fix closing two
findings, `**P2-011/P3-011**` is a finding whose level depends on where you stand. The format was
never meant for counting, and a parser generous enough to read it would produce a number people
believe.

So the ledger is a machine-readable head on the very file all four audit templates already require,
with the prose below left to humans. No new artefact, and — the reason this beat a separate JSON file
— one home for the state of a finding. Two homes drift; that is the class v1.7.0, v1.7.1 and v1.14.0
were each spent on. Unlike the threshold decision one version earlier, here the arithmetic settled it
cleanly: 24 against 12.8.

### Against the degenerate exit

An audit that looked at nothing finds nothing, and zero then reads exactly like a clean pass. So
coverage is required of **every** ledger and not only of the clean ones: a line written solely to
reach zero would be written to reach zero. Marking a finding fixed or rejected requires evidence,
because "fixed" on its own is the agent's word again in a different hat. A ledger that does not
validate never ends the round: proving nothing is not the same as finding nothing. And a dimension
with no ledger is not a clean dimension — it is one that never ran.

One clean round is enough, decided rather than assumed: a clean round already runs *after* the fixes
it verifies, so a second one with nothing changed between them could only find what the first missed,
which is a question about coverage rather than about repetition.

### The first real run found four defects — in the gates themselves

- **The coverage gate reported wider than it checked.** It compared line coverage only and announced
  "all source modules are at or above 80%". Measured at that moment: the Stop hook and the safety
  guard — the two files that decide whether the loop continues and whether a dangerous command runs
  — were at **12.5 % of branches**. Roughly one branch in eight, and the gate said fine.
- **The vacuity guard could only see total vacuity.** Had one directory of three stopped being
  recognised, plenty of rows would have remained and the gate would have passed on a measurement that
  had quietly lost `hooks/`.
- **The module guarding the gate was covered worse than the gate**, at 50 % of functions, having
  broken twice by its own comment.
- **The gate is opt-in, and its absence was silent.** Without `--coverage-min` the suite still prints
  the whole percentage table and checks nothing. Measured on the author: every coverage claim made
  during that session came from reading the table by eye while the gate sat idle. It was found only
  because fixing the first defect forced a run the way CI runs it.

All four are closed with evidence in the ledger. A branch threshold was deliberately **not**
introduced: choosing one is a decision with a real cost, and the change that stops a report
overstating itself should not quietly impose another gate. The gate now names the worst module and
says plainly that a subprocess reports low branches even when tested.

### Confirmed the same day by a different mechanism

The roadmap review shipped in v1.16.0 fired for the first time and independently found the same
thing: v0.9.0 has carried an open acceptance criterion — "the ≥80 % threshold for lines **and
branches** is met" — for four versions, and nobody had looked. Two mechanisms built for different
purposes converging on one defect is the best evidence available that the defect is real rather than
invented to suit the mechanism.

That review also changed the plan for the first time in the project's history: one version withdrawn,
one added.

Tests 456, the coverage gate run the way CI runs it, 135 smoke checks, export clean. No live engine
run was performed, and nothing was published.

---

## [v1.16.0] — 2026-09-01 — a decision stops being flat, a plan stops being permanent

Two complaints from the project's owner, one root: the agent does not revisit its own thinking. It
takes the first workable idea, and it follows a plan it wrote long ago even after the work has shown
the plan to be wrong.

Both were measured before either was fixed:

```
version prompts carrying a brainstorm .......................  21 of 52   (40 %)
reports naming a rejected alternative .......................  11 of 72   (15 %)
versions ever cancelled, dropped or reordered in the roadmap ...  0  of 25+
```

Eighty-five per cent of the work shipped without one alternative ever named. And no plan, across
twenty-five releases, was ever changed: either it was right every time, or nobody looked.

**It is not laziness, and the distinction shaped the fix.** Where a prompt asked for the
alternatives, the alternatives are there and they are substantial. The practice lived in a document
rather than in a mechanism, so it switched on when instructed and off when not. Observed on one agent
inside a single session: choosing the loop lock's liveness evidence went through four options with
one measured and rejected; choosing a process identity an hour later took the first thing that came
to mind. Same day, same care, different instruction.

### Decision records

A record under `docs/decisions/<version>_<name>.md` now has a shape a machine can check: at least
three options — two is a fork, and the second is usually there to make the first look chosen — each
with impact, confidence and cost on one scale, **and a basis**, which is either a measurement or an
assumption named as one. A number without a basis is an opinion wearing a digit, and three of them
multiplied together look like arithmetic. Everything not chosen says why it lost. The record says
what would show the choice to be wrong, checked for substance by the very function the safety guard
uses on its confirmations — one judgement, one implementation.

**The score is never stored.** `(impact × confidence) / cost` is computed on read, and a record
carrying a written score is refused rather than tidied: a copy of numbers that live three lines above
it will one day disagree with them. That is the defect class v1.7.0 and v1.14.0 were each spent on,
and it is closed here before it can be introduced.

The mechanism cannot know whether a given version needed a record, so it does the one thing that
closes the silent case: **whether a record exists for the version in flight is printed in the
continuation header every turn.** A flat decision can no longer look exactly like a considered one.

### The roadmap reviews itself

Every ten turns the step instruction is *replaced* by a review of the remaining plan against what the
work has since shown — replaced, not appended, because a directive at the end of a long text leaves
the agent doing what it was already doing. Recording the review without saying what came of it is
refused on the way in, by the same barrier that has guarded the step instruction since v1.7.0: "all
fine" is not an outcome, and a review that cannot fail is not a review.

The threshold was chosen in the open, and the record is on disk. Ten turns is three to four finished
versions at the measured rate of 2–3 turns per version. What is worth reporting is that **the
arithmetic did not settle it**: ten turns scored 24.5 and twenty-five scored 24, a gap of two per
cent, and the record says so instead of pretending the numbers decided. What decided was the point
itself — a plan that went twenty-five versions unexamined is not fixed by a threshold that permits
ten more. Without the formula, "ten" would have looked like a reasoned number while being the first
one that came to mind.

### Found by using the mechanism on itself

The first record was written with YAML folded blocks (`>-`), which `lib/yaml-mini.mjs` deliberately
does not support — and it silently became "no record": a written decision that looked exactly like a
decision nobody took. A silent failure, built into the mechanism against silent failures. It now
names itself as unreadable and says what is not supported. The parser was left alone: it is the only
reader of `docs/STATE.md`, and risking it for the sake of line breaks is not a trade worth making.

### What this does not do

It makes the agent look. It cannot make it see. That is recorded as the decision's own falsifier: if
ten versions from now the roadmap has still never changed, the mechanism does not work, and that will
have to be admitted rather than explained.

Tests 433, every module at or above 80 % line coverage, 134 smoke checks, export clean. No live
engine run was performed, and nothing was published.

---

## [v1.15.0] — 2026-09-01 — the supervisor becomes an equal driver, and a cleanup stops guessing

Planned as an audit of the external loop driver against five measured defects. What it is remembered
for is the sixth, which was not measured but suffered: a live supervisor run **destroyed a Claude
Code session belonging to an unrelated project**, cut off mid tool call.

That goes first here on purpose. A changelog that files the incident under general improvements is
itself the defect class this project exists to close.

### The incident, and its two roots

`spawn-cli.mjs` opens by explaining that killing engine processes by image name was rejected because
it "would also take down the user's unrelated processes". The registry built instead reached the same
outcome by another route: `sweepStaleChildren` read process numbers out of a file written by an
**earlier** run — exactly stale enough for the system to have issued them again — and handed each to
`taskkill /T /F` with no check that the number was still ours. A guard whose own justification names
the harm, and then permits it through a side door, is this project's recurring defect at the highest
price it has yet charged.

Every recorded child now carries an identity: the moment the process was created, which a recycled
number will not reproduce. Nothing is killed unless the identity still matches, and a child whose
identity cannot be established is **not killed at all** — a leaked orphan costs memory, a destroyed
stranger costs somebody's work. Registries written before this version carry no identities and
therefore kill nothing.

The second root: `cwd` defaulted to `process.cwd()`, so a supervisor driving one project's state ran
the engine in whatever directory it had been launched from — in the incident, a real Claude Code
session started inside the framework repository beside a session already working there. Which project
the state belongs to and which project the engine runs in are now derived from one source.

Nothing written was lost: a transcript survives its process, and `claude --resume <session-id>` brings
the session back at its last message. The rule that came out of it is recorded in `failure-modes`: a
live engine run is not a cheap check — it starts a real agent with real permissions in a real
directory, and the framework may force-kill process trees around it.

What cannot be shown is that the destroyed session went through that particular sweep. The timing and
the mid-tool-call cut are enough to name the cause; the chain from a specific number to a specific
process is not recoverable, and it is not claimed.

### The five defects the version was opened for

- **One rule in two implementations.** "Two empty turns escalate, three record a blocker" lived on
  disk for the Stop hook and in a local variable for the supervisor, so restarting a run reset the
  count and the blocker could never arrive. Both drivers now share one storage, one function and one
  pair of thresholds. Putting that memory in `docs/STATE.md` was rejected on a measured basis: the
  hash of STATE is itself one of the progress signals, so the watchdog would be barking at its own
  tail.
- **`--max` without a usable number meant no limit at all.** `parseInt` gave `NaN` and `loops >= NaN`
  is false for ever, so asking for a cap and mistyping the number bought an unbounded unattended run.
  Every option that takes a value now refuses rather than guesses.
- **The engine self-check ran before the gates.** Starting on a finished version spent a paid call in
  order to then announce there was nothing to do.
- **The lock was eight times shorter than a turn.** `loop-lock.mjs` claimed a turn is capped at
  15 minutes and that 30 minutes therefore gave a twofold margin. The constant is four hours. The
  claim was carried forward unchecked while that file was being rewritten one version earlier — which
  is how a false comment survives a rewrite: it reads like a conclusion somebody already verified. A
  turn now proves it is alive while it runs, which also gives "alive but the heartbeat is old" its
  meaning back.
- **Engine processes outlived `runLoop`.** Cleanup was wired only to process exit, so used as a
  library — how a wrapper and every test uses it — an abandoned loop left its engine running.

A sixth came out of the probe written for the last of those: after losing the lock mid-turn, the
supervisor still wrote its bookkeeping into the state — the exact corruption the lock exists to
prevent. That path had no test and no reader had noticed it, which is the argument for probes that
use real processes.

### Two modes, written down

`docs/two-modes.md` sets the Stop hook and the supervisor side by side: what each can and cannot do,
how to start and stop it, and what must never be run at once. Use the hook when you are at the
keyboard; use the supervisor when the run has to survive an outage or respect a spending cap, which
is the only mode where that cap works. Its price is stated plainly — every turn starts from a blank
slate, so anything worth remembering has to be in `docs/STATE.md`.

Tests 411, every module at or above 80 % line coverage, 132 smoke checks, export clean at 114 files.
No live engine run was performed, and nothing was published.

---

## [v1.14.0] — 2026-09-01 — liveness is measured by something that lives

Reported as "a second Claude Code session in the same project fights the first one for the loop".
There was a guard against exactly that, ten lines of comment explaining it, and a test covering it.
It had never once run.

**The root, measured rather than reasoned about.** The Stop hook wrote the loop lock without saying
what proved it alive, so the lock recorded the hook's own process number — and a Stop hook is a
program that lives for milliseconds at the end of a turn. On a lock written a moment earlier:

```
the lock was written by session A, heartbeat age 0 seconds
  ownerState -> dead
```

Every subsequent invocation, from any session, saw a dead owner and took the loop over. The branch
that compared session ids sat below a condition that could never be true.

**A longer deadline could not have fixed it.** Liveness is judged before staleness, so the deadline
was never consulted. What had to change was the witness.

Evidence of life is now an explicit part of the lock, and each kind answers in the way its own
physics allows: a **process** is put to the kernel, a **file** tops the heartbeat up with its
modification time, a **heartbeat** speaks alone when there is nothing external to ask. The Stop hook
registers the session transcript, because that file lives exactly as long as the session does —
measured on a live session at 10.9 MB, last written 0.4 seconds ago, while the hook's own process
was already gone. Identity comes from the same field, which is what lets one session keep its own
lock across turns even though every hook process has a different number.

There is deliberately no `if (engine === 'stop-hook')`. Branching on a driver's name rather than on
what it can prove is how one special case becomes three. Locks written before this version carry no
evidence field and are read exactly as they always were.

**The alternative was tried, not dismissed.** If the hook's parent were the long-lived Claude Code
process, that would be exact, kernel-checkable evidence, strictly better than a file. A real Stop
hook was made to record its parent; on the next turn the parent was dead too — the hook is launched
through a shell wrapper that exits with it. The idea is written into the module so the next reader
does not spend the same measurement discovering the same thing.

### The mechanism from v1.13.0, audited against the physics of its own signals

Four corners where the classifier answered more confidently than its evidence allowed:

- **A process number is not a name.** The operating system reissues it, so a job that died hours ago
  could appear alive wearing somebody else's process and be reported as running for ever. A written
  marker is evidence the job produced about itself, so it now outranks liveness. The price is stated
  rather than hidden: the log must be truncated when the job starts.
- **"Gone, and no marker was declared" meant finished** — and also covered a job that never started.
  The log file separates them: a job that ran left a file behind, a job that never started did not.
- **A deadline that could not be read silently never fired.** Self-contradicting records now produce
  named warnings: a deadline before the start, a marker with no log to look for it in, a record with
  no usable process number.
- **Terminal records accumulated in silence.** Deleting one would decide on the agent's behalf that
  the result had been collected, so the registry asks instead, every turn, until it is cleared.

### Found while measuring: the silence watchdog was reading a hand-written clock

`core/gates.mjs` stated that `lib/update-state.mjs` "has written `last_action_at` since the first
version". No line of that tool ever did. Agents filled the field in by hand, in whatever patch they
happened to remember it in, so from v1.8.0 the watchdog that reports "STATE has not changed for N
minutes" was reading a cache nobody maintained. Measured here: it announced 355 minutes of silence
on a project that had changed twice in the preceding hour.

The tool now stamps the field itself. It deliberately does **not** stamp for the loop drivers' own
bookkeeping — iteration, session id, session count, cost — because both drivers write on every turn,
and a watchdog fed by the loop's own counting would be barking at its own tail. The rule is derived
from what a patch touches rather than declared by a flag, so a driver has nothing to declare.

This is the same defect class v1.7.0 closed for the step instruction — a cache with no invalidation
— reintroduced in a different place. Twelfth recorded instance in this project, and the second in a
row caught by a check rather than by a person: the export guard also found Cyrillic in the test
fixtures written for this very version.

### Acceptance

Three transitions, on a stand-in project driven by the real hook: session A takes the loop; session
B is refused, told who holds it and how to take it deliberately, and ends as an ordinary session; A
keeps driving; A goes quiet for forty minutes; B takes over.

Tests 401, coverage at or above 80 % for every module, 132 smoke checks, export clean at 114 files.
Nothing was published.

---

## [v1.13.0] — 2026-09-01 — waiting stops being idling

Reported as "the loop keeps stopping while a test run finishes and never recovers". The measurement
told a different story: it was not stopping. It was standing still, in a way nobody could see.

In one real session `sleep` appeared **447 times**, across thirty-nine `until … ; do sleep N; done`
loops, with pauses of up to 900 seconds inside a single tool call — while the framework's own
background mechanism was used exactly once. The human intervened 124 times, asking in four different
phrasings whether the loop was working or standing still.

**The root was an absence rather than a bug.** The framework had no idea a long job could exist, so
the agent used the shell as its scheduler. A turn is where the loop acts and it is the loop's only
spendable resource; a turn spent asleep produces nothing — no git change, no state change — which is
also precisely what a hung turn looks like from outside. Neither the drivers nor the human could
tell the two apart.

**Why a completion marker is not enough**, which is the part worth remembering. `until grep -q
MARKER log` waits for ever when the job dies before writing its marker, because the absence of a
marker means two different things. Liveness of the process separates them:

```
alive · no marker   → running
dead  · marker      → finished
dead  · no marker   → DIED — the case that used to hang for ever
```

Plus one the pair cannot express: alive but past the time it was expected to take. That stops
nothing — it is a fact worth telling an agent, because a job running far longer than expected
usually means something it can act on.

So `running_jobs` in the state file is now something the loop understands. Start the work in the
background, record it, **end the turn**. Every continuation then reports where each job stands, in
the same block that already carries the version and the blockers:

```
jobs: running: 1 (suite) | overdue: 0 | died: 1 (broken) | finished: 0
```

Checking costs milliseconds — four real processes classified in three — because checking is not
waiting, and that distinction is the whole point.

The guard gained an advisory rule for blocking waits, active only in `confirm` mode: it names what a
sleep costs and points at the alternative rather than merely refusing. The threshold is 60 seconds,
taken from the measurement rather than from taste — in that session the harm came from 200–900
second pauses while 5–15 second ones were routine and harmless.

**A limit that cannot be fixed in code, now stated.** The same session contains six
`ConnectionRefused` / `ENOTFOUND` errors; the human rebooted the network and asked the agent whether
it was still there. The Stop hook cannot survive the platform going down, because it lives inside the
process that dies: there is no turn to run and nothing to restart it. `core/supervisor.mjs` is an
external driver and does survive it. That is a property of the driver you choose, and it is now
written down in both the README and the failure catalogue.

Tests 378 (from 360), 27 source modules at or above 80% of lines, smoke 130/0.

---

## [v1.12.0] — 2026-08-31 — the documentation audit before publication

Preparing the public tree for its second release meant checking what the documentation claimed
against what the code did. Eight discrepancies, and all of one kind: **a lead sentence left behind by
its own list.**

README and GUIDELINE both opened with "exactly four things stop the loop" directly above a list in
which two of the four were marked "off unless you set it" — the lists were corrected when limits
became opt-in, the sentences above them were not. GUIDELINE named three guard modes when there were
four. The structure map promised "230 tests plus 117 smoke checks", numbers from six releases
earlier. An example state file in the plugin readme was five releases out of date.

Edit a list, forget the sentence above it. Worth naming, because it is not carelessness — it is what
happens when the change is real and the framing around it is invisible.

**Two usability defects that an audit of claims cannot find**, because both were true as statements
and broken as instructions. The quickstart told a reader hitting a permission prompt to run
`node tools/doctor-permissions.mjs` — from their own project, where `tools/` does not exist, so the
advice returned `ENOENT`. And the project template promised a "pre-flight check against `claude mcp
list`", while the actual pre-flight is an engine self-check that never looks at the field in
question: one name, two different things, and a reader who reasonably assumes the check is automatic.

Both were found by walking the quickstart as a new user would, knowing nothing beyond its text. That
is now the method for this kind of defect, because reading the claims will not surface it.

**Running the suite from the published tree found a defect again**, as it did for the first release.
A guard added the previous day hard-coded a development tool that is deliberately not published: it
passed in the working tree and failed in the published one. A guard that only works in one of two
trees is half a guard.

`docs/PROVEN.md` was brought up to date — including the parts that make the project look worse, which
is the only reason that page is worth reading.

Tests 360, 26 source modules at or above 80% of lines, smoke 129/0 from the working tree and 119/0/10
from the published one.

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
core, and the test suite that has since grown to the numbers given at the top of this file.

That sentence used to carry the numbers themselves — "234 tests plus 111 end-to-end checks" — and by
v1.18.0 it was six releases out of date while reading as a statement about the present. It is the
same defect this project keeps closing, committed in the file that documents the closing of it: a
lead sentence left behind by what it describes. Live figures now live in one place, at the top, where
being wrong is visible.
