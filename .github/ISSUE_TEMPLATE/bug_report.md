---
name: Bug report
about: Something behaves differently from what is documented
labels: bug
---

**What you did**

The command you ran, or the state you were in.

**What happened**

Actual output. Paste it rather than describing it — the exact wording usually matters.

**What you expected**

If a document says otherwise, please link to it. A claim that stopped being true is a defect in its
own right.

**Environment**

- OS:
- Node version:
- Engine and version (`claude --version` / `opencode --version`):
- Framework version (from `.claude-plugin/plugin.json`):

**Diagnostics that often help**

```
node tools/doctor-permissions.mjs      # if the problem involves permission prompts
cat docs/.loop.lock                    # if the loop refused to start
grep -A5 blockers docs/STATE.md        # if the loop stopped unexpectedly
```
