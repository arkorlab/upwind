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
  # The directory travels in the environment and is turned into a URL there: a path interpolated into
  # this source would end the string it sits in the moment somebody's checkout has a quote in its name.
  CORE_DIR="${core_dir}" node --input-type=module -e "
    import { pathToFileURL } from 'node:url';
    const core = pathToFileURL(process.env.CORE_DIR + '/');
    const { DEPLOYMENT_ID_PREFIX } = await import(new URL('src/bundle/schema.ts', core).href);
    const { createId } = await import(new URL('src/util/id.ts', core).href);
    process.stdout.write(createId(DEPLOYMENT_ID_PREFIX));
  "
)}"

# What the suite's own deploy mode builds with (`--build-env NEXT_PRIVATE_TEST_MODE=e2e`): the config it
# writes turns this into `__NEXT_TEST_MODE`, which puts the hydration signal the browser waits for into
# the client. Without it every page the suite opens is waited on for ten seconds.
export NEXT_PRIVATE_TEST_MODE=e2e

# Everything below runs the application's own code — its install scripts, its build, its `post-build` —
# and none of it is ours. So it runs without this tool's configuration in the environment: the token
# that deploys the bundle has no business inside a fixture's `package.json` scripts, and a fixture that
# printed its environment would otherwise print it into the suite's log.
#
# This is a reduction, not a boundary: the deploy hook and the fixture's build run as the same user on
# the same machine, and a process can read what another process of its own user can. What it removes is
# the ordinary way a secret escapes — something dumping the environment it was handed.
fixture() {
  env -u ARKOR_API_URL -u ARKOR_API_TOKEN -u ARKOR_API_TOKEN_FILE -u ADAPTER_TEST_PROJECT_ID "$@"
}

# Deploy mode makes the isolated copy with `skipInstall: true` (`test/lib/next-modes/next-deploy.ts`),
# so the application arrives without its dependencies and installing them is this script's job.
fixture pnpm install --no-frozen-lockfile --prod=false >&2

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
fixture env PATH="$PWD/node_modules/.bin:$PATH" sh -c "$build_command" 2>&1 |
  tee .adapter-build-output.log >&2

# From the bundle rather than from `.next/BUILD_ID`: a fixture may set `distDir`, and then the build id
# is under that name instead — while the bundle is `.ppr-cdn/` whatever the fixture called its output.
# An empty marker here is worse than a missing one, since the harness reads the first match and would
# take the empty string as the build id.
bundle_says() {
  node -p "JSON.parse(require('fs').readFileSync('.ppr-cdn/bundle.json','utf8'))$1"
}
build_id="$(bundle_says '.buildId')"

# Whether this build has immutable assets, from the build rather than from a constant. The adapter asks
# Next.js for them unconditionally, and does not always get them: a Next.js below 16.3 does not offer
# `/_next/static/immutable/*` at all, and a static export has them turned off again by Next.js itself.
# What survives all of that is whether any file in the bundle is marked immutable — the adapter sets that
# from the build's own `immutableHash` (`collect.ts`). Saying `1` where the answer is no makes the suite
# apply expectations this deployment cannot meet, and read the difference as the adapter's fault.
#
# `staticFiles` is the right array to read: it is "`_next/static` from the build output, plus everything
# under `public/`" (`collectStaticFiles`), so a build with immutable assets has them in here. An
# application with no static file at all answers `0`, which is the truth about it — there are none to
# test.
immutable_assets="$(bundle_says '.staticFiles.some((file) => file.immutable) ? 1 : 0')"

{
  echo "BUILD_ID: ${build_id}"
  echo "DEPLOYMENT_ID: ${NEXT_DEPLOYMENT_ID}"
  # What the bundle says, not what was asked for: see above.
  echo "NEXT_SUPPORTS_IMMUTABLE_ASSETS: ${immutable_assets}"
  # The markers the harness parses come first; the build's own output follows them.
  cat .adapter-build-output.log
} >.adapter-build.log

# The deployment. Its own account of what it did is kept for the logs hook; the URL it prints is this
# script's only standard output.
url="$(node "${tool_dir}/src/main.ts" deploy 2>>.adapter-server.log)"
printf '%s\n' "$url"
