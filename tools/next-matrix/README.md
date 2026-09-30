# `@upwind-tools/next-matrix`

Builds `fixtures/next-minimal` and `fixtures/next-edge` with each Next.js it is given, and holds
each build to what the adapter promises: the bundle parses against `deploymentBundleSchema`, every
patch the fixture was written to reach appears in `.arkor/dependencies.json`, and the outputs
that fixture exists to produce are there.

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

- the four patches that rewrite what `next build` **writes** rather than what Next.js ships —
  `turbopack-runtime`, `vercel-og`, and the two that are the Turbopack WebAssembly loader in the
  two shapes a supported version can hold it (`wasm-loader` from 16.3, `runtime-wasm-loader` in
  16.2). No reading of a tarball produces a Turbopack runtime.
- that a patch still finds its file **in a bundle**. A rewrite can apply perfectly to a module no
  build ever loads, which is what the `instrumentation` patch's target did until this was written:
  it claimed Next.js's ESM copy too, and no Function has ever bundled that.
