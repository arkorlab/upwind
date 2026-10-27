# Reviewed failures

The runs on this machine (`cloudflare` and `node`) judge their results against this record
(`src/reviewed.ts`, `src/judge.ts`). A case read here does not fail its shard; any other failure
does, and so does a suite that left no result. Each reading holds for one release of Next.js, its
version and its commit, and for the failure it was read from: the judge checks a reviewed case's
failure messages against what was recorded, so a case that fails in another way fails its shard. A
run of another release reads nothing here until its failures are read again.

A reading is one of four:

- **Deploy gate.** Upstream registers the case `test.failing` when deployed, for something Vercel's
  deployment does not do. Where the body completes here, Jest fails the case with its refusal,
  "Failing test passed even though it was supposed to fail", and nothing else; the judge counts that
  as the case passing. Where the body fails, the case has failed.
- **Vercel's infrastructure.** The case asserts what Vercel's own deployment does: a header its CDN
  adds, the form of its build log, the directory it builds in. No adapter is asked to do the same.
- **Upstream.** A defect of Next.js or of the test, reproduced without this adapter. Whether the case
  passes or fails, it says nothing about the adapter.
- **The environment.** The target's runtime cannot run the application.

## Next.js 16.4.3

Read at commit `29bbeab09981148ade186e8599ecdede15abc281`, from the night's run of 2026-10-26 (run
40369598264) and from both targets run again at `d2df8807` (runs 40453829649 and 40453835497). Each
reading holds on both targets unless it says otherwise.

### Deploy gates

#### `prerender-encoding`

"should preserve an encoded slash in an exact closed catch-all path" (1 case, gated at line 35). The
exact closed catch-all path keeps its encoded slash and answers `200`, as under `next start`; upstream
expects Vercel's filesystem lookup to miss it.

#### `metadata-streaming-parallel-routes`

"should only bundle the selected metadata resolution implementation", with `parallelRouteMetadata`
off and on (2 cases, gated at line 42). The server bundle the build emits is readable and holds only
the selected metadata implementation, as under `next start`; upstream assumes a deployment does not
expose it.

#### `expire-time`

"should do a blocking revalidation when the cache entry has expired" (1 case). The test selects
`it.failing` when deployed (lines 9–21): Vercel's proxy treats a route's `expire` as a year, so past
`expireTime` it answers stale and revalidates in the background, where the case asks for a blocking
render (vercel/next.js#93211 made Next.js itself honor `expire` that way). Here the request after
`expireTime` waits for a render of its own, and its value is new.

### Vercel's infrastructure

#### `x-vercel-cache`

`cache-components-prerender-matrix` (50 of 60 cases) and `partial-fallback-shell-upgrade` (3 of 13)
assert, when deployed, the `x-vercel-cache` header Vercel's CDN adds (`HIT`, `MISS` or `PRERENDER`).
Neither target sends it. The judge reads only a missing header, at those assertions: lines 565, 578,
641 and 697 of the matrix, and 300, 316, 329, 371 and 428 of the other.

What follows those assertions passes. With them taken out and nothing else changed, both suites pass
whole on both targets (runs 40457857360 and 40459722476). Where a shell is empty, the header is a
case's only proof that the entry was shared, and that proof alone goes unmeasured.

#### Build-log indentation

`empty-generate-static-params` (2 of 2) and `use-cache-segment-configs` (1 of 1) compare a build
error, read from the deployment's output, with a snapshot of Vercel's build log, which drops each
line's leading whitespace (the tests' own comments say so). The error is Next.js's own, line for
line. The judge takes only a snapshot that differs in leading whitespace and in nothing else.
Upstream runs these suites against Vercel alone from v16.5.0-canary.7 (vercel/next.js#99837).

#### Vercel's build directory

`non-root-project-monorepo` (4 of 10): when deployed, its `import.meta.url` cases expect
`file:///vercel/path0/apps/web/…`, the directory Vercel builds in. What they receive is the same
file, encoded as it should be, in the directory the fixture was built in here. The judge takes only
a received URL that ends with what follows `file:///vercel/path0/` in the expected one, encoding and
all. Upstream runs this suite against Vercel alone from v16.5.0-canary.7 (vercel/next.js#99837).

#### An HTML 404 for a subresource

`not-found-non-document` (2 of 6): when deployed, it expects a `text/html` 404 for font, manifest and
other subresource requests to unknown paths, which is how Vercel's CDN answers them. Both targets
answer `text/plain`, as `next start` does; the cases' own names call it a plain text 404.

#### Instrumentation registered per Function

`otel-middleware-trace` (3 of its 24 deployed cases) snapshots which request `instrumentation.ts` is
registered in, as Vercel deploys the application: its middleware, its pages and its route handlers
each a Function of its own, each registering in the first request it serves. Here one server answers
them all and registers once, in the first request it serves. The judge takes each case's snapshot
only where its changed lines are the ones recorded: the registration spans missing from the page's
request, or the registration found under the page's request rather than the route handler's. The
other 21 cases pass.

### Upstream

#### `next-dist-client-esm-import`

(1 of 1.) When deployed, the test rewrites the fixture's `link:` dependency to `file:`, for npm.
Installed by pnpm, a `file:` directory is a copy under `node_modules/.pnpm`, which Turbopack does
not compile as the application's own, and `next build` fails on its JSX (`Expected ';', got
'ident'`), with no adapter as well. vercel/next.js#95360 removes the rewrite, from
v16.5.0-canary.6. Installed by npm 11.19.1, as the rewrite assumes, the case passes on both targets
(runs 40458960844 and 40458965758).

#### `router-autoscroll`

"Should apply scroll when loading.js is used" (1 of 21, once on `cloudflare`): a race in the client
router that vercel/next.js#100066 records as a flake of Next.js's own CI, fixed by
vercel/next.js#99706 from v16.5.0-canary.16. Its `#loading-component` never shows.

#### `vary-params-base-dynamic`

Any of its cases (3 of 15 failed once on `cloudflare`). The test reveals an accordion's link inside
`act`, which waits 500 ms for at least one request to start. The home page it starts from also shows
links to the same routes, which can prefetch them when they enter the viewport, before `act` starts;
where those prefetches finish first, the revealed link is served from the cache and starts nothing.
Started at once after hydration, `act` never timed out. Started 50 ms after, it timed out in 4 of 10
runs on `next start` 16.4.3 with no adapter, and in 14 of 20 on each target; started 400 ms after, in
every run. vercel/next.js#100776 starts the test from a page whose only links are the accordions'.
The judge reads only `act`'s own timeout ("Timed out waiting for a request to be initiated").

### The environment

#### Native addons on `cloudflare`

`prerender-native-module` (3 of 3) and `turbopack-reports` (1 of 1) load a native Node.js addon from
server code, which Cloudflare's runtime cannot load. The adapter's audit refuses the Function at
build ("the app Function would not run"). On `node`, both pass.

### Not read here

These also failed on 2026-10-26, and a failure of any of them fails its shard:

- `adapter-rsc-query-leak` (`node`, 8 of 32). The hook handed the suite `127.0.0.1`, which Next.js
  spells `localhost` in the redirects it builds, so the draft-mode cookie stayed behind. Fixed by
  #366.
- `metadata-dynamic-routes` (4) and `prerender` (4) (`node`). They were answered with the runtime's
  `private, no-store` rather than by the edge's rules. Fixed by #354.
- `segment-cache/memory-pressure` (`cloudflare`, 2 of 2). Its prerendered pages put the Function over
  its size limit. Since #364 the adapter leaves bodies of 1 to 32 MiB to the cache host when that
  happens, and the suite passes (run 40459797273).
- `non-ascii-cache-item-name` (1 of 1). Unless `VERCEL` is set at build, its fixture configures a
  cache handler that keeps nothing. The hook sets it for that build (#368).
- `next-form` (`node`, once): "should soft-navigate on submit and show the prefetched loading
  state". Its `#loading` never showed. This may be the router race `router-autoscroll` records, but
  it has not been reproduced.
