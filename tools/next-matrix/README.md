# `@upwind-tools/next-matrix`

Builds `fixtures/next-minimal`, `fixtures/next-edge`, `fixtures/next-workflow`,
`fixtures/next-external-output`, `fixtures/next-use-cache-concurrency` and the instrumentation
fixtures with each Next.js it is given, and holds each build to what the adapter promises: the
bundle parses against `deploymentBundleSchema`, every patch the fixture was written to reach
appears in `.arkor/dependencies.json`, and the outputs that fixture exists to produce are there.

The external-output fixture also starts the built Function in Miniflare and requests its dynamic
App Router page. Its client component requires the carried client-reference manifest, so this
checks the lazy entry, bundled code and VFS mount together. Pull-request CI runs this one fixture
with the installed Next.js version; the full version matrix remains separate.

The instrumentation fixtures compile Edge middleware, an Edge route and a Node route with host
hooks, both with and without the project's own hook. Miniflare verifies awaited, once-only
registration, host-first error hooks, preserved arguments and receivers, isolated host failures,
and zero outbound requests. The own hook value-imports `next/server` to exercise early Edge
globals, while a conditional-export package verifies that added host imports use the Edge
target. CI builds these fixtures with the installed Next.js version and retains each completed
or failed case as JSON under `UPWIND_MATRIX_PROOF_DIR`.
Error-hook composition is checked where Next.js dispatches it: middleware and the Node route.
The Edge route retains Next.js 16.4.2's thrown-handler result, HTTP 500 without either error hook,
while still proving registration composition.
The separate baseline fixture builds the same sources with only Node host configuration and no
Edge opt-in. Its Edge route must show the same HTTP 500/no-error-hook result, with only the
project's registration. CI requires all 30 opt-in cases and this independent baseline case.

The `"use cache"` concurrency fixture is built with a cache host of its own, and its app Function is
started in Miniflare with a binding that host tells of every read through, naming the request the
read is for; a read goes on only once the matrix answers. One request fills a cached entry. Then
reads are held: a first request is sent, and once its read has begun a second, whose own read of the
same key has to begin while the first's is still held. Only then are both let go on, and both have
to be answered from the entry. From 16.3 Next.js has the second join the first's read instead and
tee a body of the first request, which workerd refuses — the `use-cache-cross-request` patch is what
keeps the two apart, and without it the second reads nothing of its own and is answered 500. No
step waits on a delay: a run that cannot show the two reads overlapping fails, and every wait is
bounded, so a broken one says what it was waiting for.

```console
$ pnpm --filter @stayingupwind/adapter build     # the matrix builds against dist, as a user would
$ pnpm check:matrix --versions 16.3.0,latest,canary
```

`--versions` takes release numbers and registry tags (`latest`, `canary`, `beta`, `rc`) in any
mixture; it defaults to `latest,canary`. `--fixture <name>` builds one of them. `--keep` leaves the
temporary application in place and prints where, for when a failure needs looking at rather than
reading about.

Each version gets a copy of the fixture in a directory of its own, with `npm` rather than `pnpm`:
the fixtures are deliberately not workspace packages, since a workspace package would be pinned to
the catalog's single Next.js — the one thing the matrix exists to look past.

## What this catches that `check-patches` does not

`packages/adapter/scripts/check-patches.ts` applies every rewrite to the files of a published
package, which is far cheaper and covers most of the same ground. Two things are only reachable
from a real build:

- the six patches that rewrite what `next build` **writes** rather than what Next.js ships —
  `turbopack-runtime`, `turbopack-root`, `vercel-og`, the two that are the Turbopack WebAssembly
  loader in the two shapes a supported version can hold it (`wasm-loader` from 16.3,
  `runtime-wasm-loader` in 16.2), and `workflow-quickjs-wasm`, which reaches the chunk the
  Workflow SDK's engine embeds its WebAssembly in. No reading of a tarball produces a Turbopack
  runtime.
- that a patch still finds its file **in a bundle**. A rewrite can apply perfectly to a module no
  build ever loads, which is what the `instrumentation` patch's target did until this was written:
  it claimed Next.js's ESM copy too, and no Function has ever bundled that.
