# @upwind/adapter

`next build` calls this adapter with a description of the application, and it writes a deployment
bundle under `<projectDir>/.ppr-cdn/` — `bundle.json`, the blobs it names, and the two Workers
(`app`, `middleware`) that run the application's code under `@upwind/runtime`. Nothing here talks
to Cloudflare: a build needs no credentials, and uploading the bundle is the host's job.

Name the adapter in `next.config`:

```ts
import { createRequire } from 'node:module';

export default {
  adapterPath: createRequire(import.meta.url).resolve('@upwind/adapter'),
};
```

or by environment, which is how a host builds an application without touching its config:

```bash
NEXT_ADAPTER_PATH=$(node -e "console.log(require.resolve('@upwind/adapter'))") next build
```

The adapter uses the stable [Next.js Adapter API](https://nextjs.org/docs/app/api-reference/adapters)
(`modifyConfig`, `onBuildComplete`), whose shape changes only in a major release. This file is
the record of what it reads from that API, what it makes of it, and where it reaches past the
API into Next.js's own output. The tests under `test/` hold each row to its word.

## What the adapter reads

From `onBuildComplete`'s context, and where each thing ends up. "Recorded" means the field is
carried into the bundle and nothing reads it yet — it is there so a later reader has it, and so
a diff of two bundles shows a change in it. A field that is neither read nor recorded is not in
the bundle at all, so no consumer can come to depend on it by accident.

| Context field                                                                                                                                    | Bundle field                                                                                                                       | Read by                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `nextVersion`, `buildId`                                                                                                                         | `nextVersion`, `buildId`                                                                                                           | control (deployment summary); runtime (`buildId` on a resume)                                                                                |
| `projectDir`, `repoRoot`                                                                                                                         | `projectDir` (relative)                                                                                                            | recorded                                                                                                                                     |
| `distDir`                                                                                                                                        | —                                                                                                                                  | the adapter itself: manifests, chunks, the instrumentation hook, `images-manifest.json`                                                      |
| `config.output`                                                                                                                                  | —                                                                                                                                  | the adapter itself: `'export'` is a build with no server, bundled as described below                                                         |
| `config.basePath`, `trailingSlash`, `skipTrailingSlashRedirect`, `skipProxyUrlNormalize`, `poweredByHeader`, `i18n`                              | `config.*`                                                                                                                         | runtime (`basePath`, `i18n` for routing); control (`basePath` and `i18n` decide whether a dynamic shell is served from the edge)             |
| `config.images`, as `<distDir>/images-manifest.json` has it (source patterns compiled to regular expressions), when the default loader is in use | `config.images`                                                                                                                    | edge (what `/_next/image` enforces); control (carried to the manifest); runtime (the source, when the edge has nothing to serve)             |
| `routing.*` (every phase, `shouldNormalizeNextData`, `rsc`)                                                                                      | `routing.*`, verbatim                                                                                                              | runtime (`@next/routing`, RSC headers); control (dynamic route matchers, reserved routes, header rules)                                      |
| `outputs.appPages`, `appRoutes`, `pages`, `pagesApi`: `pathname`, `filePath`, `assets`, `runtime`                                                | `entrypoints[]` (`id`, `kind`, `pathname`, `runtime` when it is `'edge'`); the module and its traced chunks go into the app Worker | runtime (which module answers a route); control (an edge route's shell is not served from the edge, and the cache holds no generation of it) |
| `outputs.appPages`, `appRoutes`, `pages`, `pagesApi`: `sourcePage`                                                                               | `sourcePages[]` (`id`, `sourcePage`), verbatim; left out of the Worker's runtime manifest                                          | the inspector (the application's own folders: a pathname keeps no route group or parallel slot)                                              |
| `outputs.*[].edgeRuntime` (`modulePath`, `entryKey`, `handlerExport`), `assets`, `config.env`, for an output on the edge runtime                 | —                                                                                                                                  | the adapter itself: the Worker's edge bundle is built from them (see below)                                                                  |
| `outputs.*[].wasmAssets`, for an output on the edge runtime                                                                                      | —                                                                                                                                  | the adapter itself: each module travels as a `CompiledWasm` module of the Worker, published under the global its key names                   |
| a `.wasm` among `outputs.*[].assets`, for an output on the Node.js runtime                                                                       | —                                                                                                                                  | the adapter itself: Next.js says nothing about it, so it is looked for; the `wasm-loader` patch reads it from the Worker                     |
| `outputs.middleware`: `filePath`, `assets`, `runtime`, `config.matchers`                                                                         | `middleware.matchers[]`; the module goes into both Workers                                                                         | edge (when to run the middleware); runtime. On the edge runtime (`middleware.ts`) it goes into both Workers' edge bundles instead            |
| `outputs.prerenders[]`: `id`, `pathname`, `route`, `routeType`, `response`, `compute`                                                            | same names                                                                                                                         | runtime (which shell answers a route); control (which prerenders the edge may serve)                                                         |
| `outputs.prerenders[].fallback.filePath`, `postponedState`                                                                                       | `body`, `postponed` (blobs)                                                                                                        | runtime and control (shell and resume)                                                                                                       |
| `outputs.prerenders[].fallback.initialStatus`, `initialHeaders`                                                                                  | same names                                                                                                                         | runtime and control (the shell's status and headers)                                                                                         |
| `outputs.prerenders[].parentOutputId`, `groupId`, `htmlSize`, `pprChain`, `config.renderingMode`, `allowQuery`, `bypassFor`, `partialFallback`   | same names                                                                                                                         | recorded                                                                                                                                     |
| `outputs.prerenders[].parentFallbackMode`                                                                                                        | same name                                                                                                                          | runtime (a member of a `fallback: false` route is resolved by its own name, since its dynamic matcher fires only for a draft)                |
| `outputs.prerenders[].fallback.initialRevalidate`, `initialExpiration`; `config.allowHeader`                                                     | same names                                                                                                                         | the host (the lifetime it seeds a build's generation with); runtime (the headers a regeneration may see)                                     |
| `outputs.prerenders[].config.bypassToken`                                                                                                        | `bypassToken`, once for the build                                                                                                  | runtime (a request whose `__prerender_bypass` carries it is in draft mode, and is rendered rather than answered from the build or the cache) |
| `config.cacheComponents`, `partialPrefetching`, `expireTime`, `cacheLife` (as resolved)                                                          | `config.*`                                                                                                                         | recorded (what a runtime lifetime by name means); the inspector shows them                                                                   |
| `config.cacheHandler`, `cacheHandlers`                                                                                                           | —                                                                                                                                  | a build that names one **fails**: the Worker cannot load a module by path, and the platform supplies the handlers itself                     |
| `outputs.staticFiles[]`: `pathname`, `filePath`, `immutableHash`                                                                                 | `staticFiles[]` (`pathname`, `blob`, `immutable`); the one named `/index` is offered under `/` too                                 | edge and control (served from storage); runtime (the small ones the Worker carries)                                                          |
| `public/` (from `projectDir`)                                                                                                                    | `staticFiles[]`, URL-encoded pathnames under the `basePath`                                                                        | as above; not walked for a static export, whose `out/` already holds it                                                                      |

Both routers are built the same way. What the Pages Router adds is `_next/data`: `next build`
emits a data output per page whose props come from `getServerSideProps` (an entrypoint of its
own, named `/_next/data/<buildId>/…json`) or from `getStaticProps` (a prerender under the same
name), and the runtime serves those from the name the client asks for. Its home page is the one
output whose name is not its URL — `normalizePagePath` spells it `/index` — so the file is
offered under the application's root as well.

`modifyConfig` sets `supportsImmutableAssets` (content-addressed `/_next/static/immutable/*`).
Next.js turns it off again for a static export, in `finalizeConfig`, after the hook has run.
`next/image` is left as the application configured it: the edge optimizes `/_next/image`.

## What the project declares beside `next.config`

One thing the Adapter API has no notion of is a schedule, so the adapter reads it from a file of
the project's own (`src/project-config.ts`). Four names are looked for directly under
`projectDir` — `upwind.config.ts`, `upwind.jsonc`, `upwind.json`, `vercel.json` — and
**the first that exists is the whole of the configuration**; they are not merged, because merging
means deciding which file wins a key neither meant to share.

| Read          | Bundle field | Held to                                                                                                  |
| ------------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| `crons[]`     | `crons`      | Vercel's dialect, at build time: a path, and a five-field UTC expression (`@upwind/core/cron`)           |
| anything else | —            | ignored, so a `vercel.json` full of Vercel's own deployment configuration is not read twice, differently |

An `upwind.config.ts` is evaluated by Node itself — type stripping, no build step, erasable syntax
only — and may export a function, so what a project declares can be computed. A file that will not
parse, a key whose shape is wrong, or a schedule that cannot be run fails the build with the file
named: the alternative is a deployment whose jobs quietly never fire.

## A static export

With `output: 'export'`, `next build` writes `out/` and then hands the adapter that directory and
nothing else: `outputs.staticFiles` alone is populated, and `pages`, `appPages`, `pagesApi`,
`appRoutes`, `prerenders` and `middleware` are all empty (Next.js, "Output Types"). The bundle is
the same one, with the server parts empty, and three things are decided here.

**Where each file is served.** Next.js hands an exported file's path from `out/` with `.html` taken
off, so the root arrives as `/index` — a name no visitor types. What a visitor types is decided by
which file the build chose to write, and `trailingSlash` is what settles that. The root document is
`out/index.html` either way and is the site's root (`/`, or the spelling a `basePath` redirects the
other to). With `trailingSlash`, a page is its directory's index (`out/about/index.html` → `/about/`);
without it, a page sits beside its siblings (`out/about.html` → `/about`) and a nested
`index.html` is then not a directory index at all but a route whose own last segment is `index`
(`app/blog/index/page.tsx` → `out/blog/index.html` → `/blog/index`), which is kept as it is.
Everything that is not HTML — `_next/static`, the RSC payloads the client router fetches, `public/`
files — keeps the name it has.

**Which files may be cached forever.** A static export gets no `immutableHash`, so instead the rule
the build emits for its own `_next/static` (in `routing.onMatch`, naming the directories whose file
names carry a content hash or the build id) decides. Read as the edge reads a `cache-control`
(`isImmutableCacheControl`): the whole policy has to be long-lived, public and unwithheld, and
only a rule that holds for every request — the last unconditional one to set the header — can make
a file `immutable` at all. Without this every hashed chunk would go out `must-revalidate`.

**What the Worker is.** It is still built, and it runs none of the application's code: no entry, no
Turbopack runtime to patch, no build manifest for one to read. It carries the error documents and
the routing tables, and the edge sends it only what is not a file — a miss, a redirect from
`next.config`, the trailing-slash normalization — which `@next/routing` answers as Next.js's own
router would. Every document is the edge's, from storage; which is also why a rewrite is not
followed, its destination being a file the Worker does not carry (`output: 'export'` does not
support rewrites under Next.js either).

## What the adapter reaches into

Beyond the API, the Worker build depends on these files of Next.js's output and package. Each
dependency is one module under `src/patches/`, checked against the installed Next.js by
`test/patches.test.ts`, and recorded per build in `.ppr-cdn/dependencies.json`.

| Where                                                                                                                                                  | What                                                                                                                                                                                                                                                                                                                                                                                                       | Why, and what guards it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.next/server/chunks/[turbopack]_runtime.js`, `.next/server/chunks/ssr/[turbopack]_runtime.js`                                                         | the two `require(path.resolve(RUNTIME_ROOT, chunkPath))` sites become a static table (`turbopack-runtime` patch)                                                                                                                                                                                                                                                                                           | workerd resolves only the names in the bundle; a table is what esbuild can follow. Exactly two sites per file, or the build fails. Only Turbopack builds are accepted                                                                                                                                                                                                                                                                                                                                                                                               |
| `next/dist/server/lib/router-utils/instrumentation-globals.external.js`                                                                                | the computed `require` of the hook becomes the hook's file, or an empty module when the app has none (`instrumentation` patch)                                                                                                                                                                                                                                                                             | one site, or the build fails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `next/dist/server/load-manifest.external.js`                                                                                                           | `readFileSync(path)` + `vm.runInNewContext` become a JSON read (`load-manifest` patch); the JSON is what `evaluateManifestScript` produced at build time with the same `vm` evaluation Next.js would run, in a context holding `process.env.NEXT_DEPLOYMENT_ID` = the bundle's deployment id                                                                                                               | four sites, no `vm` left, or the build fails. `test/manifests.test.ts` compares every manifest of every built app with Next.js's own `evalManifest`. A missing manifest still surfaces as Next.js's own invariant ("The manifests singleton was not initialized"), since Next.js swallows the read's failure                                                                                                                                                                                                                                                        |
| the server chunk Turbopack put its WebAssembly loader in                                                                                               | `compileModule` and `instantiate` become reads of the module the Worker carries, keyed by the `.wasm` path relative to `distDir` (`wasm-loader` patch)                                                                                                                                                                                                                                                     | Turbopack's loader reads the file off disk with `createReadStream` and compiles it with `WebAssembly.compileStreaming`: a Worker has no file, and would pay the compile in every isolate. Only the registration is rewritten — the read itself is a named declaration or an inlined expression depending on how many ways the build imports a `.wasm`, and what is left of it is unreferenced. The chunk has no fixed name, so the patch is found by the two marks the module carries together, and the build asserts it fired when an entrypoint named WebAssembly |
| `next/dist/server/app-render/cache-signal.js`, and the copy inside each `next/dist/compiled/next-server/*.runtime.prod.js`                             | the signal arms its pending task through a generation guard, so cancelling it does not depend on the timer being cleared (`cache-signal-timers` patch)                                                                                                                                                                                                                                                     | under `cacheComponents` every dynamic `import()` is tracked on one signal per isolate, and a timer it scheduled in one request cannot be cleared from another ("Cannot perform I/O on behalf of a different request") — measured, and refused the same way whether or not that request has ended, so a timer that fires anyway would wake the listeners a round of the event loop early. With the guard the clear is only an optimization                                                                                                                           |
| `next/dist/compiled/@vercel/og`                                                                                                                        | Turbopack's `externalImport` of `index.node.js` becomes an `import()` of `index.edge.js` — dynamic, so the library is evaluated by the first request that renders an image and not at the Worker's start (`vercel-og` patch), and that build's fallback-font `fetch` a read of the font the Worker carries (`vercel-og-font` patch); its `./resvg.wasm?module` imports resolve to the Worker's own modules | the Node.js build is external — a module no bundler can follow and the Worker does not have — and reads its font and `resvg.wasm` off disk before compiling the WebAssembly in every isolate. The edge build is the same library written for a runtime with neither, so `next/og` answers with an image instead of a 500                                                                                                                                                                                                                                            |
| `next/dist/compiled/next-server/app-page*.runtime.prod.js`                                                                                             | the one `setTimeout` a prerender's task group is scheduled with becomes the runtime's task scheduler, `setTimeout` staying as the fallback (`task-timers` patch); the warning that Cache Components "cannot be guaranteed" is silenced                                                                                                                                                                     | a prerender with `cacheComponents` is a sequence of `setTimeout(…, 0)` tasks between which React's `setImmediate` work is drained by Next.js's patch of `setImmediate` and `process.nextTick`; workerd fires the timers first and has no `nextTick` queue, so the render was aborted empty and hung when decoded. `packages/runtime/src/tasks.ts` runs each task once the immediates before it have run. One timer and one warning, or the build fails                                                                                                              |
| `cloudflare:node` (`handleAsNodeRequest`)                                                                                                              | not a patch: the runtime hands each entrypoint the `IncomingMessage` and `ServerResponse` of a real `node:http` server workerd runs, as every official adapter does from Node's own                                                                                                                                                                                                                        | needs workerd 1.20260917.1 or later: before it, the response emitted `close` when the request body ended, which Next.js's response pipe takes for a client that went away (see EXPERIMENTS.md, V-01)                                                                                                                                                                                                                                                                                                                                                                |
| `require-in-the-middle`, `import-in-the-middle`                                                                                                        | resolved to an empty module                                                                                                                                                                                                                                                                                                                                                                                | Node module-loader hooks (OpenTelemetry) with no loader to hook                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| the Turbopack runtime's `externalImport(id)`, the server runtime's `import(e)` (`next/dist/compiled/next-server/*.runtime.prod.js`)                    | not a patch: left as they are, an `import()` of a module named at run time, and recorded                                                                                                                                                                                                                                                                                                                   | the loads Next.js makes with something other than one module's name, known to be reached only where they work (a Node built-in); a `require` or `import()` like it anywhere else fails the build                                                                                                                                                                                                                                                                                                                                                                    |
| `critters`                                                                                                                                             | resolved to a module whose constructor throws                                                                                                                                                                                                                                                                                                                                                              | required by the Pages Router runtime for `experimental.optimizeCss`, which reads built stylesheets off disk; an app that turns it on fails its first render in so many words rather than the bundle                                                                                                                                                                                                                                                                                                                                                                 |
| `next/dist/compiled/raw-body`                                                                                                                          | resolved to the adapter's own copy (`patches/raw-body.ts`)                                                                                                                                                                                                                                                                                                                                                 | the compiled module bundles `depd`, which builds a function from a string; workerd refuses that at load, and the Pages Router's API body parser answered every request `400 Invalid body`                                                                                                                                                                                                                                                                                                                                                                           |
| the `AsyncLocalStorage` banner                                                                                                                         | `globalThis.AsyncLocalStorage ??= require('node:async_hooks').AsyncLocalStorage` is the first line of `app.cjs`, and of `edge.cjs`                                                                                                                                                                                                                                                                         | Next.js's storages read the global once, at module evaluation, and settle for a fake without it; a bundle without the banner fails every render (`test/node/broken-bundles.test.ts` in the runtime)                                                                                                                                                                                                                                                                                                                                                                 |
| `.next/server/edge/chunks/**`, the chunks of an entrypoint on the edge runtime                                                                         | evaluated, in the order `assets` lists them, by the thunk in `edge.cjs` that the route's first request calls; the handler is then read from `globalThis._ENTRIES[entryKey]`                                                                                                                                                                                                                                | the documented way to invoke one (Adapters, "Invoking Entrypoints"). Their chunk loader reads no file at run time (`loadChunkCached` throws), so evaluating the chunks is the whole of loading an entry; their Turbopack runtime's `import()`, `require.resolve` and kept loader are recorded and allowed                                                                                                                                                                                                                                                           |
| Node built-ins                                                                                                                                         | `node:*` and the bare names are left to workerd; a built-in outside the list in `dependencies.ts` fails the build                                                                                                                                                                                                                                                                                          | under `nodejs_compat` every built-in import resolves (the unimplemented ones as stubs that throw when used), so the list is what is known to be reached only where it works                                                                                                                                                                                                                                                                                                                                                                                         |
| `*.json` under `.next/` and `.next/server/`, `BUILD_ID`, each route's `react-loadable-manifest.json` and `*_client-reference-manifest.js` (as `.json`) | shipped as text modules under their `.next/...` names; the runtime mounts them at `/bundle/...`                                                                                                                                                                                                                                                                                                            | excluded rather than listed (`*.nft.json` are the only files known to be of no use): a manifest Next.js reads without a fallback that a list left out fails every route                                                                                                                                                                                                                                                                                                                                                                                             |

The app module (`app.cjs`) is bundled by Rolldown, as one CommonJS module with the patches
applied as each file is loaded — 5% smaller than esbuild made it from the same graph, and built
sooner (see EXPERIMENTS.md, V-03); the runtime module (`index.mjs`) by esbuild, for its `workerd`
conditions; the edge bundle (`edge.cjs`), where a build produced one, by Rolldown as well.
`.ppr-cdn/dependencies.json` records, per Worker — and under `edge`, for its edge bundle — the
files bundled from the build output and from each package (with the bytes each puts in the
bundle), the built-ins left external, the stubs, the patches applied with their edit counts,
every use of the loader the bundler could not follow — a `require` or `import()` made with
something other than one module's name, a method of the loader called or kept (`require.resolve`,
`require.call`, `require.bind`), the loader kept under another name for a call the record cannot
see — shown as the assignment that keeps it, or as the whole statement where it is part of none,
a minified module being one comma expression per statement — a module object's own loader
(`module.require`, which the object a module gets in the bundle does not have) — found in each
module as Rolldown rendered it into the bundle, once it had followed what it could, so a binding
a module itself calls `require`, which Rolldown renames, is not taken for the loader, and a call
in code the bundle left out is not reported — the `.wasm` the bundler resolved itself, each with
the global the Worker publishes it under — and the Worker's modules, with what they weigh
together before and after gzip. The audit (`auditWorker`), which each of a Worker's bundles goes
through, fails the build on a `require("vm")` or `runInNewContext` that survived, a built-in
outside the list, a module the bundler could not resolve, or a use of the loader outside
Next.js's own; `auditWorkerSize` fails it on a Worker over Cloudflare's 10 MiB gzipped, so that
the build says so rather than the upload.

## The edge runtime

A route with `export const runtime = 'edge'`, and the deprecated `middleware.ts`, are not modules
the Worker can require: Turbopack builds them into chunks that register a Web handler in
`globalThis._ENTRIES` as they are evaluated. They go into a second bundle, `edge.cjs`, built like
`app.cjs` but with `process.env.NEXT_RUNTIME` pinned to `"edge"` — the test that code branches on,
and the reason the two cannot share a bundle. `edge.cjs` is a table of thunks, as `app.cjs` is, so
a Worker loads at startup only the table and evaluates an entry's chunks on the first request that
needs it; a deployment with no such entrypoint has no `edge.cjs` at all, and its Worker is byte
for byte what it was before.

Three consequences, all from Next.js's own templates:

- An edge entrypoint renders with `postponed: undefined` (`build/templates/edge-ssr-app.ts`), so
  it can never resume a shell. The bundle marks the route `runtime: 'edge'`, `edgeServablePrerenders`
  leaves its prerenders to the Worker, and the runtime refuses a resume asked of one. A prerender
  that is complete at build time is still served from the build, as any route's is.
- Both edge templates render with `supportsDynamicResponse: true`, which makes
  `isStaticGeneration` false (`server/async-storage/work-store.js`): no response cache runs, so
  there is no cache entry to capture, no `cacheControl` reported, and no prerender emitted to
  seed. The runtime cache therefore holds no generation of such a route, and a `revalidate` of
  the route segment is read by nobody — as Next.js documents ("The Edge Runtime does not support
  Incremental Static Regeneration"). What its `revalidate` does still reach is the data cache:
  the incremental cache the edge adapter builds picks the platform's `FetchCache` off
  `Symbol.for('@next/cache-handlers')`, so a cached `fetch` of an edge route is the deployment's
  like any other. The runtime has to let both bundles patch the global `fetch` for that to hold
  (`packages/runtime/src/cache/fetch-patch.ts`).
- Next.js refuses the `runtime` route segment config in a build with `cacheComponents` on ("Route
  segment config \"runtime\" is not compatible with `nextConfig.cacheComponents`"), so an app
  cannot have both an edge route and the shells this platform serves from the edge. That is why
  the edge runtime has a fixture of its own, `fixtures/next-edge`, rather than a page in
  `fixtures/next-minimal`.

The middleware is the same handler either way: `proxy.ts` and `middleware.ts` come from one
template (`build/templates/middleware.ts`) and both export `handler(request, ctx)`. Only where its
code lives differs.

## WebAssembly

A Worker carries each `.wasm` as a module of its own, `wasm/<sha256>.wasm`, uploaded as
`CompiledWasm` — which Cloudflare compiles when the Worker is uploaded. So what a route awaits at
request time is already a `WebAssembly.Module`: nothing is read, nothing is compiled, and no
request pays for WebAssembly it does not use. Shipping the bytes and calling
`WebAssembly.compile()` instead would pay that compile again in every isolate, on the first
request to reach one, which is the kind of thing this platform exists not to do.

Reaching the module from the code is the awkward part, because `app.cjs` and `edge.cjs` are
CommonJS and a CommonJS module cannot statically import a compiled-WebAssembly module. A generated
ES module does it instead — `wasm.mjs`, imported by the runtime before any entrypoint is
evaluated — which imports each module once and publishes it under every name that reads it:

- `wasm_<hash>`, Turbopack's own, for an entrypoint on the edge runtime. Its chunks read the name
  as a bare global (`compileModule(path, () => wasm_<hash>)`), Next.js hands the adapter the same
  name in `wasmAssets`, and nothing else is needed.
- `__arkorWasm_<sha256>`, ours, for the Node.js runtime — where the `wasm-loader` patch turns
  Turbopack's file read into a read of this global — and for a `?module` import the app bundler
  resolved itself, as `@vercel/og`'s edge build writes them.

A deployment whose build reached no WebAssembly at all has no `wasm.mjs` and no `wasm/*` module;
its Worker is byte for byte what it was before. Where a trace merely mentioned a `.wasm` — and
`@vercel/og` puts 1.4 MiB of it in the trace of every page that imports anything of Next.js's
metadata — the module itself does not travel unless something was found to read it; the (then
empty) `wasm.mjs` still does, because what the runtime bundle imports is settled before the app
bundle has resolved its `?module` imports.

What this is checked against is Next.js's own `test/e2e/edge-can-use-wasm-files`, whose shape
`fixtures/next-edge` repeats: `import wasm from './add.wasm?module'` in a middleware and in a
route with `runtime = 'edge'`, called twice. `fixtures/next-minimal` does the same on the Node.js
runtime, in both of the forms Turbopack compiles — `?module`, which compiles, and the plain
import, which instantiates.

## Not supported, and not prepared for

builds by webpack (except for a static export, which carries no built code and so is taken from
any bundler); a custom `cacheHandler` / `cacheHandlers` module in a build that has code to load it
with (the platform's Worker cannot load a module by path, and the platform supplies the incremental
and `use cache` handlers itself; a static export runs no handler of its own, so the option is
unused rather than unsupported); revalidation of a route on the edge runtime (its outputs are
served as built, or rendered whole, and never regenerated); `partialFallback` (recorded only);
`experimental.runtimeServerDeploymentId` (its manifests evaluate — see
`test/manifests.test.ts` — but the Worker would need `process.env.NEXT_DEPLOYMENT_ID` at request
time, which the deploy step sets and the runtime tests do not).

## Experiments

`EXPERIMENTS.md` records what was tried against this package and the runtime, with the
measurements, and what was kept.
