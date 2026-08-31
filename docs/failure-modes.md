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
| **An agent that changes files but gets nowhere** | Nothing catches this. A turn that edits, reverts and edits again looks exactly like a turn that works. This row used to promise a `stuck` blocker after three failed attempts at one task; that mechanism never existed in the code, and v1.11.0 removed the promise rather than inventing it — see below. | Read `docs/logs/` and stop the loop yourself if the same ground is being covered repeatedly. |
| Three measured turns with no measurable progress | An escalation directive is injected into the prompt; if that does not help, a `no_progress` blocker is recorded. Both drivers do this since v1.8.0; on the Claude Code hook the count starts one turn later, because its first run has nothing to compare against. | Check whether the task is actually executable, or whether the agent is looping on read-only work. |
| `docs/STATE.md` stands untouched for a long time | The continuation text warns the agent, naming the elapsed minutes and the threshold (`stall_timeout_minutes`, 20 by default). It never stops the loop. This catches what the turn counter cannot: turns that happen, take a long time, and change nothing. | If the agent is waiting on a background job, it must check that job directly instead of waiting for a notification. |
| **An install runs inside a running Claude Code session** | The installer no longer claims the loop is active: settings are read when a session starts, so hooks written now are not loaded now. The last thing it prints is how to restart. | `/exit`, then `claude --continue`. Until then the loop is not running, whatever else the output said. |
| An additive config file is replaced instead of merged | It is not any more: `.gitignore` and `.gitattributes` are merged, existing lines untouched. A rule that survives only in a `.bak` copy protects nothing — in one live project the lost rule was the one hiding a file of root passwords. | Files the installer *does* replace are listed in their own block of the summary, each with its backup. |
| **A documented behaviour is implemented by only some drivers** | A guard fails when a driver does not reach the shared implementation. The promise about progress measurement was false for the default engine across five releases because nothing compared the document with the code. | Wire the driver to the shared module. Do not write a second implementation: two of anything is the drift class this project keeps closing. |
| The iteration or budget cap is reached | A blocker with the cause, plus a notification. | Raise the cap in `docs/STATE.md` or stop deliberately. |
| **No cap is set at all** (the default since v1.9.0) | Nothing stops the loop but a blocker or a finished roadmap. This is the intended state: a limit belongs to whoever wants one. | Set `max_iterations` to a positive number, and `budget_metrics.cap_usd` for spending. |
| **A spending cap is set but never fires** | Expected under the Stop hook: `version_cost_usd` is written by `core/supervisor.mjs` alone, so in interactive mode the counter stays at 0. The loop now says so in every continuation instead of leaving the cap to look like a guard. | Run the loop through the supervisor if you need the cap enforced, or use the iteration cap instead. |
| **An iteration cap above `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`** | The backstop stops the session first, so the cap you set is not the one that applies. The loop names this in the continuation. | Raise the backstop in `core/loop-limits.mjs` and regenerate the settings, or lower the cap. |
| **A second loop is started on the same project** | The file lock refuses the second launch and names the current owner. If the owner is dead or its heartbeat went stale, the loop is taken over instead. | None needed. To force a take-over, delete `docs/.loop.lock`. |
| An empty `next_step_prompt` | The loop does **not** stop — this means "decide from STATE and ROADMAP". A generic instruction is substituted. | To stop the loop, write a blocker. |
| **The step instruction is left over from an earlier version** | Refused on the way in: since v1.7.0 a patch that moves `current_version`, `current_stage` or `current_prompt_file` without rewriting `next_step_prompt` is rejected by `lib/update-state.mjs`. If one arrives anyway — a hand-edited STATE, or a project that upgraded mid-flight — it is dropped on the way out: the agent gets the generic instruction instead, and the driver writes the reason to stderr. | None needed. Rewrite `next_step_prompt` in the same patch that moves the loop; `null` clears it deliberately. |
| **An accidental `claude` run inside a project folder joins the loop** | Formally correct: the Stop hook does its job. But an accidental probe becomes a long unattended run. | Stop it with a blocker, or lower `max_iterations`. For one-off checks use a folder without the hook. |

### Why there is no `stuck` blocker (v1.11.0)

Documentation promised one for a long time: three failed attempts at the same task, a blocker, the
loop ends. The code never had it — `attempts_per_task` was written empty by the installer and read
by nobody, and the word `stuck` appeared nowhere.

It was removed rather than implemented, because both halves of the idea are invisible to a driver:

- **"the same task"** — a turn snapshot holds the git head, a hash of the working tree and a hash of
  STATE. No task identity anywhere. The original design stored a task key in `attempts_per_task`,
  filled in **by the agent** — another hand-maintained field, which is the defect class this project
  spent v1.7.0 and v1.10.0 removing.
- **"a failed attempt"** — a driver sees change or no change, never success or failure. A turn that
  edits files and achieves nothing looks identical to one that edits files and succeeds.

What survives is the observable half, and `no_progress` already measures it: three turns in a row
that change neither git nor STATE. What stays uncovered is an agent that keeps changing files
while going nowhere. The nearest observable proxy would be a working tree that returns to an earlier
state — churn rather than progress — but that is a different mechanism with its own false positives,
and it would be dishonest to ship it under the old name.

## 5. Processes and cleanup

| Trigger | Action | Recovery |
|---|---|---|
| The supervisor is killed from the outside (`kill -9`, closed terminal) | Exit handlers do not run at all in that case — this is a hard limit of every operating system. An on-disk registry of child ids is kept, and the **next launch** sweeps whatever is left. | If you need immediate cleanup: `pkill -f opencode`. |
| A turn hangs silently | The idle timeout (10 minutes without a byte of output) aborts it; a total cap of 4 hours acts as a far backstop. **Duration alone never aborts a turn** — a working agent may legitimately run for a long time. | None needed; the failure is reported rather than silent. |
| A remote run dies with the ssh session | Expected: a plain background launch is tied to the session. | Launch with `setsid nohup … < /dev/null &`. |

| **A permission prompt appears even under bypassPermissions** | Nothing the framework can do at run time: an `ask` rule in the settings outranks every mode AND the hook's decision. | `node tools/doctor-permissions.mjs <project>` names the cause; `node tools/gen-settings.mjs --project <project>` removes it, with a backup. Settings are read at session start, so restart afterwards. |
| **`SAFETY_GUARD_MODE` was set and nothing changed** | An unrecognised value keeps the safe default. Since v1.10.0 the guard writes the substitution to stderr instead of swallowing it. | Use one of `arbiter`, `guard-only`, `allow-all`. The acting mode is also written to `~/.claude/safety-guard.log`. |
| **`AGENT_BACKEND` was set and the other engine ran** | Fixed in v1.10.0: a value that is set but not supported is now refused. It used to fail the supported-list test quietly and fall through to auto-detection, so a typo ran Claude while you expected OpenCode. | Use `claude` or `opencode` exactly, or unset the variable for auto-detection. |

## 6. Protection and secrets

| Trigger | Action | Recovery |
|---|---|---|
| The agent attempts something irreversible | The arbiter hook (Claude Code) or the plugin (OpenCode) blocks it and logs the reason to `~/.claude/safety-guard.log`. Only four rules exist — see README. | If the command was intentional, run it manually outside the loop. |
| **The agent removes its own protection** | It can delete the in-project copy of the plugin and rewrite the permission file. That is why the main plugin lives **outside** the working directory, and the scaffolding is restored before every turn with permissions compared by content. | None needed. Note the honest limit: within a single turn the project-level config can still be edited. |
| A commit picks up a file that looks like key storage | One line in the log and a notification if configured. **Nothing is blocked** — this is a deliberate decision, the ability to commit a key is preserved. | If it was unintended, treat the keys as exposed: rotate them and purge the history. |
| **One protection policy stored twice** | It cannot be any more: `.gitignore` and `templates/gitignore.public` are both rendered from `lib/ignore-policy.mjs`, and smoke section 14 fails if either drifts. This was found the expensive way in v1.7.1 — the entries guarding `opencode.json`, which provisioning fills with live keys, existed only in the copy that protects *other people's* machines, and were missing from the one protecting the machine with the real `config/.env`. A copy with no shared source drifts by construction, not by accident. | `node tools/gen-ignore.mjs` re-renders both from the source. Add an entry to the module, never to one of the files. |
| A path gains an ignore rule but is already tracked | The rule changes nothing: git keeps staging whatever is already in the index. Smoke check 14c names such paths, because the rule check and the index check are different questions and one green cannot stand for both. | `git rm -r --cached <path>` — the file stays on disk and leaves the index. History is not rewritten for this. |
| A gate is red on every machine where the tool is actually used | It stops being a gate. Sanitisation used to scan `config/.env`, a file that by design holds live values, is ignored by git and is never published. The scan now asks git what it *would* stage, so no filename is special-cased. | If a check is permanently red, strengthen its claim rather than mute it: an exclusion is honest only when something else still asserts the excluded file cannot be committed. |
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
