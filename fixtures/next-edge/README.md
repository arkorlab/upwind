# `fixtures/next-edge`

The edge runtime, which needs a fixture of its own: Next.js refuses the `runtime` route segment
config in a build with `cacheComponents` on, so the route below and the Cache Components coverage
in `fixtures/next-minimal` cannot be the same application.

Both entrypoints here — a route with `export const runtime = 'edge'` and the deprecated
`middleware.js` — are chunks that register a Web handler in `globalThis._ENTRIES`, which the
adapter puts in a second bundle (`edge.cjs`) with `process.env.NEXT_RUNTIME` pinned to `"edge"`.
Each imports the same `.wasm`, the shape Next.js's own `test/e2e/edge-can-use-wasm-files` has.

There is no `instrumentation.js` here, and that is the point of its absence: it is the other branch
of the `instrumentation` patch, which resolves the hook's computed `require` to an empty module
when a build has no hook to resolve it to.

The `next` version in `package.json` is not a declaration of anything. `tools/next-matrix`
overwrites it for every build it runs; it is there so that an `npm install` in this directory,
for looking at something by hand, gets a version that works.
