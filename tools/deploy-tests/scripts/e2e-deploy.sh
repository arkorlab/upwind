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
#
# Corepack is told not to refuse: the workflow enables it, and in strict mode it refuses to run pnpm in
# an application whose `packageManager` names another — a fixture may pin npm, and the harness still
# appends `pnpm post-build` to its build. pnpm, started by Corepack, then leaves the pin alone too.
fixture() {
  env -u ARKOR_API_URL -u ARKOR_API_TOKEN -u ARKOR_API_TOKEN_FILE -u ADAPTER_TEST_PROJECT_ID \
    -u ADAPTER_TEST_SETTLE_SECONDS COREPACK_ENABLE_STRICT=0 "$@"
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

# The suites of a `next.config.ts` that Node.js loads itself are built the way Next.js's own CI builds
# them, and only they are: with that loader turned on and type transformation allowed
# (`.github/workflows/build_and_test.yml` sets `__NEXT_NODE_NATIVE_TS_LOADER_ENABLED=true` and
# `NODE_OPTIONS=--experimental-transform-types` for those directories alone). Their configs await at
# the top level on purpose — "this is to ensure that the test is running in Native TS mode" — which
# the loader every other build uses refuses, and the suites skip themselves only on a Node.js without
# TypeScript of its own. Which suite this is, `run-tests.js` names in `JEST_SUITE_NAME`.
case "${JEST_SUITE_NAME:-}" in
  *test/e2e/app-dir/next-config-ts-native-ts/* | *test/e2e/app-dir/next-config-ts-native-mts/*)
    export __NEXT_NODE_NATIVE_TS_LOADER_ENABLED=true
    export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--experimental-transform-types"
    echo 'a suite of a next.config Node.js loads itself: built with that loader, as Next.js builds it' >&2
    ;;
esac

# What the build says is what `next.cliOutput` is read from, so it has to be kept and not only shown:
# `tee` writes it for the logs hook, and standard output stays reserved for the URL.
fixture env PATH="$PWD/node_modules/.bin:$PATH" sh -c "$build_command" 2>&1 |
  tee .adapter-build-output.log >&2

# From the bundle rather than from `.next/BUILD_ID`: a fixture may set `distDir`, and then the build id
# is under that name instead — while the bundle is `.arkor/` whatever the fixture called its output.
# An empty marker here is worse than a missing one, since the harness reads the first match and would
# take the empty string as the build id.
bundle_says() {
  node -p "JSON.parse(require('fs').readFileSync('.arkor/bundle.json','utf8'))$1"
}
build_id="$(bundle_says '.buildId')"

# Whether this build has immutable assets, from the build rather than from a constant. The adapter asks
# Next.js for them unconditionally and does not always get them: `config.supportsImmutableAssets` is
# ignored by 16.2, and a static export has the option turned off again by Next.js itself after the hook
# has run. Saying `1` where the answer is no makes the suite hold a deployment to expectations it cannot
# meet, and read the difference as the adapter's fault.
#
# What is asked is whether any file went out under the content-addressed path, because that is the thing
# a deployment does without: the adapter's README says of 16.2 "ignored by 16.2, so no
# `/_next/static/immutable/*`. `immutableHash` is there already, so `immutable` itself still holds" — so
# the bundle's `immutable` flag is true on a 16.2 build as well and answers a different question (may
# this file be cached forever), while the path answers this one (is it shared across deployments).
#
# `staticFiles` is the right array to look in: it is "`_next/static` from the build output, plus
# everything under `public/`" (`collectStaticFiles`). An application with no such file answers `0`,
# which is the truth about it — there are none to test.
#
# Both the flag and the path, because neither alone is the question. The flag without the path is a 16.2
# build, which marks files immutable and writes none of them under that path. The path without the flag
# is somebody's `public/` directory: a file at `public/docs/_next/static/immutable/logo.js` is served
# under a pathname that reads like the content-addressed one, and `collectStaticFiles` gives every
# `public/` file `immutable: false`, while a real one takes it from `output.immutableHash` (`collect.ts`).
immutable_assets="$(
  bundle_says "
    .staticFiles.some(
      (file) => file.immutable && file.pathname.includes('/_next/static/immutable/'),
    )
      ? 1
      : 0
  "
)"

{
  echo "BUILD_ID: ${build_id}"
  echo "DEPLOYMENT_ID: ${NEXT_DEPLOYMENT_ID}"
  # What the bundle says, not what was asked for: see above.
  echo "NEXT_SUPPORTS_IMMUTABLE_ASSETS: ${immutable_assets}"
  # The markers the harness parses come first; the build's own output follows them.
  cat .adapter-build-output.log
} >.adapter-build.log

# The deployment. The URL it prints is this script's only standard output; its account of what it did
# goes to standard error as it happens, and into a file for the logs hook as well — the arrangement the
# build's output has above, for the same reason.
#
# Standard error is the channel that reaches the suite's log when a fixture fails. The harness quotes
# this script's standard output in its error, which is the URL's alone and so empty on a failure, and the
# logs hook is not called when setup itself failed. Kept only in the file, the account never arrived: a
# full run of the manifest reported every failed deployment as `Custom deploy script failed:  undefined
# (1)`, with the reason sitting in a file nothing printed.
#
# A pipeline rather than `2> >(tee …)`: the shell waits for every part of a pipeline, and not for a
# process substitution, so the last lines — the reason, when it failed — could be lost between the tool
# exiting and `tee` writing them out. The descriptors are swapped so that standard error is what goes
# through `tee` and standard output, on 3, is what the command substitution reads; `pipefail` keeps the
# tool's exit status as the pipeline's, so a failed deployment still fails this script.
url="$(
  { node "${tool_dir}/src/main.ts" deploy 2>&1 1>&3 | tee -a .adapter-server.log >&2; } 3>&1
)"
printf '%s\n' "$url"
