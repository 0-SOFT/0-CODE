#!/usr/bin/env bash
# Compatibility entrypoint; the Node CLI owns all installation behaviour.
set -uo pipefail
FRAMEWORK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
exec node "$FRAMEWORK_ROOT/tools/0code.mjs" install "$@"
