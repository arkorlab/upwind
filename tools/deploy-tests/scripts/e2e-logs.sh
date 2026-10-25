#!/usr/bin/env bash
# Logs hook for Next.js's own deploy-mode test suite (`NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH`).
#
# Run in the same working directory as the deploy hook, after the tests. The markers the harness reads
# come first; what the deployment said about itself follows, for a failure to be read from.
#
# A deployed Function's runtime log is not something a host's public API serves, so for a host there is
# none to add: what this shows is the build and the deployment, which is where a failure of this
# adapter's own making shows up anyway. A server of this machine's keeps its own, which follows them.
set -euo pipefail

# A newline after each, because neither is guaranteed to end with one: a build or a deployment that
# died mid-line is exactly what this hook exists to show, and the header below must not land on the
# end of it.
if [ -f .adapter-build.log ]; then
  cat .adapter-build.log
  echo
fi

if [ -f .adapter-server.log ]; then
  echo '=== the deployment ==='
  cat .adapter-server.log
  echo
fi

# What a server of this machine's said as it served (`src/local-server.ts`): none on a host.
if [ -f .adapter-runtime.log ]; then
  echo '=== the server ==='
  cat .adapter-runtime.log
  echo
fi
