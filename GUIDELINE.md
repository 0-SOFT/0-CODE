# GUIDELINE — how this works, and why it works this way

> **Framework version:** v1.20.0.
>
> This file is for the person who opened the repository and wants to understand **why everything
> is shaped the way it is**. If you only want to use the framework, read [README.md](README.md).
> If you want a map of the files, read [STRUCTURE.tree](STRUCTURE.tree).
>
> Most sections below end with the observation that produced the design. That is deliberate: the
> reasoning is worth more than the description, because it tells you which parts are load-bearing.

---

## 1. The problem

An AI coding agent works well inside one session and loses initiative between them. You get a
capable collaborator with amnesia: it can do a day's work in an hour, then stop and wait to be
told what happens next.

Everything needed to fix this already exists — tools, models, permissions. What was missing is a
**loop**: something that remembers where the work stopped, decides whether to continue, and keeps
going when the network hiccups.

This framework is that loop and nothing more. Around 2000 lines of plain Node and bash, zero
runtime dependencies.

---

## 2. The core idea

An agent session ends when the model finishes replying. We intercept that moment:

- **Claude Code** — a `Stop` hook. Instead of "we are done" it answers "look at STATE.md, there is
  work left, continue". The loop then runs inside a single live process.
- **OpenCode** — no such hook exists, so an external supervisor drives it: one process per turn,
  continuity carried by the state file.

Both drivers ask the *same* function whether to continue. That function is `core/gates.mjs`, and
it is pure: state in, decision out, no I/O. Which is why the two engines cannot drift apart in
behaviour — there is only one implementation of "should we keep going".

| Ordinary session | With the loop |
|---|---|
| You prompt, the agent answers, it ends. | You give a goal once; the driver keeps feeding the agent back into work until a real stop condition. |
| The state is in your head. | The state is in `docs/STATE.md`. |
| The plan is in your head. | The plan is in `docs/ROADMAP.md`. |
| You decide what happens next. | The orchestrator decides from the current stage. |

---

## 3. Architecture

```
┌─ target project ────────────────────────────────────────────────┐
│                                                                 │
│  docs/STATE.md      where the loop is now (YAML + a journal)    │
│  docs/ROADMAP.md    where the project is going                  │
│                                                                 │
│  hooks/             Stop hook · permission arbiter · logger     │
│  lib/               state parsing, atomic writes, backups       │
│  core/              gates · supervisor · lock · safety · …      │
│  CLAUDE.md          instructions, points at the orchestrator    │
│  .claude/settings.json   registers the hooks and permissions    │
└─────────────────────────────────────────────────────────────────┘
```

Two properties matter more than the file list:

**Everything agent-specific lives behind one port.** `core/backends/Backend.mjs` defines what an
engine must be able to do: run a turn, register MCP servers, install instructions, apply
permissions, restore its own scaffolding, pre-check a command. Adding an engine means writing an
adapter, not touching the core. That is how the second engine was added without changing a line of
the loop logic.

**The rules exist once.** Destructiveness rules live in `core/safety.mjs` and are consumed by the
Claude Code hook, by the OpenCode plugin (which is *generated* from that module), and by the
supervisor's own pre-check. Permissions live in `core/permissions-policy.mjs`, and both settings
files are generated from it with a test that fails if either drifts.

The reason for that insistence: an earlier version had the policy in two places. They diverged —
the template registered a protective hook that the framework's own settings lacked. The framework
was treating other projects and not itself, and nobody noticed for several versions.

---

## 4. One iteration

```
  STATE.md ─read─► orchestrator ─► decides the stage ─► does one step
                                                             │
                                                    writes files, commits
                                                             │
  STATE.md ◄─atomic update──────────────────────────────────┘
      │
      ▼
  driver: continue?  ── yes ─► push the agent back to work
                     └─ no  ─► blocker · released · iteration cap · budget cap
```

Atomicity is not decoration. STATE is written through a temporary file plus rename, with a ring
buffer of five backups taken first. A half-written state file breaks the loop in the most
confusing way possible: the hook cannot parse it, fails open, and the run simply stops with no
error anywhere.

---

## 5. Stopping

By default two conditions stop the loop; two more wait to be switched on. All four are visible
in STATE:

1. a **blocker** — something only a human can resolve;
2. `released_version == current_version` — the roadmap is finished;
3. the **iteration cap** — opt-in since v1.9.0, absent by default;
4. the **budget cap** — opt-in, and enforced only under the supervisor.

### Why the caps are opt-in (v1.9.0)

A limit belongs to whoever runs the project. Until v1.9.0 an absent `max_iterations` quietly became
1000 and a new project got 25 — numbers nobody chose for that work. Now absent, `null`, `0` and
anything negative all mean the same thing: no cap. A positive number behaves exactly as before, so
the change removes a default rather than a feature.

The cost is stated rather than softened. With no cap set, two things stop the loop: a blocker and a
finished roadmap. What does not vanish with the caps is observability — a run that stops producing
change writes itself a `no_progress` blocker after three empty turns, and a state file that stops
changing is reported in every continuation.

The budget cap has a second, older limitation, now said out loud instead of implied: `version_cost_usd`
is written by the supervisor, which receives the turn cost from the engine. The Stop hook never sees
a cost. Its payload carries a transcript path, and the transcript holds token counts and a model
name but no cost field of any kind. Money could be derived from tokens only by keeping a price table
per model, tier, region and token kind — a copy of somebody else's data with no expiry date, which
is precisely the failure this project spent v1.7.0 removing. A guard reporting a wrong number is
worse than one reporting none, because a wrong number is believed. So the cap is left honest: under
the Stop hook it is reported as unenforceable.

An empty `next_step_prompt` does **not** stop anything — it means "decide from STATE and ROADMAP".
This is written down because the instructions once claimed the opposite, and the author of those
instructions (this framework, working on itself) followed them and stopped a healthy loop.

### What the loop actually hands the agent (v1.7.0)

The reason a continuation gives is not the raw `next_step_prompt`. It opens with a block generated
from STATE — version, stage, iteration out of the cap, whether there is a blocker, which prompt
file — and says in as many words that this block wins over anything below it. Only then comes the
recorded step instruction, and only if it still describes where the loop stands.

This exists because a free-text field once outranked the machine fields beside it. In a live
project the loop handed the agent, for dozens of iterations, an instruction written two versions
earlier that announced a blocker — while `blockers` was empty. `next_step_prompt` is a cache of an
instruction; a cache with no invalidation drifts by construction. So it now carries a passport
minted by `lib/update-state.mjs` (never written by hand), and moving the loop without rewriting the
instruction is refused outright rather than merely warned about — a warning in a log is read by
nobody, and the price here was dozens of wasted iterations.

### The guard, and switching it off (v1.10.0)

The `PreToolUse` hook answers every tool call before it runs: allow what is safe, deny what is
unrecoverable. Silence is not "yes" — it means "no decision", and the question then falls through to
the ordinary permission system, which is what produced prompts under `bypassPermissions`. So the
hook always answers.

`SAFETY_GUARD_MODE` chooses between `arbiter` (the default), `guard-only` (deny only), `allow-all`
(deny nothing at all, by explicit request) and `confirm` (name the consequence and ask for a stated
reason — v1.11.0). The first two existed before; `allow-all` did not, and neither did any way to
tell that a value had been misunderstood. `SAFETY_GUARD_MODE=off`
looked like switching the guard off and changed nothing, because an unrecognised value was replaced
by the default without a word.

The rule that came out of fixing it, and that now applies across the framework: **where a safe
default exists, keep it and report the substitution; where none exists, refuse.** A typo in the guard
mode still gets the full guard, because halting a loop over a typo is worse than continuing safely.
A typo in `AGENT_BACKEND` is refused outright, because "which engine" has no safe default — falling
back there is not degrading gracefully, it is silently running a different product at a different
price.

### Asking instead of refusing (v1.11.0)

A refusal tells an agent it may not. A request for a reason makes it say why it should. The second is
the better answer wherever the command has a legitimate use, for a simple reason: the framework does
not know the task, and the agent does.

So rules now carry a level. **Hard** rules cannot be argued with — there is no task context in which
destroying the machine is right, and asking the agent that proposed it to justify it could only ever
produce a wrong answer. **Confirmable** rules name the consequence and ask; a force push is the
canonical case. **Advisory** rules exist only in `confirm` mode and are the reason the mode pays for
itself: several were dropped in v1.2.1 because refusing them cost more than they saved, and a request
to think costs a rewritten command where a refusal costs a turn.

The confirmation travels inside the command as a shell comment. That is not a shortcut — it is the
design. The hook lives for a fraction of a second per call, so remembering a refusal between calls
would mean a file, keys, an expiry and races. Carrying it in the text costs nothing and buys
something better: an agent cannot confirm by repeating itself, it has to rewrite the command and
state a reason, and that reason then lands in the log beside what it justified.

What the mode trades away is worth naming. A hard guarantee becomes a judgement, and the judgement
belongs to the same agent that proposed the command. That is why it is opt-in, why hard rules stay
hard, why a throwaway reason is rejected, and why every confirmation is logged: an allowed
destructive command that left no trace would be strictly worse than a refusal.

### Blockers are a resource problem

Before recording one, the orchestrator must have made three genuinely different attempts and
re-checked whether an available tool solves the problem. A fabricated blocker costs the scarcest
resource in the system: human attention.

---

## 6. Permissions, and why prompts used to appear

A user with "bypass permissions" enabled was still being asked for confirmation. Twenty
experiments established the hierarchy:

```
deny(settings) > ask(settings) > deny(hook) > allow(hook) > allow(settings) / bypass mode
```

An `ask` rule outranks **every** mode and even the hook's own decision. It is a guaranteed prompt
that nothing can switch off — and the framework was handing `ask` rules to itself and to every
project it created.

The fix was to delete the category as a concept. Dangerous commands go to `deny`; routine ones to
`allow`; the hook became an **arbiter** that returns an explicit "allow" for anything safe. An
explicit allow removes the prompt in any mode, for any tool — which is why the matcher is `*` and
not `Bash`.

Result: twenty typical operations, zero prompts, with destructive commands still blocked.

---

## 7. Protection, deliberately minimal

A later measurement showed the grown rule set blocking **7 of 11** everyday commands: searching
for text that happened to contain SQL, a commit message, cleaning a build directory, a dry-run
publish. Each false refusal costs the loop a turn, and three in a row become a blocker. Protection
had started to fight the thing it was protecting.

The selection criterion now is strict — a rule survives only if **both** hold:

- the consequence is unrecoverable and reaches beyond the working directory;
- there is essentially no legitimate use for it inside a development loop.

Four rules pass: destroying the filesystem, formatting a disk, mass-killing the agent's own
processes by image name, and `git push --force`. The third is worth noticing — it protects the
loop from itself, so it costs autonomy nothing.

### Protection the agent cannot remove

Asked directly to disarm itself, the agent did: it deleted the guard plugin and rewrote the
permission file to allow everything, leaving the block structure in place so a presence check
would notice nothing.

The structural answer: the main plugin lives **outside** the working directory, where the agent
does not reach, and the scaffolding is restored before every turn with permissions compared by
content rather than by shape. Verified with the project fully disarmed — the guard still blocked.

The honest limit: within a single turn the project-level configuration can still be edited. That
does not remove the protection, because the plugin does the blocking and the plugin is out of
reach.

### Secrets are never blocked

If a commit picks up something that looks like key storage, you get a line in the log and a
notification. Nothing is prevented. This is an explicit decision by the project owner: the ability
to commit a key deliberately is preserved, and the framework's job is to inform, not to obstruct.

---

## 8. Surviving long runs

Four mechanisms exist purely because unattended operation exposes what short runs never do.

**The lock, and what proves an owner alive.** Two supervisors were once started against the same state file and competed for
writes. A live owner now refuses the second launch; a dead one is taken over, because a crashed
process must not block autonomy forever.

What counts as "live" is the part that took a version to get right. The lock used to record a
process number, which is exact for the supervisor and meaningless for the Stop hook — a hook is a
program that lives for milliseconds at the end of a turn, so its own number is dead by the time
anyone checks, and every extra Claude Code session took the loop from the previous one. Evidence is
now an explicit part of the lock and each kind answers in the way its own physics allows: a process
is put to the kernel, a file tops the heartbeat up with its modification time, a heartbeat speaks
alone when there is nothing external to ask. The hook registers the session transcript, because that
file lives exactly as long as the session does. Opening a second session in a project is therefore
safe: it is told who holds the loop and how to take it deliberately, and it behaves like an ordinary
session.

**Long-running work.** A test run, a build, a subagent — anything the loop must wait for. Waiting
used to be invisible: a turn spent polling and a turn that had hung looked identical from outside,
and in one real session the shell was used as a scheduler 447 times. Start the work in the
background, record it under `running_jobs`, and **end the turn**; every continuation then reports
where each job stands.

The part worth remembering is why a completion marker is not enough. Its absence means two different
things — still working, or died before writing it — and only liveness separates them. A job that is
gone without its marker is reported as **dead**, which is the case a `until grep -q MARKER` wait
hangs on for ever.

**Retries.** A single `UnknownError` from a provider used to end a run. Transient failures are
retried with growing backoff; real errors stop immediately. The split is not a list of known
strings but a question: *does repeating the same action have a chance?*

**Process groups.** A supervisor killed from the outside left live engine children behind, which
then competed over the same state. Two lines of defence, because when a parent is killed hard its
exit handlers do not run at all — on any operating system. Signals handle the graceful case; an
on-disk registry, swept by the next launch, handles the brutal one.

**The self-check.** One tiny turn before the loop starts. It catches a changed output format
(turns "succeed" and come back empty) and a misconfiguration that would otherwise look exactly
like a transient failure. It uses the same model the loop will use — probing with a cheaper one
would defeat the purpose.

### A design error worth repeating

The per-turn timeout was meant to catch a hang. It measured *duration* — and killed an agent that
was working honestly and had already produced two commits.

A hung process differs from a working one by **silence**, not by lifetime. The cap now measures
time since the last byte of output, and the total limit remains only as a far backstop. This is
the clearest example in the project of a mechanism that was correct in intent and wrong in
measurement.

---

## 9. Testing

A unit and integration suite plus end-to-end smoke checks, with no test framework at all — the
project is zero-dependency including its tooling. A fresh clone runs slightly fewer smoke checks
and announces each one it skips, because a suite that quietly shrinks is lying about its own coverage.

The current counts are at the top of [CHANGELOG.md](CHANGELOG.md), measured at each release. They
are deliberately not repeated here: this document has carried a stale figure twice, and a number
copied into prose has no way of noticing that it stopped being true.

More interesting is what the tests are *for*. Over three versions, every serious defect was found
by live checks while coverage sat above 80%, and **none** was caught by a test. The reason is
simple: tests check what you wrote, and what breaks is what you *claimed*.

So the suite now includes a file of blind-spot tests, one per class of defect, each written from a
real incident: a script referencing a deleted file; documentation promising behaviour that does not
exist; a method reporting success without a mechanism behind it; a notification that silently goes
nowhere; a default chosen without justification; a version header drifting from the manifest.

---

## 10. Keeping the work honest

Four mechanisms with one thing in common: they exist because an agent's own account of its work is
not evidence. Each was added after a measurement showed the account and the work disagreeing.

### Decision records

Measured across this project's history: 21 of 52 version prompts carried a brainstorm, and **11 of
72 reports named a single rejected alternative**. Eighty-five per cent of the work shipped without
one alternative ever named — not from laziness, but because the practice lived in a document rather
than in a mechanism, so it switched on when instructed and off when not.

A record under `docs/decisions/<version>_<name>.md` now has a shape a machine can check: at least
three options — two is a fork, and the second is usually there to make the first look chosen — each
with impact, confidence and cost, **and a basis**, which is either a measurement or an assumption
named as one. A number without a basis is an opinion wearing a digit. Everything not chosen says why
it lost, and the record says what would show the choice to be wrong.

The score `(impact × confidence) / cost` is **computed on read and never stored**. A record carrying
a written score is refused rather than tidied: a copy of numbers living three lines above it will one
day disagree with them.

The mechanism cannot know whether a given version needed a record, so it does the one thing that
closes the silent case — whether a record exists for the version in flight is printed in the
continuation header every turn. A flat decision can no longer look exactly like a considered one.

### The roadmap reviews itself

The measurement that prompted it: across twenty-five releases, the number of versions ever cancelled,
dropped or reordered was **zero**. Either the plan was right every time, or nobody looked.

Every so many turns the step instruction is *replaced* by a review of the remaining plan against what
the work has since shown — replaced rather than appended, because a directive at the end of a long
text leaves the agent doing what it was already doing. Recording the review without saying what came
of it is refused on the way in: "all fine" is not an outcome, and a review that cannot fail is not a
review.

It makes the agent look. It cannot make it see — and that limit is written into the mechanism's own
decision record as its falsifier.

### Acceptance criteria that close with evidence

Versions declaring themselves released carried **forty** open acceptance criteria saying nothing at
all, so there was no way to tell a version that fell short of its own bar from one where somebody
forgot a tick. The cost was measured the same day: a criterion open since v0.9.0 said the coverage
threshold covered lines *and branches*; it never had, and the two files deciding whether the loop
continues and whether a dangerous command runs sat at 12.5 % of branches.

A criterion is now either closed with evidence, or says out loud that it was not met or has been
withdrawn — and the marker is a **shape rather than a word** (a bold opening ending in a colon, then
a substantial reason), because a target project's roadmap may be written in any language.

### Audits become data

`/productionaudit` runs the four audits once; `/productionauditloop` repeats until P0 + P1 + P2
reach zero. That exit condition cannot rest on the agent's word: an agent able to declare the loop
finished will finish it by declaring, and the declaration will be sincere.

So findings live in a machine-readable ledger at the head of the same file the audit templates
already produce. An audit that looked at nothing finds nothing, and zero then reads exactly like a
clean pass — so coverage is required of every ledger and not only of the clean ones, marking a
finding fixed requires evidence, and a dimension with no ledger is not a clean dimension but one that
never ran.

---


## 11. Extending it

**A new engine.** Implement `core/backends/Backend.mjs`, register it in the factory, add a model
preset. Do not touch the gates — if you find yourself changing loop logic for one engine, the
abstraction is leaking.

**A new rule in the guard.** Apply the criterion from section 7 honestly. If a rule would fire on
a routine command, it costs more than it saves. Add it to `core/safety.mjs` and to the
false-positive measurement in the tests.

**A new stage.** Extend the orchestrator skill. Keep the stage doing one step per iteration:
progress must stay visible from the outside.

**Whatever you add, verify the claim.** The single most valuable habit in this project has been
checking that what a document says still matches what the code does. Four documents in one release
turned out to describe a system that no longer existed.
