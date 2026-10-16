#!/usr/bin/env bash
# Fast, real lifecycle/guard smoke gate. Detailed regression and coverage: node tests/run.mjs.
set -euo pipefail
FW="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$FW"

for script in bootstrap.sh provision-toolset.sh hooks/ralph-loop-stop hooks/safety-guard hooks/run-hook.cmd; do
  bash -n "$script"
done
# These filesystem series share the host's disk and native CLIs. Keep every check, run one file at a time.
# The complete coverage suite keeps Node's default concurrency.
node --test --test-concurrency=1 \
  tests/integration/document-paths.test.mjs \
  tests/integration/ignore-policy.test.mjs \
  tests/integration/bootstrap-install.test.mjs \
  tests/integration/project-cli.test.mjs \
  tests/integration/project-installation.test.mjs \
  tests/unit/acceptance.test.mjs \
  tests/unit/translations.test.mjs
if [[ -f tests/integration/user-installation.test.mjs ]]; then
  node --test tests/integration/user-installation.test.mjs
else
  echo "SKIPPED: private tool corpus lifecycle checks; this distribution excludes their inputs."
fi
