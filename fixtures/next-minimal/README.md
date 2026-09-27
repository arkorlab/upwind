# `fixtures/next-minimal`

An application on the Node.js runtime, built by `tools/next-matrix` against every Next.js in
`SUPPORTED_NEXT_RANGE`. It is not a demonstration of anything: every file here exists because a
patch under `packages/adapter/src/patches/` needs the module it pulls into the build graph, and a
patch with nothing to rewrite is a patch nobody is checking.

What each file is for:

| File                             | The patch it reaches                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| any App Router page              | `turbopack-runtime` (the chunk loader), `graph-manifests`, `load-manifest`                              |
| `instrumentation.js`             | `instrumentation` (the computed `require` of the hook)                                                  |
| `proxy.js`                       | the middleware on the Node.js runtime: a second Function, bundled from the same graph                   |
| `next.config.mjs` (`cacheComponents`) | `task-timers`, `resume-cache-limit`, `cache-signal-timers`                                         |
| `app/blog/[slug]/page.js`        | `hanging-input-abort`: a `"use cache"` function handed promises made from `params`                      |
| `app/api/cached-fetch/route.js`  | `fetch-cache-wait-until`: `patch-fetch`, and a `fetch` with a `revalidate`                              |
| `app/api/dynamic-import/route.js` | `cache-signal-timers`: a route handler loading an async module on demand                               |
| `app/api/og/route.js`            | `vercel-og` and `vercel-og-font`: through `next/og`, Turbopack compiles the module into a chunk and keeps its import of the library external |
| `app/api/og-aliased/route.js`    | `vercel-og-image-response`: through `@vercel/og`, which `next build` aliases to a module Turbopack keeps external instead, so the Function bundles the file itself |
| `app/api/wasm/route.js`          | `wasm-loader`, in both forms Turbopack compiles: `?module` compiles, the plain import instantiates      |
| `pages/hello.js`, `pages/ssr.js` | the Pages Router's two data paths: `getStaticProps` gives a `_next/data` prerender, `getServerSideProps` an entrypoint |
| `pages/api/ping.js`              | the Pages Router body parser, which reaches `next/dist/compiled/raw-body`                               |

Nothing here is executed at build time beyond what `next build` prerenders: every route that would
reach the network takes `connection()` first, so the matrix needs no network of its own once the
packages are installed.

The `next` version in `package.json` is not a declaration of anything. `tools/next-matrix`
overwrites it for every build it runs; it is there so that an `npm install` in this directory,
for looking at something by hand, gets a version that works.
