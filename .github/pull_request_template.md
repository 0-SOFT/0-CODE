## What this changes

## Why

What did you observe that made this necessary? A reproduction, a measurement, or a failing case is
worth more than a description.

## How it was verified

- [ ] `node tests/run.mjs --coverage-min=80` passes
- [ ] `bash tests/smoke.sh` passes
- [ ] Record exact Node version, executable path, OS, revision and logs for each tested cell
- [ ] CI matrix: Node 20/22/24 on Linux and Windows; pending/unavailable jobs stated explicitly
- [ ] Release: three consecutive default full suites with coverage >=80% on each of Node 22/24; smoke on both
- [ ] Release: clean public copy full suite and smoke on Node 22/24; process/CLI checks on Node 20
- [ ] Every installed supported runtime checked; scratch downloads verified against official SHA-256
- [ ] Child PATH selected explicitly; version/path confirmed inside Bash before smoke
- [ ] Windows process fix reproduced on old code; real child and full stdout/stderr verified on 20/22/24
- [ ] Release: normal-environment Node 22 public CLI lifecycle, toolset disabled, real doctor and byte restoration; personal profiles preserved
- [ ] If a mechanism was added: demonstrated working, not only unit-tested
- [ ] If documentation changed: the code still does what the new text says

## Anything ruled out

Approaches considered and rejected, and why. This is often the most useful part of a review.
