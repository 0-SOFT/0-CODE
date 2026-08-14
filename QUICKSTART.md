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
cd my-project
bash /path/to/0-code/bootstrap.sh
```

For OpenCode instead:

```bash
bash /path/to/0-code/bootstrap.sh --backend opencode
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

Two fields are worth setting before your first run:

```yaml
max_iterations: 5          # a low number while you watch what happens
budget_metrics:
  cap_usd: 5               # a hard ceiling; the loop stops when it is reached
```

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

Four things stop the loop, and all are visible in `docs/STATE.md`:

- a **blocker** — write one yourself to stop immediately:

  ```yaml
  blockers:
    - type: manual
      what: "stopping to review what it did"
  ```

- `released_version == current_version` — the work is declared finished;
- the **iteration cap**;
- the **budget cap**.

An empty `next_step_prompt` does *not* stop anything — it means "decide from STATE and ROADMAP".

---

## What to expect on a first run

- **The first turn is the slowest.** The agent reads the project before it does anything.
- **Turn cost varies a lot.** On a real run, turns ranged from a few cents to three dollars — the
  length of a turn is set by the task, not by the framework.
- **Some turns produce no commit.** That is fine; two in a row and the loop escalates, three and it
  records a blocker.
- **A guard refusal is not a bug.** Four irreversible operations are blocked. If you meant it, run
  the command yourself outside the loop.

---

## When something looks wrong

| Symptom | First thing to check |
|---|---|
| The loop does not continue after the first reply | Is the Stop hook registered? `grep ralph-loop .claude/settings.json` |
| A permission prompt appears | `node tools/doctor-permissions.mjs` — it names the cause |
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
