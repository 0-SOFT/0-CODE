# GUIDELINE — how this works, and why it works this way

> **Framework version:** v1.6.1.
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

Exactly four conditions stop the loop, and all four are visible in STATE:

1. a **blocker** — something only a human can resolve;
2. `released_version == current_version` — the roadmap is finished;
3. the **iteration cap**;
4. the **budget cap**.

An empty `next_step_prompt` does **not** stop anything — it means "decide from STATE and ROADMAP".
This is written down because the instructions once claimed the opposite, and the author of those
instructions (this framework, working on itself) followed them and stopped a healthy loop.

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

**The lock.** Two supervisors were once started against the same state file and competed for
writes. A live owner now refuses the second launch; a dead one is taken over, because a crashed
process must not block autonomy forever.

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

230 tests plus 117 smoke checks, no test framework — the project is zero-dependency including its
tooling.

More interesting is what the tests are *for*. Over three versions, every serious defect was found
by live checks while coverage sat above 80%, and **none** was caught by a test. The reason is
simple: tests check what you wrote, and what breaks is what you *claimed*.

So the suite now includes a file of blind-spot tests, one per class of defect, each written from a
real incident: a script referencing a deleted file; documentation promising behaviour that does not
exist; a method reporting success without a mechanism behind it; a notification that silently goes
nowhere; a default chosen without justification; a version header drifting from the manifest.

---

## 10. Extending it

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
