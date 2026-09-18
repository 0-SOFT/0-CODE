# Quickstart — from zero to the first autonomous commit

This takes one command to install and one file to edit. Roughly ten minutes, most of which is the
agent working.

---

## 1. Check what you have

```bash
node --version     # 18 or newer
git --version
bash --version     # on Windows: Git for Windows
```

Then whichever engine you intend to use:

```bash
claude --version     # Claude Code
opencode --version   # OpenCode (needs OPENROUTER_API_KEY)
```

---

## 2. Install into a project

```bash
git clone https://github.com/0-SOFT/0-CODE.git

cd my-project
bash /path/to/0-CODE/bootstrap.sh
```

For OpenCode instead:

```bash
bash /path/to/0-CODE/bootstrap.sh --backend opencode
```

Bootstrap tells you what it created. It never overwrites your `CLAUDE.md` or your hooks — it
appends between markers and deep-merges settings. Running it twice is a no-op.

It also tells you plainly whether notifications will work. If you want to be told when the loop
stops:

```bash
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_CHAT_ID=...
```

---

## 3. Give it something to do

Open `docs/STATE.md` and put a real task in `next_step_prompt`. Be concrete — a measurable step
beats a wish:

```yaml
next_step_prompt: "Run `npm test`. One test is failing. Find the cause in the source (not in the
  test), fix it, make sure the suite passes, then commit with a descriptive message."
```

**A fresh project has no limits at all** — that is deliberate, a limit belongs to whoever wants one.
For a first run you almost certainly want one:

```yaml
max_iterations: 5          # a low number while you watch what happens
budget_metrics:
  cap_usd: 5               # see the caveat below
```

The spending cap is enforced **only when the supervisor drives the loop**, because the supervisor is
what receives the cost of a turn back from the engine. Under the Claude Code Stop hook nothing fills
the counter, so the cap cannot fire — the loop says so in every continuation rather than letting it
look like a guard. If you are running under the Stop hook, `max_iterations` is the limit that will
actually stop you.

---

## 4. Start the loop

**Claude Code** — just start a session in the project:

```bash
claude
```

Give it any first prompt. When the model finishes replying, the Stop hook reads `docs/STATE.md` and
pushes it straight back to work. That repeats until a stop condition.

**OpenCode** — the loop is driven from outside:

```bash
AGENT_BACKEND=opencode node core/supervisor.mjs --state docs/STATE.md
```

The supervisor runs a self-check first (a few seconds, a fraction of a cent), then starts turning.

---

## 5. Watch it work

```bash
git log --oneline          # commits appearing without you
grep -E "^iteration:" docs/STATE.md
grep -A2 budget_metrics docs/STATE.md    # what it has spent
```

You will see something like this in the supervisor output:

```
[supervisor] engine self-check passed in 4 s
[supervisor] turn succeeded on attempt 2
[supervisor] backend scaffolding restored: .opencode/plugins/safety-guard.js
```

The second line means a transient failure was survived. The third means the agent removed its own
guard and it was put back before the next turn.

---

## 6. Stop it

**By default two things stop the loop**, and both are visible in `docs/STATE.md`:

- a **blocker** — write one yourself to stop immediately:

  ```yaml
  blockers:
    - type: manual
      what: "stopping to review what it did"
  ```

- `released_version == current_version` — the work is declared finished.

Two more exist and are **off until you switch them on**: the iteration cap (`max_iterations`) and
the spending cap (`budget_metrics.cap_usd`, supervisor only — see above).

Nothing runs away silently in the meantime: three turns that change neither git nor `docs/STATE.md`
make the loop write itself a `no_progress` blocker, and a state file that stops changing is reported
in every continuation.

An empty `next_step_prompt` does *not* stop anything — it means "decide from STATE and ROADMAP".

---

## What to expect on a first run

- **The first turn is the slowest.** The agent reads the project before it does anything.
- **Turn cost varies a lot.** On a real run, turns ranged from a few cents to three dollars — the
  length of a turn is set by the task, not by the framework.
- **Some turns produce no commit.** That is fine; two in a row and the loop escalates, three and it
  records a blocker.
- **A guard refusal is not a bug.** Four irreversible operations are blocked: destroying the
  filesystem, formatting a disk, killing every agent process by name, and `git push --force`.
  Everything else is allowed. If you meant it, run the command yourself outside the loop.

---

## If the guard gets in the way

The default needs no configuration and is what you want almost always. `SAFETY_GUARD_MODE` changes
it if you need something else:

| Mode | Use it when |
|---|---|
| `arbiter` | **the default.** Leave it alone unless one of the rows below is you |
| `confirm` | you would rather the agent argue for a dangerous command than be refused. It names the consequence and asks for a stated reason, and it watches a few more things than the default does |
| `allow-all` | you want nothing denied at all, including `rm -rf /`. Your call, stated plainly |
| `guard-only` | you are debugging the permission system itself; ordinary prompts come back |

An unrecognised value keeps the default **and says so** — it will not silently pretend to have
obeyed. The acting mode is written to `~/.claude/safety-guard.log`.

---

## When something looks wrong

| Symptom | First thing to check |
|---|---|
| The loop does not continue after the first reply | Is the Stop hook registered? `grep ralph-loop .claude/settings.json` |
| A permission prompt appears | From the framework clone: `node tools/doctor-permissions.mjs <your project>` — it names the cause, and `node tools/gen-settings.mjs --project <your project>` fixes it |
| The loop refuses to start | Read the self-check output; it names the model and the problem |
| "launch refused: the loop is already running" | Another loop holds the project. `cat docs/.loop.lock` |
| It stopped and you do not know why | `grep -A5 blockers docs/STATE.md` |

The full catalogue is in [docs/failure-modes.md](docs/failure-modes.md) — every entry there is
something that actually happened.

---

## Next

- [README.md](README.md) — what the framework is and what it deliberately does not do.
- [GUIDELINE.md](GUIDELINE.md) — how it works and why each decision was made.
- [docs/PROVEN.md](docs/PROVEN.md) — what was verified, with numbers.
