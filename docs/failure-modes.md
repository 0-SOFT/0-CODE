# Failure modes

> What breaks, how it looks from the outside, and what to do about it.
>
> Format: **trigger** (what happened) → **action** (what the framework does by itself) →
> **recovery** (what you can do if you need to intervene).
>
> Every entry below is something that actually happened during development. Nothing here is
> hypothetical.

---

## 1. Network and external services

| Trigger | Action | Recovery |
|---|---|---|
| The model API is unavailable (5xx, timeout) | Transient failures are retried with growing backoff (5 s, 10 s, 20 s, …). The Stop hook exits 0 and the loop survives. | Wait. If it persists for more than an hour, check the provider's status page. |
| Rate limit (429) | Classified as transient and retried. | None needed; consider a cheaper model tier for routine steps. |
| The engine returns a vague error such as "UnknownError" | Treated as transient, because the same text appears for both a server hiccup and a wrong model. | If it repeats, run the loop once with `--no-preflight` off — the self-check names the real problem. |
| Telegram is unreachable | The notifier fails without blocking anything. The loop continues. | Not critical. Check the token and chat id. |
| An MCP server is unavailable | The specific tool calls fail and count toward the attempt limit; three failures produce a `missing_resource` blocker. | Reconnect the MCP server. |

## 2. Authentication and resources

| Trigger | Action | Recovery |
|---|---|---|
| An API key is invalid or missing | The engine self-check refuses to start the loop and names the cause. Retries do not happen — they cannot help. | Set the key and rerun. |
| The account runs out of credit | Classified as a real error: the loop stops immediately rather than burning retries. | Top up the balance. |
| A required MCP server is not connected | The pre-flight check compares `required_tools` against `claude mcp list` and raises `missing_resource` before work starts, rather than failing halfway. | Connect the server or remove it from `required_tools`. |
| `node` or `jq` missing from PATH | The Stop hook cannot parse STATE and exits 0 (fail open) — the loop simply does not continue. Bootstrap's dependency check reports it explicitly. | Install Node.js 18+ and jq. |
| Disk full | Any write fails; the hook fails open. | Free up space. |

## 3. Context and memory

| Trigger | Action | Recovery |
|---|---|---|
| Auto-compaction fires | Important state lives in `docs/STATE.md`, which the orchestrator re-reads on the next iteration. Work continues from the same step. | None needed. |
| The session crashed | A new session **adopts** the loop: a stale `last_session_id` is not treated as a conflict, because a crashed process must not stop autonomy forever. | None needed. For a process-level restart use a supervisor. |
| `docs/STATE.md` is corrupt | The hook fails open. A ring buffer of backups (`STATE.md.bak.1..5`) is written before every change. | `cp docs/STATE.md.bak.1 docs/STATE.md`, or restore from git. |

## 4. The loop and blockers

| Trigger | Action | Recovery |
|---|---|---|
| Three failed attempts at the same task | A `stuck` blocker plus a notification. The loop ends. | Look at `attempts_per_task` and suggest a different approach. |
| Three turns with no measurable progress | An escalation directive is injected into the prompt; if that does not help, a `no_progress` blocker is recorded. | Check whether the task is actually executable, or whether the agent is looping on read-only work. |
| The iteration or budget cap is reached | A blocker with the cause, plus a notification. | Raise the cap in `docs/STATE.md` or stop deliberately. |
| **A second loop is started on the same project** | The file lock refuses the second launch and names the current owner. If the owner is dead or its heartbeat went stale, the loop is taken over instead. | None needed. To force a take-over, delete `docs/.loop.lock`. |
| An empty `next_step_prompt` | The loop does **not** stop — this means "decide from STATE and ROADMAP". A generic instruction is substituted. | To stop the loop, write a blocker. |
| **An accidental `claude` run inside a project folder joins the loop** | Formally correct: the Stop hook does its job. But an accidental probe becomes a long unattended run. | Stop it with a blocker, or lower `max_iterations`. For one-off checks use a folder without the hook. |

## 5. Processes and cleanup

| Trigger | Action | Recovery |
|---|---|---|
| The supervisor is killed from the outside (`kill -9`, closed terminal) | Exit handlers do not run at all in that case — this is a hard limit of every operating system. An on-disk registry of child ids is kept, and the **next launch** sweeps whatever is left. | If you need immediate cleanup: `pkill -f opencode`. |
| A turn hangs silently | The idle timeout (10 minutes without a byte of output) aborts it; a total cap of 4 hours acts as a far backstop. **Duration alone never aborts a turn** — a working agent may legitimately run for a long time. | None needed; the failure is reported rather than silent. |
| A remote run dies with the ssh session | Expected: a plain background launch is tied to the session. | Launch with `setsid nohup … < /dev/null &`. |

## 6. Protection and secrets

| Trigger | Action | Recovery |
|---|---|---|
| The agent attempts something irreversible | The arbiter hook (Claude Code) or the plugin (OpenCode) blocks it and logs the reason to `~/.claude/safety-guard.log`. Only four rules exist — see README. | If the command was intentional, run it manually outside the loop. |
| **The agent removes its own protection** | It can delete the in-project copy of the plugin and rewrite the permission file. That is why the main plugin lives **outside** the working directory, and the scaffolding is restored before every turn with permissions compared by content. | None needed. Note the honest limit: within a single turn the project-level config can still be edited. |
| A commit picks up a file that looks like key storage | One line in the log and a notification if configured. **Nothing is blocked** — this is a deliberate decision, the ability to commit a key is preserved. | If it was unintended, treat the keys as exposed: rotate them and purge the history. |
| A permission prompt appears despite bypass mode | Usually an `ask` rule somewhere in the settings chain, a broken settings file that is silently ignored, or a hook reading a non-existent variable. | `node tools/doctor-permissions.mjs` names the cause and the cure. |

## 7. Installation

| Trigger | Action | Recovery |
|---|---|---|
| `CLAUDE.md` already exists in the project | Bootstrap appends its section between markers rather than overwriting your file. | None needed. |
| `.claude/settings.json` already exists | Deep merge: your own hooks are preserved, the framework's are added. | None needed. |
| Bootstrap is run twice | It detects the version marker and reports "already installed". | To reinstall, delete `.claude/.framework-version`. |
| Hooks fail silently on Linux after a Windows checkout | Line endings. The polyglot wrapper is stored with CRLF for cmd.exe, and bash chokes on it. Bootstrap normalises it on POSIX. | Make sure `.gitattributes` came across with the project. |

## 8. What does not recover automatically

- **Uncommitted work.** Protection deliberately does not block `git reset --hard` or `git clean` —
  those are routine operations, and blocking them costs more than it saves. Commit often;
  `git reflog` recovers committed work.
- **Bad code the agent wrote.** No mechanism here judges correctness. That is what tests and
  review are for.
- **A secret that was committed and pushed.** Consider it exposed from the moment it left the
  machine.

---

## Recovery principles

1. **Fail open.** A hook must never block the agent with its own error. If the hook cannot
   understand the state, it allows the session to end.
2. **Atomic state.** Every write to `docs/STATE.md` goes through a temporary file plus rename,
   with a backup taken beforehand.
3. **A blocker is a resource problem, not an excuse.** Before recording one, the orchestrator
   re-checks whether an available tool solves the problem.
4. **Report, do not hide.** A silent failure is worse than a loud one: the entries above exist
   because several failures were silent at first and cost hours to find.
