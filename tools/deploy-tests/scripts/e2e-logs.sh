#!/usr/bin/env bash
# Logs hook for Next.js's own deploy-mode test suite (`NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH`).
#
# Run in the same working directory as the deploy hook, after the tests. The markers the harness reads
# come first; what the deployment said about itself follows, for a failure to be read from.
#
# A deployed Function's runtime log is not something the public API serves, so there is none to add
# here: what this shows is the build and the deployment, which is where a failure of this adapter's own
# making shows up anyway.
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
