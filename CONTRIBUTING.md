# Contributing

Work from the public source at [0-SOFT/0-CODE](https://github.com/0-SOFT/0-CODE).
It supports Claude Code, Codex and OpenCode with one shared core. Integration into
an existing project uses [INTEGRATE](INTEGRATE.md) and the `.0-code/` namespace;
[PROJECT_SETTINGS](docs/PROJECT_SETTINGS.md) defines the configuration contract.

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
node tests/run.mjs --coverage-min=80    # the whole suite, plus the coverage gate
bash tests/smoke.sh                     # isolated lifecycle and guard checks
node tools/gen-ignore.mjs --check       # generated ignore policy agrees with its source
```

The public catalog contains five default MCP definitions: context7, playwright,
chrome-devtools, sequential-thinking and memory. Private skill, agent, command and
rule bodies, their generators and tests requiring that corpus are excluded. The
smoke script explicitly reports the absent private tool-corpus lifecycle check;
do not claim that public results validate excluded workflows. Selected MCP npm
versions are tested SemVer minima, so preserve valid newer packages. These five
need no external API key; browser tools need a browser. Optional account examples
require explicit configuration and authorization. A green doctor proves local
prerequisites rather than live connections.

Automatic root-based 1.x migration needs `config/legacy-installations.json`, which
is excluded. Do not add deletion based only on filenames or promise migration from
this checkout without ownership evidence. New installations and `.0-code/` upgrades
remain supported.

The compatibility matrix is Node.js **20, 22 and 24** on Windows and Linux; CI is configured to run
the full suite, coverage gate and smoke checks in all six cells. A workflow change
does not prove those jobs ran: report pending, failed or unavailable CI explicitly.
Node.js 20 remains the compatibility minimum; do not infer exact patch coverage
from a major-version result.

For release acceptance, run the full default suite three consecutive times on
**each of Node 22 and 24**, with `--coverage-min=80`, and smoke on both. Repeat the
full suite and smoke from a clean public checkout on both versions. Run at least
the process and lifecycle CLI tests on Node 20, plus any other supported versions
installed on the machine. Do not reduce test concurrency or disable scenarios to
obtain a passing result. Missing local platforms remain explicit evidence gaps.

Record the revision, OS, exact Node version, executable path, commands, logs and
results for every cell. Select each runtime by its explicit executable path and
prepend its directory to the child check's `PATH`; verify `process.version` and
`process.execPath` **inside Bash** before smoke, whose `node` commands use `PATH`.
An absolute path to the parent runner alone does not select child runtimes. If
Node 20 is missing, unpack an official archive in scratch, verify its SHA-256
against the release's SHASUMS256 file, and record both; never install globally.
Windows process regressions must demonstrate failure on the old implementation
and success on all three versions, including actual asynchronous metadata and
complete stdout/stderr after normal exit.

In addition to isolated checks, exercise `scan/install/doctor/uninstall` from a
clean public copy under the machine's normal Node 22 environment, with toolset
disabled and a disposable project. Preserve personal profiles and authentication;
verify real prerequisites with doctor and compare project bytes before/after.

Use temporary projects and native engine profiles for verification. User-scope
delivery changes native user tool/MCP settings and is removed separately; choose
scope explicitly. Never copy authentication or replace the owner's model/effort
preferences just to make a test pass. Precedence is flags, environment, project
configuration, then native engine settings. See [ENGINE_SETTINGS](docs/ENGINE_SETTINGS.md).
Keep development reports and logs private; role paths in project configuration
still describe documents the installed product creates.

When README meaning changes, update all ten translations against the actual
English paragraphs before updating their `tracks` digest. The translation check
detects stale markers; it cannot assess meaning or prose quality. Run
`node --test tests/unit/translations.test.mjs` and review links and claims as well.

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
