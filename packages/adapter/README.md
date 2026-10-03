# @stayingupwind/adapter

`next build` calls this adapter with a description of the application, and it writes a deployment
bundle under `<projectDir>/.arkor/` — `bundle.json`, the blobs it names, and the two Functions
(`app`, `middleware`) that run the application's code under `@stayingupwind/runtime`. Nothing here talks
to Cloudflare: a build needs no credentials, and uploading the bundle is the host's job.

Name the adapter in `next.config`:

```ts
import { createRequire } from 'node:module';

export default {
  adapterPath: createRequire(import.meta.url).resolve('@stayingupwind/adapter'),
};
```

or by environment, which is how a host builds an application without touching its config:

```bash
NEXT_ADAPTER_PATH=$(node -e "console.log(require.resolve('@stayingupwind/adapter'))") next build
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

| Context field                                                                                                                                    | Bundle field                                                                                                                         | Read by                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nextVersion`, `buildId`                                                                                                                         | `nextVersion`, `buildId`                                                                                                             | control (deployment summary); runtime (`buildId` on a resume)                                                                                                                                                 |
| `projectDir`, `repoRoot`                                                                                                                         | `projectDir` (relative)                                                                                                              | recorded                                                                                                                                                                                                      |
| `distDir`                                                                                                                                        | —                                                                                                                                    | the adapter itself: manifests, chunks, the instrumentation hook, `images-manifest.json`                                                                                                                       |
| `config.output`                                                                                                                                  | —                                                                                                                                    | the adapter itself: `'export'` is a build with no server, bundled as described below                                                                                                                          |
| `config.basePath`, `trailingSlash`, `skipTrailingSlashRedirect`, `skipProxyUrlNormalize`, `poweredByHeader`, `i18n`                              | `config.*`                                                                                                                           | runtime (`basePath`, `i18n` for routing); control (`basePath` and `i18n` decide whether a dynamic shell is served from the edge)                                                                              |
| `config.images`, as `<distDir>/images-manifest.json` has it (source patterns compiled to regular expressions), when the default loader is in use | `config.images`                                                                                                                      | edge (what `/_next/image` enforces); control (carried to the manifest); runtime (the source, when the edge has nothing to serve)                                                                              |
| `routing.*` (every phase, `shouldNormalizeNextData`, `rsc`)                                                                                      | `routing.*`, verbatim                                                                                                                | runtime (`@next/routing`, RSC headers); control (dynamic route matchers, reserved routes, header rules); the adapter itself (`rsc`'s prefetch segment suffixes, to read a segment output's own pathname back) |
| `outputs.appPages`, `appRoutes`, `pages`, `pagesApi`: `pathname`, `filePath`, `assets`, `runtime`                                                | `entrypoints[]` (`id`, `kind`, `pathname`, `runtime` when it is `'edge'`); the module and its traced chunks go into the app Function | runtime (which module answers a route); control (an edge route's shell is not served from the edge, and the cache holds no generation of it)                                                                  |
| `outputs.appPages`, `appRoutes`, `pages`, `pagesApi`: `sourcePage`                                                                               | `sourcePages[]` (`id`, `sourcePage`), verbatim; left out of the Function's runtime manifest                                          | the inspector (the application's own folders: a pathname keeps no route group or parallel slot)                                                                                                               |
| `outputs.*[].edgeRuntime` (`modulePath`, `entryKey`, `handlerExport`), `assets`, `config.env`, for an output on the edge runtime                 | —                                                                                                                                    | the adapter itself: the Function's edge bundle is built from them (see below)                                                                                                                                 |
| `outputs.*[].wasmAssets`, for an output on the edge runtime                                                                                      | —                                                                                                                                    | the adapter itself: each module travels as a `CompiledWasm` module of the Function, published under the global its key names                                                                                  |
| a `.wasm` among `outputs.*[].assets`, for an output on the Node.js runtime                                                                       | —                                                                                                                                    | the adapter itself: Next.js says nothing about it, so it is looked for; the `wasm-loader` patch reads it from the Function                                                                                    |
| `outputs.middleware`: `filePath`, `assets`, `runtime`, `config.matchers`                                                                         | `middleware.matchers[]`; the module goes into both Functions                                                                         | edge (when to run the middleware); runtime. On the edge runtime (`middleware.ts`) it goes into both Functions' edge bundles instead                                                                           |
| `outputs.prerenders[]`: `id`, `pathname`, `route`, `routeType`, `response`, `compute`                                                            | same names                                                                                                                           | runtime (which shell answers a route); control (which prerenders the edge may serve)                                                                                                                          |
| `outputs.prerenders[].fallback.filePath`, `postponedState`                                                                                       | `body`, `postponed` (blobs)                                                                                                          | runtime and control (shell and resume)                                                                                                                                                                        |
| `outputs.prerenders[].pathname`, read against `routing.rsc.prefetchSegmentDirSuffix` and `prefetchSegmentSuffix`                                 | `segmentPath`                                                                                                                        | the host (which router prefetches it can answer from its own storage, `prefetchSegments`)                                                                                                                     |
| `outputs.prerenders[].fallback.initialStatus`, `initialHeaders`                                                                                  | same names                                                                                                                           | runtime and control (the shell's status and headers)                                                                                                                                                          |
| `outputs.prerenders[].parentOutputId`, `groupId`, `htmlSize`, `pprChain`, `config.renderingMode`, `allowQuery`, `bypassFor`, `partialFallback`   | same names                                                                                                                           | recorded                                                                                                                                                                                                      |
| `outputs.prerenders[].parentFallbackMode`                                                                                                        | same name                                                                                                                            | runtime (a member of a `fallback: false` route is resolved by its own name, since its dynamic matcher fires only for a draft)                                                                                 |
| `outputs.prerenders[].fallback.initialRevalidate`, `initialExpiration`; `config.allowHeader`                                                     | same names                                                                                                                           | the host (the lifetime it seeds a build's generation with); runtime (the headers a regeneration may see)                                                                                                      |
| `outputs.prerenders[].config.bypassToken`                                                                                                        | `bypassToken`, once for the build                                                                                                    | runtime (a request whose `__prerender_bypass` carries it is in draft mode, and is rendered rather than answered from the build or the cache)                                                                  |
| `config.cacheComponents`, `partialPrefetching`, `expireTime`, `cacheLife` (as resolved)                                                          | `config.*`                                                                                                                           | recorded (what a runtime lifetime by name means); the inspector shows them                                                                                                                                    |
| `config.cacheHandler`, `cacheHandlers`                                                                                                           | —                                                                                                                                    | a build that names one **fails**: the Function cannot load a module by path, and the platform supplies the handlers itself                                                                                    |
| `outputs.staticFiles[]`: `pathname`, `filePath`, `immutableHash`                                                                                 | `staticFiles[]` (`pathname`, `blob`, `immutable`); the one named `/index` is offered under `/` too                                   | edge and control (served from storage); runtime (the small ones the Function carries)                                                                                                                         |
| `public/` (from `projectDir`)                                                                                                                    | `staticFiles[]`, URL-encoded pathnames under the `basePath`                                                                          | as above; not walked for a static export, whose `out/` already holds it                                                                                                                                       |

Both routers are built the same way. What the Pages Router adds is `_next/data`: `next build`
emits a data output per page whose props come from `getServerSideProps` (an entrypoint of its
own, named `/_next/data/<buildId>/…json`) or from `getStaticProps` (a prerender under the same
name), and the runtime serves those from the name the client asks for. Its home page is the one
output whose name is not its URL — `normalizePagePath` spells it `/index` — so the file is
offered under the application's root as well.

`modifyConfig` sets `supportsImmutableAssets` (content-addressed `/_next/static/immutable/*`).
Next.js turns it off again for a static export, in `finalizeConfig`, after the hook has run.
`next/image` is left as the application configured it: the edge optimizes `/_next/image`.

## The development server

`modifyConfig` is called for every phase, and in `phase-development-server` it does one thing: it
reserves `/__upwind` inside the dev server's own routing (`src/dev-prefix.ts`). `upwind dev` is the
front door and has already answered that prefix before Next.js is asked, so this is for the paths back
in — a middleware that rewrites to `/__upwind/…`, a request Next.js makes of itself — where a
catch-all route of the project's would otherwise answer for it. Two rules go at the head of
`beforeFiles`, ahead of the filesystem, pointing at the address `UPWIND_DEV_ADDRESS` names; a
project's own `rewrites` keep the list they were declared in.

Without that variable — a plain `next dev`, with no upwind in front — nothing is changed at all. There
would be no server to send the prefix to, and a rewrite to a port nothing listens on is worse than no
reservation.

## What the project declares beside `next.config`

One thing the Adapter API has no notion of is a schedule, so the adapter reads it from a file of
the project's own (`src/project-config.ts`). Four names are looked for directly under
`projectDir` — `upwind.config.ts`, `upwind.jsonc`, `upwind.json`, `vercel.json` — and
**the first that exists is the whole of the configuration**; they are not merged, because merging
means deciding which file wins a key neither meant to share.

| Read              | Bundle field             | Held to                                                                                                                                                                           |
| ----------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crons[]`         | `crons`                  | Vercel's dialect, at build time: a path, and a five-field UTC expression (`@stayingupwind/core/cron`)                                                                             |
| `functions.split` | (how the bundle is made) | `false`, `true`, or `{ maxMiB?, maxCodeMiB? }`, which can only tighten the host's budgets (below). Never read from `vercel.json`, where `functions` is Vercel's per-file settings |
| anything else     | —                        | ignored, so a `vercel.json` full of Vercel's own deployment configuration is not read twice, differently                                                                          |

An `upwind.config.ts` is evaluated by Node itself — type stripping, no build step, erasable syntax
only — and may export a function, so what a project declares can be computed. A file that will not
parse, a key whose shape is wrong, or a schedule that cannot be run fails the build with the file
named: the alternative is a deployment whose jobs quietly never fire.

## A large application, split across Functions

A Function has a size limit, and every byte of its code is compiled when it starts. An application
whose routes between them outgrow one Function can be built as several instead, each holding some of
the routes — **only where the host asks for it** (`createAdapter({ functions: { split } })`), since
a host then has to send each request to the Function its route is in.

**When.** The application is built as one Function first, exactly as it would be otherwise, and
weighed. Within the budgets — `maxMiB`, what a Function may weigh, and `maxCodeMiB`, how much of
that may be code — that Function is the build, and the bundle is the version-1 bundle it always
was. Past either, the routes are split — where they can be: an application whose routes are one
unit (see below), or whose plan comes to one Function, stays one Function over the budgets, and the
build says so. A host can split every application that is past the budgets
(`projects: 'all'`, the default) or only those whose own configuration asks
(`projects: 'opted-in'`); a project can turn the split off with `functions.split: false`, or tighten
the budgets, never loosen them.

**How the routes are placed** (`plan.ts`). The unit is a module — entrypoints that share a built
file go together — except the Pages Router, which goes whole, since `res.revalidate()` renders any
of its pages in the Function that calls it. (An App Router page it asks for may be in another
Function, which the one asking can neither render nor reach; that page is invalidated instead, as
`revalidatePath` invalidates one, and its own Function renders it for the next request.) Every app
Function carries the same base: the middleware,
the instrumentation hook, the not-found page and the Pages Router's error pages, every manifest, and
the same `runtime.json`, so that each routes a request as Next.js would and knows where every route
is. The units are then merged two at a time, always the pair whose union adds the least code to the
larger of them — routes that share a layout and its libraries first, routes that share nothing last
— while the result stays within both budgets. What remains is the plan: few Functions within the
budgets, each holding routes that share their code. Few, not the fewest: the merge is greedy, and a
pair taken early can leave two units that would each have fitted beside another without a partner
— finding the fewest is bin packing, which no build should wait on. Each piece is weighed with what
the one Function measured: a chunk at the bytes it put into that Function's code (the bundler's
per-module figures, scaled to the module they went into), a package linked from `.next/node_modules`
with the routes whose chunks import it, a prerendered body, a file a route reads, a WebAssembly module
at its size. Code and WebAssembly count against both budgets; the rest against
the size alone. What the middleware and the instrumentation hook reach — their code, their
WebAssembly, the files they read — is in every Function, and is weighed there, whichever routes
reach it too.

Three rules keep a plan from being worse than not splitting. A budget the base and the smallest unit
already pass is one no Function could meet, and is dropped rather than leave every route in a
Function of its own. A unit past a budget the others meet stands alone, as small as it can be —
but takes in a unit whose code it mostly has, one that adds no more code than the two share, since
leaving them apart would carry that code twice. And a plan is never more than `MAX_APP_FUNCTIONS`
Functions: past that, the cheapest merges go on whatever the budgets say.

**What is built.** Each Function of the plan with its own routes' chunks, WebAssembly, files and
prerendered bodies, and the base. The first — the one holding the most documents — is `app`, as
always; the others are `app-2`, `app-3`…, carried in `functions.split`, each route placed in its
Function on its entrypoint (`function`), and the bundle is version 2 (`SPLIT_BUNDLE_VERSION`), which a
reader of version 1 refuses rather than taking `app` for the whole application. A Function's code
modules are named after it — `app-2.cjs`, `edge-2.cjs` — and so are its source maps
(`app-2/app-2.cjs`), so a stack frame says which Function it came from. `dependencies.json` records
each Function and the `plan`: its routes and what each Function was expected to weigh.

**What a host does with it.** It sends each request to the Function its route is in. The manifest
says which, as far as a table can: `functionFor` reads the request the way Next.js routes — a
rewrite ahead of the filesystem, the exact pathnames, the dynamic routes — and answers `undefined`
where it cannot, for the first Function to take. A Function handed a request for a route it does not
hold answers `421` (`MISDIRECTED_STATUS`) with the name of the Function that does
(`x-arkor-function`), the request's own body, unread, and — where it routed the request before it
found that out — the routing it came to (`x-arkor-routed`). The host sends the request on, once,
with that body and that header; a resume or a regeneration, answered before any routing, goes on as
it was asked. The Function that receives it answers from where the routing left off, and the
response is the one a single Function would have given. A second `421` is the host's own mistake
and is not followed.

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

**What the Function is.** It is still built, and it runs none of the application's code: no entry, no
Turbopack runtime to patch, no build manifest for one to read. It carries the error documents and
the routing tables, and the edge sends it only what is not a file — a miss, a redirect from
`next.config`, the trailing-slash normalization — which `@next/routing` answers as Next.js's own
router would. Every document is the edge's, from storage; which is also why a rewrite is not
followed, its destination being a file the Function does not carry (`output: 'export'` does not
support rewrites under Next.js either).

## What the adapter reaches into

Beyond the API, the Function build depends on these files of Next.js's output and package. Each
dependency is one module under `src/patches/`, held to every Next.js in the supported range by
the two checks described under "Which Next.js" below, and recorded per build in
`.arkor/dependencies.json`.

| Where                                                                                                                                                                      | What                                                                                                                                                                                                                                                                                                                                                                                                             | Why, and what guards it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.next/server/chunks/[turbopack]_runtime.js`, `.next/server/chunks/ssr/[turbopack]_runtime.js`                                                                             | the two `require(path.resolve(RUNTIME_ROOT, chunkPath))` sites become a static table (`turbopack-runtime` patch); a chunk whose code another chunk has is loaded from that one's file (`same-chunks.ts`)                                                                                                                                                                                                         | workerd resolves only the names in the bundle; a table is what esbuild can follow. Exactly two sites per file, or the build fails. Only Turbopack builds are accepted. Turbopack writes the same chunk under several names, and the bundle carried each; two chunks are the same when their code is, once the map comment, the `debugId` and `chunkId` comments and the first-line statement recording that id are set aside                                                                                                                                                                                                                                                              |
| `.next/server/chunks/[turbopack]_runtime.js`, `.next/server/chunks/ssr/[turbopack]_runtime.js`                                                                             | `RUNTIME_ROOT` and `ABSOLUTE_ROOT`, both `path.resolve(__filename, …)`, are resolved from the runtime's own path under `/bundle` instead (`turbopack-root` patch)                                                                                                                                                                                                                                                | bundled into the Function's module, `__filename` is at the top of the module tree, so both roots were `/`: a file a server module refers to by URL (`new URL('./data.json', import.meta.url)`, which Turbopack copies to `server/assets` and the Function now carries) was read from `/server/assets/…`, where nothing is. One of each per file, and none left over, or the build fails                                                                                                                                                                                                                                                                                                   |
| `next/dist/server/lib/router-utils/instrumentation-globals.external.js`                                                                                                    | the computed `require` of the hook becomes the hook's file, or an empty module when the app has none (`instrumentation` patch)                                                                                                                                                                                                                                                                                   | one site, or the build fails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `next/dist/server/load-manifest.external.js`                                                                                                                               | `readFileSync(path)` + `vm.runInNewContext` become a JSON read (`load-manifest` patch); the JSON is what `evaluateManifestScript` produced at build time with the same `vm` evaluation Next.js would run, in a context holding `process.env.NEXT_DEPLOYMENT_ID` = the bundle's deployment id                                                                                                                     | four sites, no `vm` left, or the build fails. `test/manifests.test.ts` compares every manifest of every built app with Next.js's own `evalManifest`. A missing manifest still surfaces as Next.js's own invariant ("The manifests singleton was not initialized"), since Next.js swallows the read's failure                                                                                                                                                                                                                                                                                                                                                                              |
| the Turbopack WebAssembly loader for the Node.js runtime, wherever the version keeps it: the server chunk it was moved into (16.3), or the Turbopack runtime itself (16.2) | its two entry points — `compileModule`/`instantiate` in the module, `loadWebAssemblyModule`/`loadWebAssembly` in the runtime — become reads of the module the Function carries, keyed by the `.wasm` path relative to `distDir` (`wasm-loader` and `runtime-wasm-loader`, both in `patches/wasm-loader.ts`)                                                                                                      | Turbopack's loader reads the file off disk with `createReadStream` and compiles it with `WebAssembly.compileStreaming`: a Function has no file, and would pay the compile in every isolate. Only the registration is rewritten — the read itself is a named declaration or an inlined expression depending on how many ways the build imports a `.wasm`, and what is left of it is unreferenced. Neither file has a fixed name, so each is found by what only it carries — the module by its two marks together, the runtime by assigning a _function_ to `contextPrototype.w` where 16.3 assigns the root — and the build asserts one of them fired when an entrypoint named WebAssembly |
| `next/dist/server/app-render/cache-signal.js`, and the copy inside each `next/dist/compiled/next-server/*.runtime.prod.js`                                                 | the signal arms its pending task through a generation guard, so cancelling it does not depend on the timer being cleared (`cache-signal-timers` patch)                                                                                                                                                                                                                                                           | under `cacheComponents` every dynamic `import()` is tracked on one signal per isolate, and a timer it scheduled in one request cannot be cleared from another ("Cannot perform I/O on behalf of a different request") — measured, and refused the same way whether or not that request has ended, so a timer that fires anyway would wake the listeners a round of the event loop early. With the guard the clear is only an optimization                                                                                                                                                                                                                                                 |
| `next/dist/compiled/@vercel/og`                                                                                                                                            | Turbopack's `externalImport` of `index.node.js` becomes an `import()` of `index.edge.js` — dynamic, so the library is evaluated by the first request that renders an image and not at the Function's start (`vercel-og` patch), and that build's fallback-font `fetch` a read of the font the Function carries (`vercel-og-font` patch); its `./resvg.wasm?module` imports resolve to the Function's own modules | the Node.js build is external — a module no bundler can follow and the Function does not have — and reads its font and `resvg.wasm` off disk before compiling the WebAssembly in every isolate. The edge build is the same library written for a runtime with neither, so `next/og` answers with an image instead of a 500                                                                                                                                                                                                                                                                                                                                                                |
| `next/dist/compiled/next-server/app-page*.runtime.prod.js`                                                                                                                 | the one `setTimeout` a prerender's task group is scheduled with becomes the runtime's task scheduler, `setTimeout` staying as the fallback (`task-timers` patch); the warning that Cache Components "cannot be guaranteed" is silenced                                                                                                                                                                           | a prerender with `cacheComponents` is a sequence of `setTimeout(…, 0)` tasks between which React's `setImmediate` work is drained by Next.js's patch of `setImmediate` and `process.nextTick`; workerd fires the timers first and has no `nextTick` queue, so the render was aborted empty and hung when decoded. `packages/runtime/src/tasks.ts` runs each task once the immediates before it have run. One timer and one warning, or the build fails                                                                                                                                                                                                                                    |
| `cloudflare:node` (`handleAsNodeRequest`)                                                                                                                                  | not a patch: the runtime hands each entrypoint the `IncomingMessage` and `ServerResponse` of a real `node:http` server workerd runs, as every official adapter does from Node's own                                                                                                                                                                                                                              | needs workerd 1.20260917.1 or later: before it, the response emitted `close` when the request body ended, which Next.js's response pipe takes for a client that went away (see EXPERIMENTS.md, V-01)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `require-in-the-middle`, `import-in-the-middle`                                                                                                                            | resolved to an empty module                                                                                                                                                                                                                                                                                                                                                                                      | Node module-loader hooks (OpenTelemetry) with no loader to hook                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| the Turbopack runtime's `externalImport(id)`, the server runtime's `import(e)` (`next/dist/compiled/next-server/*.runtime.prod.js`)                                        | not a patch: left as they are, an `import()` of a module named at run time, and recorded                                                                                                                                                                                                                                                                                                                         | the loads Next.js makes with something other than one module's name, known to be reached only where they work (a Node built-in); a `require` or `import()` like it anywhere else fails the build                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `critters`                                                                                                                                                                 | resolved to a module whose constructor throws                                                                                                                                                                                                                                                                                                                                                                    | required by the Pages Router runtime for `experimental.optimizeCss`, which reads built stylesheets off disk; an app that turns it on fails its first render in so many words rather than the bundle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `next/dist/compiled/raw-body`                                                                                                                                              | resolved to the adapter's own copy (`patches/raw-body.ts`)                                                                                                                                                                                                                                                                                                                                                       | the compiled module bundles `depd`, which builds a function from a string; workerd refuses that at load, and the Pages Router's API body parser answered every request `400 Invalid body`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| the `AsyncLocalStorage` banner                                                                                                                                             | `globalThis.AsyncLocalStorage ??= require('node:async_hooks').AsyncLocalStorage` is the first line of `app.cjs`, and of `edge.cjs`                                                                                                                                                                                                                                                                               | Next.js's storages read the global once, at module evaluation, and settle for a fake without it; a bundle without the banner fails every render (`test/node/broken-bundles.test.ts` in the runtime)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `.next/server/edge/chunks/**`, the chunks of an entrypoint on the edge runtime                                                                                             | evaluated, in the order `assets` lists them, by the thunk in `edge.cjs` that the route's first request calls; the handler is then read from `globalThis._ENTRIES[entryKey]`                                                                                                                                                                                                                                      | the documented way to invoke one (Adapters, "Invoking Entrypoints"). Their chunk loader reads no file at run time (`loadChunkCached` throws), so evaluating the chunks is the whole of loading an entry; their Turbopack runtime's `import()`, `require.resolve` and kept loader are recorded and allowed                                                                                                                                                                                                                                                                                                                                                                                 |
| Node built-ins                                                                                                                                                             | `node:*` and the bare names are left to workerd; a built-in outside the list in `dependencies.ts` fails the build                                                                                                                                                                                                                                                                                                | under `nodejs_compat` every built-in import resolves (the unimplemented ones as stubs that throw when used), so the list is what is known to be reached only where it works                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `*.json` under `.next/` and `.next/server/`, `BUILD_ID`, each route's `react-loadable-manifest.json` and `*_client-reference-manifest.js` (as `.json`)                     | shipped as text modules of the app Function under their `.next/...` names; the runtime mounts them at `/bundle/...`. The middleware Function carries none                                                                                                                                                                                                                                                        | excluded rather than listed (`*.nft.json` are the only files known to be of no use): a manifest Next.js reads without a fallback that a list left out fails every route. Only a route module reads one: the middleware module and its hook open none                                                                                                                                                                                                                                                                                                                                                                                                                                      |

The app module (`app.cjs`) is bundled by Rolldown, as one CommonJS module with the patches
applied as each file is loaded — 5% smaller than esbuild made it from the same graph, and built
sooner (see EXPERIMENTS.md, V-03); the runtime module (`index.mjs`) by esbuild, for its `workerd`
conditions; the edge bundle (`edge.cjs`), where a build produced one, by Rolldown as well. All three
are minified in whitespace and syntax and not in names, so a stack trace still names its function.

`.arkor/dependencies.json` records, per Function — and under `edge`, for its edge bundle — the
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
in code the bundle left out is not reported — of those, under `guardedRequires`, the ones whose
failure the code handles itself, a call of the loader in the block of a `try` that has a `catch`
within the same function (an `import()` too, where it is awaited there) — the `.wasm` the bundler
resolved itself, each with the global the Function publishes it under — and the Function's
modules, with what they weigh together before and after gzip. The audit (`auditFunction`), which
each of a Function's bundles goes through, fails the build on a `require("vm")` or
`runInNewContext` that survived, a built-in outside the list, a module the bundler could not
resolve, or a use of the loader outside Next.js's own that the code does not guard; a guarded one
fails in the Function into its own `catch`, as it does under Node.js with the module not installed
— which is how `@protobufjs/inquire` loads `protobufjs`'s optional modules, and how TypeScript
loads a compiler plugin. `auditFunctionSize` fails the build on a Function over Cloudflare's
64 MiB, so that the build says so rather than the upload. That limit is on the uncompressed bundle and is the only one
there is: Cloudflare dropped the compressed limits — 3 MB free, 10 MB paid — on 2026-09-04, and the
gzipped figure the record carries is now worth reading rather than being refused for. A Function
well inside the limit can still be worth making smaller; Cloudflare says of the same change that
"larger Worker bundles can impact startup time", which is a cost the audit does not measure and a
first response pays.

The middleware Function answers one request, which runs the middleware and hands back its response,
and carries what that path reads: its runtime manifest keeps the configuration and the `next.config`
rules without the entrypoints, prerenders, files and dynamic routes, it has no build manifest, and
its runtime is built without the host's cache module (`cacheHostModule`), since the cache handlers
are installed in the app Function alone. The instrumentation hook travels in both, as Next.js runs it
before either.

## The edge runtime

A route with `export const runtime = 'edge'`, and the deprecated `middleware.ts`, are not modules
the Function can require: Turbopack builds them into chunks that register a Web handler in
`globalThis._ENTRIES` as they are evaluated. They go into a second bundle, `edge.cjs`, built like
`app.cjs` but with `process.env.NEXT_RUNTIME` pinned to `"edge"` — the test that code branches on,
and the reason the two cannot share a bundle. `edge.cjs` is a table of thunks, as `app.cjs` is, so
a Function loads at startup only the table and evaluates an entry's chunks on the first request that
needs it; a deployment with no such entrypoint has no `edge.cjs` at all, and its Function is byte
for byte what it was before.

Three consequences, all from Next.js's own templates:

- An edge entrypoint renders with `postponed: undefined` (`build/templates/edge-ssr-app.ts`), so
  it can never resume a shell. The bundle marks the route `runtime: 'edge'`, `edgeServablePrerenders`
  leaves its prerenders to the Function, and the runtime refuses a resume asked of one. A prerender
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

A Function carries each `.wasm` as a module of its own, `wasm/<sha256>.wasm`, uploaded as
`CompiledWasm` — which Cloudflare compiles when the Function is uploaded. So what a route awaits at
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
its Function is byte for byte what it was before. Where a trace merely mentioned a `.wasm` — and
`@vercel/og` puts 1.4 MiB of it in the trace of every page that imports anything of Next.js's
metadata — the module itself does not travel unless something was found to read it; the (then
empty) `wasm.mjs` still does, because what the runtime bundle imports is settled before the app
bundle has resolved its `?module` imports.

What this is checked against is Next.js's own `test/e2e/edge-can-use-wasm-files`, whose shape
`fixtures/next-edge` repeats: `import wasm from './add.wasm?module'` in a middleware and in a
route with `runtime = 'edge'`, called twice. `fixtures/next-minimal` does the same on the Node.js
runtime, in both of the forms Turbopack compiles — `?module`, which compiles, and the plain
import, which instantiates.

## Which Next.js

One declaration, `SUPPORTED_NEXT_RANGE` in `src/patches/versions.ts`, which is also the
`peerDependencies.next` of this package and of `upwind` — `check-patches.ts` holds those two to
it, and holds the catalog's own pin to being inside it, since that pin is the version the checks
below use when they are given no other. Two checks hold the range itself to Next.js rather than
leaving it a number somebody wrote once:

| Check                                             | What it answers                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check:patches` (`scripts/check-patches.ts`) | the ten rewrites that reach Next.js's own package still find what they insist on. A patch is a pure function of a file's source, so this needs no build: the files come out of the published package. With no flags, the installed Next.js — seconds, no network, and what every pull request runs. With `--range`, every release the range admits |
| `pnpm check:matrix` (`tools/next-matrix`)         | the other five, and all ten again, against a real `next build` of `fixtures/next-minimal` and `fixtures/next-edge`. `turbopack-runtime`, `turbopack-root`, `wasm-loader`, `runtime-wasm-loader` and `vercel-og` rewrite what the build _writes_ rather than what Next.js ships, and no reading of a package produces a Turbopack runtime           |

**The first check cannot speak for all fifteen, and it does not claim to.** It names the five it
cannot reach and requires every other patch to fire, so one whose target stopped matching is a
failure rather than a patch quietly reclassified. The five are the matrix's, and they are where
most of what moves has moved: of the five differences reaching down to 16.2 turned up, four were
invisible to a package read — the WebAssembly loader's move, the leftover `turbopack-runtime` was
reading, a chunk where a minifier had renamed `scheduleOnNextTick`, and a chunk name carrying a
character the audit's allowance had not expected. The fifth, `image-response`'s Cache Components
branch, is in the package, and `--range` would have caught it on its own.

The matrix is also what checks the half of the claim the first cannot: that a patch still finds
its file **in a bundle**. A rewrite can apply perfectly to a module no build ever loads.

`--canary` checks the current canary as a forecast. A prerelease is not in the range — a
semantic-version range admits no prerelease it does not name — so what it reports is not this
adapter being wrong about a version somebody can install, but what the next release is about to
do to these rewrites. It is run as a step of its own that is allowed to fail, and it is failing
now: `16.4.0-canary`'s `CacheSignal` schedules through an `immediateTracker` that the
`cache-signal-timers` patch has never seen. A canary is numbered as the next minor whatever it is
going to become, and which it becomes is decided when it ships: as a major it is outside this
range already and costs nothing, as a minor it is inside it and that patch has to learn the new
shape first.

The floor is where the Adapter API became stable, which is 16.2. Below it the hook is
`experimental.adapterPath` and hands `ctx.routes`, a different shape altogether, with no
`@next/routing` release to resolve it and no `edgeRuntime` metadata to build an edge bundle from:
not a range to widen, but an adapter to write.

That floor is a question about shapes, not about advisories, so the range admits Next.js releases
with known vulnerabilities in them — and this adapter says so rather than refusing them. A build
against a Next.js older than `SECURITY_FLOOR` (`@stayingupwind/core/next`, the newest release
carrying security fixes that this release of upwind knows of) ends with a warning naming it, and
`upwind dev` says the same thing under its own version line. What answers a request is the Next.js
the project installed, and the fixes that matter to a deployment are inside Next.js's own code —
`use cache` keying, its draft-mode fills, the ownership checks a route template makes of a prerender
it is about to treat as its own — so none of them is something a rewrite here could supply. A
project that has to stay on 16.2 keeps a deployment that works and is told what it is;
`check-patches.ts` holds the floor to being inside the range, and nothing can tell either of them
that a newer security release exists. A static export is warned for nothing: it carries no Next.js
server code.

### What a build before 16.3 does not carry

16.2 reaches the whole of this adapter. Three of the things the bundle is built out of arrived in
16.3, and none of them is a thing the platform has to do without: two are filled in from elsewhere,
and the third is read off the outputs it would have described.

| What 16.2 has not got            | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routing.middlewareMatchers`     | filled from the middleware output's own `config.matchers`, which is the same table one place along (`bundleRouting`)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `outputs.prerenders[].route`     | resolved through the prerender's parent entrypoint, which is where it comes from for every prerender of every fixture built so far. A prerender whose parent is not among the entrypoints **fails the build**, named: the runtime answers a pathname with the shell of the route it resolved, and a route guessed from the pathname would file every member of `/blog/[slug]` under its own name and serve one page's shell for another's                                                                                                                                 |
| the prerender classification     | read off the outputs instead (`@stayingupwind/core/bundle`, `documentPrerenders`). Which output of a group is the document is the group's own shortest pathname — every sibling is that pathname with `.rsc`, `.segments/…` or the `_next/data` form added — and whether the code behind a route renders a document at all is its entrypoint's kind. What a build finished and what it left to a resume is its postponed state. All four are facts the bundle carries on every version, and they agree with the classification wherever there is one to compare them with |
| `config.supportsImmutableAssets` | ignored by 16.2, so no `/_next/static/immutable/*`. `immutableHash` is there already, so `immutable` itself still holds. **This is the one thing a 16.2 deployment does without**, and the build says so at the end                                                                                                                                                                                                                                                                                                                                                       |
| `config.partialPrefetching`      | recorded as absent (16.2's `partialFallbacks` is a different thing, not a spelling of it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

`src/collect.ts` declares the first two as optional on its own `BuildContext`, since that is what
they are across the range.

Two fixture bundles of the same application, one built with 16.2.12 and one with 16.3.6, come out
with the same documents in the shell index, the same generations seeded, and the same prerenders
servable from the edge.

## Not supported, and not prepared for

builds by webpack (except for a static export, which carries no built code and so is taken from
any bundler); a custom `cacheHandler` / `cacheHandlers` module in a build that has code to load it
with (the platform's Function cannot load a module by path, and the platform supplies the incremental
and `use cache` handlers itself; a static export runs no handler of its own, so the option is
unused rather than unsupported); revalidation of a route on the edge runtime (its outputs are
served as built, or rendered whole, and never regenerated); `partialFallback` (recorded only);
`experimental.runtimeServerDeploymentId` (its manifests evaluate — see
`test/manifests.test.ts` — but the Function would need `process.env.NEXT_DEPLOYMENT_ID` at request
time, which the deploy step sets and the runtime tests do not).

## Experiments

`EXPERIMENTS.md` records what was tried against this package and the runtime, with the
measurements, and what was kept.
