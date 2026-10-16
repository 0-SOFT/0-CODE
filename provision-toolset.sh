#!/usr/bin/env bash
# The same Node installer owns project and machine toolsets.
set -uo pipefail
FRAMEWORK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
exec node "$FRAMEWORK_ROOT/tools/0code.mjs" install-tools "$@"
