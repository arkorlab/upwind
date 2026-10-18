# `@upwind-tools/next-matrix`

Builds `fixtures/next-minimal`, `fixtures/next-edge`, `fixtures/next-workflow`,
`fixtures/next-external-output` and the two instrumentation fixtures with each Next.js
it is given, and holds each build to what the adapter promises: the bundle parses against
`deploymentBundleSchema`, every patch the fixture was written to reach appears in
`.arkor/dependencies.json`, and the outputs that fixture exists to produce are there.

The external-output fixture also starts the built Function in Miniflare and requests its dynamic
App Router page. Its client component requires the carried client-reference manifest, so this
checks the lazy entry, bundled code and VFS mount together. Pull-request CI runs this one fixture
with the installed Next.js version; the full version matrix remains separate.

The instrumentation fixtures compile Edge middleware, an Edge route and a Node route with host
hooks, both with and without the project's own hook. Miniflare verifies awaited, once-only
registration, host-first error hooks, preserved arguments and receivers, isolated host failures,
and zero outbound requests. The own hook value-imports `next/server` to exercise early Edge
globals, while a conditional-export package verifies that added host imports use the Edge
target. CI builds both fixtures with the installed Next.js version and retains each completed
or failed case as JSON under `UPWIND_MATRIX_PROOF_DIR`.

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
