# Two ways to drive the loop

The framework does not run itself. Something has to decide, after each turn, that another turn should
happen — and there are exactly two things that can: the **Stop hook** inside Claude Code, or the
**supervisor**, a process outside it. Pick one. Running both against one project is not a mode; it is
a mistake the lock will now catch (v1.14.0), but it is still a mistake.

Everything in this document is stated because it was observed. Where a row records a limit, that
limit was measured, not assumed.

---

## The short answer

**Use the Stop hook** when you are at the keyboard, want to watch the work, and might interrupt it.
That is the default, and it is what `bootstrap.sh` installs.

**Use the supervisor** when the run must survive things the hook cannot survive: a network outage, a
crashed engine, a budget that has to be enforced. It is the only mode where the spending cap works
at all.

---

## Side by side

| | Stop hook | Supervisor |
|---|---|---|
| **What drives the loop** | Claude Code itself. The hook answers "block" at the end of a turn, and the same session carries on. | `core/supervisor.mjs`, an ordinary Node process. It reads STATE, asks the gates, launches one engine turn, writes the result, repeats. |
| **How to start** | Nothing to start. Open Claude Code in the project. | `node core/supervisor.mjs --state docs/STATE.md` |
| **How to stop** | Write a blocker into `docs/STATE.md`, or let a gate fire. | The same, plus Ctrl+C — it releases the lock and kills its engine processes on the way out. |
| **Survives a platform outage** | **No, by construction.** The hook lives inside the process that is dying; when the platform is unreachable there is nobody left to run a turn. Six such failures appeared in one real session. | **Yes.** Transient failures are retried with a growing pause (`core/turn-retry.mjs`, v1.5.0); real errors still stop at once, because repeating them only burns budget. |
| **Enforces a spending cap** | **No.** `budget_metrics.cap_usd` is compared against `version_cost_usd`, and nothing on this driver writes that field: the Stop payload carries a transcript path, and the transcript (1313 records, 12 record types, checked in v1.9.0) has no cost field at all. The loop says so in every continuation rather than letting the cap look like a guard. | **Yes.** The engine returns the cost of each turn, the supervisor accumulates it, and the gate can fire. This is the only reason to choose this mode if money is the constraint. |
| **Remembers the previous turn** | **Yes.** It is one session; the conversation continues. | **No.** Every turn is a fresh engine invocation, so everything worth remembering must be in `docs/STATE.md`. This is the mode's real price — pay attention to it before choosing. |
| **Counts empty turns** | Yes. | Yes, **the same way, from the same file**: since v1.15.0 both drivers use `core/turn-progress.mjs`, so a run that is stopped and resumed keeps its count. Before that the supervisor kept it in a variable and a restart reset it to zero, so the blocker could never arrive. |
| **Warns about secrets in a commit** | Yes (v1.8.0). | Yes (v1.5.0). Neither blocks: informing is the job, obstructing is not. |
| **Can you talk to it mid-run** | Yes — it is your session. | No. Send it work by editing `docs/STATE.md`. |
| **What you see while it runs** | The session, live. | Its stdout: the decision, the turn, warnings about long jobs, and every take-over of the lock. |

---

## What they share, and why that matters

Both drivers ask the **same** function whether to continue (`core/gates.mjs`), measure progress with
the **same** module (`core/progress.mjs`), keep the count in the **same** file
(`core/turn-progress.mjs`), respect the **same** lock (`core/loop-lock.mjs`) and inspect long jobs
with the **same** classifier (`core/long-jobs.mjs`).

That is not tidiness. Every time a rule has existed in two copies in this project, the copies drifted
apart in silence and a release went out believing something that was true of one driver only —
v1.7.1, v1.8.0 and v1.15.0 are each a version spent on one instance of it.

---

## Do not run both

The lock refuses the second driver and names the first, so the mistake is caught rather than
discovered later in a corrupted `docs/STATE.md`. The refusal tells you how to take the loop
deliberately:

```
rm docs/.loop.lock
```

A live owner holds the loop; an owner that has been silent for half an hour releases it
automatically. Liveness is proved by something that lives as long as the claimant does — the session
transcript for the hook, the process itself for the supervisor — and while a turn is running, the
supervisor keeps beating the heartbeat once a minute, so a long turn cannot lose its own lock.

---

## Options the supervisor takes

```
node core/supervisor.mjs [--state <file>] [--max <n>] [--model <m>] [--backend <id>]
                         [--dry-run] [--no-preflight]
```

`--dry-run` prints what would run and touches nothing — useful for confirming a project is wired up.
`--no-preflight` skips the engine self-check; the check itself costs one tiny turn and, since
v1.15.0, runs only after the gates have confirmed there is work, so starting on a finished version
costs nothing at all.

Every option that takes a value refuses a missing or unusable one instead of guessing. `--max`
without a positive whole number is an error, not silence: until v1.15.0 it produced `NaN`, and
`loops >= NaN` is false for ever, so asking for a cap and mistyping the number gave you an unbounded
unattended run.
