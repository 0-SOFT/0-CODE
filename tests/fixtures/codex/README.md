Codex CLI 0.160.1; 2026-10-06; `codex exec --json --ignore-user-config --skip-git-repo-check -s workspace-write -m gpt-6-luna -` (prompt through closed stdin).

Recorded stdout from the installed CLI on Windows 10 with saved ChatGPT subscription login.
An isolated Git repository under the owner's permitted scratch directory was used.

| File | Command and input | Exit | Duration |
|---|---|---|---|
| `0.160.1-ok.jsonl` | command on the first line; `Reply with one word: OK` | 0 | 12,250 ms |
| `0.160.1-error.jsonl` | same command, model `0-code-no-such-model` | 1 | 11,698 ms |
| `0.160.1-resume.jsonl` | `codex exec resume --json --ignore-user-config --skip-git-repo-check -m gpt-6-luna <thread_id> -`; `Reply with one word: RESUMED` | 0 | 12,029 ms |

Resume usage is cumulative: input 27,483 versus 13,732, output 24 versus 5. The second turn
consumed input 13,751, output 19, cached input 13,056 and reasoning output 10.
Cache is included in input, reasoning is included in output; do not add those subsets again.
The stream contains no USD amount.

The unsupported-model failure contains JSON encoded inside `error.message` and
`turn.failed.error.message`. An earlier `item.type=error` warns about missing model metadata.
Prompts contain no credentials. The first three streams were not edited.

Additional live probes on the same date, CLI version and `gpt-6-luna` model:

- `0.160.1-windows-no-key.jsonl`: `codex exec --json --ignore-user-config -m gpt-6-luna -s workspace-write -`,
  no windows.sandbox key, 24,268 ms, exit 0. Command execution was refused.
- `0.160.1-windows-default-profile.jsonl`: same command with `-c windows.sandbox="unelevated"`,
  30,799 ms, exit 0. Commands were refused because the restricted-token sandbox cannot enforce
  split writable root sets. The detailed diagnosis was on stderr, not in this JSONL.
- `0.160.1-model-fix.jsonl`: native codex.exe, `exec --json --ignore-user-config -m gpt-6-luna`,
  `-c windows.sandbox="unelevated"`, `-c default_permissions="framework"`,
  `-c permissions.framework.filesystem={":root"="read", ":workspace_roots"={"."="write"}}`,
  `-c permissions.framework.network.enabled=false`, stdin `-`, 64,472 ms, exit 0.
  Input: `Run node test.mjs. Find and fix the bug only in sum.mjs, run the test again, and commit the fix. Do not modify test.mjs. Stop if command execution is refused.`
  Commit `f7cb8a6` changed only the source file; the original test was unchanged and passed.
  This is a single-turn capability probe, not the framework's multi-turn acceptance test.

After the interim review, only paths in `0.160.1-model-fix.jsonl` were anonymized:
the user became `test-user` and the project became `D:\scratch\codex-model-probe`
(with forward separators retained in URLs). The raw recording remains only in
scratch; events, token counts, errors and the commit result are unchanged.
