#!/usr/bin/env bash
# Deploy hook for Next.js's own deploy-mode test suite (`NEXT_TEST_DEPLOY_SCRIPT_PATH`).
#
# The suite's harness runs this with the working directory set to an isolated copy of the test
# application. It builds that application through this adapter, hands the bundle to a host over the
# host's public API, and prints the URL the host serves it on — the only thing allowed on standard
# output.
set -euo pipefail

# Where everything is, from this script's own place rather than from one another.
tool_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${tool_dir}/../.." && pwd)"
# The contract's own variable, and it names the adapter's repository: keep it working, since the
# workflow in Next.js's documentation sets it and people copy that workflow.
adapter_dir="${ADAPTER_DIR:-${repo_root}}"
core_dir="${adapter_dir}/packages/core"

# `dist` is the adapter as a release gives it to a project, which is what should be tested; `src` is
# what a working copy has before `pnpm build`, and failing over to it beats failing on a forgotten
# build step.
if [ -f "${adapter_dir}/packages/adapter/dist/index.js" ]; then
  export NEXT_ADAPTER_PATH="${adapter_dir}/packages/adapter/dist/index.js"
else
  echo 'no built adapter; running it from source (pnpm --filter @stayingupwind/adapter build)' >&2
  export NEXT_ADAPTER_PATH="${adapter_dir}/packages/adapter/src/index.ts"
fi

# An id is 21 Base58 characters and the adapter refuses a deployment id that is not one, so mint it the
# way a host does rather than spell a literal here that would be rejected. Leaving it unset is not the
# same thing: the build would mint its own, and the assets would go out without the `?dpl=` the suite
# reads.
export NEXT_DEPLOYMENT_ID="${NEXT_DEPLOYMENT_ID:-$(
  node --input-type=module -e "
    import { DEPLOYMENT_ID_PREFIX } from '${core_dir}/src/bundle/schema.ts';
    import { createId } from '${core_dir}/src/util/id.ts';
    process.stdout.write(createId(DEPLOYMENT_ID_PREFIX));
  "
)}"

# What the suite's own deploy mode builds with (`--build-env NEXT_PRIVATE_TEST_MODE=e2e`): the config it
# writes turns this into `__NEXT_TEST_MODE`, which puts the hydration signal the browser waits for into
# the client. Without it every page the suite opens is waited on for ten seconds.
export NEXT_PRIVATE_TEST_MODE=e2e

# Deploy mode makes the isolated copy with `skipInstall: true` (`test/lib/next-modes/next-deploy.ts`),
# so the application arrives without its dependencies and installing them is this script's job.
pnpm install --no-frozen-lockfile --prod=false >&2

# The harness writes the application's own build script and appends `&& pnpm post-build`
# (`test/lib/next-modes/base.ts`). Run exactly what it wrote: a fixture's own build command and its
# build arguments are not ours to replace with a plain `next build`, and the appended step is not
# ours to drop either — in deploy mode the harness writes a `post-build` of its own that prints the
# three markers, but a fixture that has one keeps it (`...pkgScripts` comes after), and that one may
# do real work.
#
# So both sets of markers can end up in the log. The harness's own gates
# `NEXT_SUPPORTS_IMMUTABLE_ASSETS` on `VERCEL_IMMUTABLE_STATIC_FILES_ENABLED`, which nothing here
# sets, and would say `0`; this adapter turns them on, so ours says `1`. It is read with
# `String.prototype.match` — the first match, not the last (`test/lib/next-modes/next-deploy.ts`,
# `parseIdsFromCliOuput`) — and `.adapter-build.log` below puts ours at the top, ahead of the build's
# own output. Checked against v16.3.6.
build_command="$(
  node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).scripts?.build ?? 'next build'" \
    2>/dev/null || echo 'next build'
)"
echo "build command: ${build_command}" >&2

# What the build says is what `next.cliOutput` is read from, so it has to be kept and not only shown:
# `tee` writes it for the logs hook, and standard output stays reserved for the URL.
PATH="$PWD/node_modules/.bin:$PATH" sh -c "$build_command" 2>&1 | tee .adapter-build-output.log >&2

{
  echo "BUILD_ID: $(cat .next/BUILD_ID)"
  echo "DEPLOYMENT_ID: ${NEXT_DEPLOYMENT_ID}"
  # `modifyConfig` turns them on, and the harness asks whether it may expect them.
  echo "NEXT_SUPPORTS_IMMUTABLE_ASSETS: 1"
  # The markers the harness parses come first; the build's own output follows them.
  cat .adapter-build-output.log
} >.adapter-build.log

# The deployment. Its own account of what it did is kept for the logs hook; the URL it prints is this
# script's only standard output.
url="$(node "${tool_dir}/src/main.ts" deploy 2>>.adapter-server.log)"
printf '%s\n' "$url"
