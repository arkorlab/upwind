#!/usr/bin/env bash
# Cleanup hook for Next.js's own deploy-mode test suite (`NEXT_TEST_CLEANUP_SCRIPT_PATH`).
#
# Gives the project back, so that the next fixture may have it. The deployment itself is left where it
# is: the API has no delete, and a host retires what a later deployment replaces.
#
# Not the only way a claim is given back — one whose application the harness has already removed is
# spent, and the next run clears it — so a cleanup that cannot run holds nothing up for long.
set -euo pipefail

tool_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node "${tool_dir}/src/main.ts" release || true
