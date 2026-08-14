# Contributing

Thank you for looking. This project has a small number of strong opinions, and knowing them up
front will save you time.

---

## The one habit that matters here

**Verify the claim, not the code.**

Across three releases of this project, every serious defect was found by running something and
looking at the result, while test coverage sat above 80%. None was caught by a test. Tests check
what you wrote; what breaks is what you *claimed*.

So: if you add a mechanism, demonstrate it working. If you fix a bug, show the failure first. If
you change documentation, check that the code still does what the new sentence says.

---

## Before you open a pull request

```bash
node tests/run.mjs --coverage-min=80    # 234 tests plus the coverage gate
bash tests/smoke.sh                     # 111 end-to-end checks, plus 6 skipped aloud
```

The six skipped checks are expected: they need artefacts that exist only in a maintainer's working
checkout (a live capability catalogue, a personal toolset snapshot). They are printed by name, never
silently — if the number grows, something stopped being published.

Both must be green on your platform. If you can, run them on the other one too — several bugs in
this repository existed only on Windows or only on POSIX.

---

## Design rules that will come up in review

**Zero runtime dependencies.** Node built-ins, bash, git. This is not asceticism: the framework
installs into other people's projects, and every dependency it brings is one they did not choose.
That includes the test tooling.

**One source of truth per concept.** Destructiveness rules live in `core/safety.mjs` and are
consumed everywhere, including a generated plugin. Permissions live in
`core/permissions-policy.mjs`, and both settings files are generated from it with a test that
fails on drift. If you find yourself writing the same rule twice, that is the bug.

**Guard rules must earn their place.** A rule is added only if the consequence is unrecoverable
*and* there is essentially no legitimate use for it in a development loop. A measurement once
showed a broader ruleset blocking 7 of 11 everyday commands — every false refusal costs the loop a
turn. If your rule would fire on routine work, it costs more than it saves.

**Fail loudly or fail open, never fail silently.** A hook that cannot understand the state must let
the session end rather than block it. A tool that cannot do its job must say so. Several defects
here survived for versions because something exited 0 while doing nothing.

**Comments explain why, not what.** The code says what it does. The comment should say what
happened that made it necessary. That is the most valuable content in this repository.

---

## Commit messages

Explain the reasoning, not just the change. A good message here answers: what was observed, what
was done, and what was ruled out. Long is fine.

---

## Reporting a defect

The most useful issue contains a way to reproduce and the actual output. If a claim in the
documentation turned out to be false, that is a defect worth reporting on its own — a statement
that stopped being true is exactly the class of problem this project keeps finding in itself.

Numbers in [docs/PROVEN.md](docs/PROVEN.md) are reproducible measurements. If you get a different
result, please say so.

---

## What is unlikely to be merged

- Adding a dependency to solve something Node built-ins already handle.
- Broadening the guard rules without a false-positive measurement.
- Blocking secrets from being committed. This is a deliberate decision: the ability to commit a key
  on purpose is preserved, and the framework informs rather than obstructs.
- Changes that make the two loop drivers behave differently. They share one decision function on
  purpose.

---

## Security

Please do not open a public issue for a vulnerability — see [SECURITY.md](SECURITY.md).
