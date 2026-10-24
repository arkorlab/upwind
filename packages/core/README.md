# @stayingupwind/core

The vocabulary the other two packages and a host's own edge all speak. Nothing here runs anything:
it is the deployment bundle's shape, the cache's terms, the classification of a request, and the
wire protocol between an edge and an application's Function — written once, so that the adapter that
writes a bundle, the runtime that serves one, and the edge in front of it cannot disagree about what
a field means.

It has no dependencies. Most of this package is schemas, and they are written with `./schema`: a
validator with zod 4's API, as much of it as these schemas use, which accepts, returns and reports
what zod would for the same schema, and builds one as a few fields on a prototype that already has
every method, so that a reader that evaluates them all before its first request pays little for
it. A schema is the contract: `deploymentBundleSchema` is what a bundle is, and a bundle that does
not parse is not one. `BUNDLE_VERSION` says which shape a reader was written for.

The cache's schemas are kept in `cache/schema.ts`, apart from the code that names, times and reads
entries, which imports only their types: a Function's runtime runs that code on every request, and
importing it brings no schema into the runtime. The one check the runtime makes, of a delivery
record's header, is written out by hand in `cache/pack-header.ts`, and answers as
`generationPackHeaderSchema` does.

The published package is TypeScript sources — `exports` names `.ts` files, and there is no build
step. A reader bundles it (the adapter bundles it into itself; the runtime is bundled by the
adapter), which is also why `sideEffects: false` is true of it: nothing here initializes anything.

## Entry points

| Subpath        | What it holds                                                                                                                                                                                                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./bundle`     | The deployment bundle: entrypoints, prerenders, routing tables, static files, the blobs they name, cache-life profiles — and the rules deciding what the edge may serve from storage and what stays with the Function (`serving.ts`)                                                                      |
| `./cache`      | What a runtime cache is made of: an entry's artifacts and their roles, freshness against a validity and an invalidation state, keys, the packing of a generation, the headers one goes out with                                                                                                           |
| `./artifact`   | Content addressing: `sha256`, canonical JSON, the key an artifact takes in storage, and the encodings a shell is held in                                                                                                                                                                                  |
| `./request`    | What a request is, before anything renders: its class, the wire constants of Next.js 16.3 the edge must recognise, RSC and conditional headers, cookies, referrer policy, CSP for a spliced document, and the safety check a pattern from a build is held to                                              |
| `./images`     | The `/_next/image` contract: the configuration as `images-manifest.json` has it, what a request may ask for, format negotiation, detection of what came back, and the headers it goes out with                                                                                                            |
| `./manifest`   | The manifest of a project as an edge reads it — routes and their cache entries, header rules, dynamic matchers, reserved routes, asset policy, preload links — with its own `MANIFEST_SCHEMA_VERSION`, on which a reader that does not know the version refuses the manifest rather than serving it wrong |
| `./deployment` | A deployment's fingerprint, and the build id read back out of a shell or a continuation                                                                                                                                                                                                                   |
| `./paas`       | The seam between a host and an application (below)                                                                                                                                                                                                                                                        |
| `./assets`     | Whether an asset may be treated as immutable, read from the `cache-control` the build wrote                                                                                                                                                                                                               |
| `./cron`       | Cron expressions in the dialect Vercel's cron jobs accept — five UTC fields, no `@daily`, no `MON` — and the schema a project declares them with; Cloudflare's Cron Trigger dialect, and a schedule written as the trigger that fires when it does                                                        |
| `./next`       | What is known about Next.js's own releases rather than about a deployment: the newest one carrying security fixes that this release of upwind knows of, and the comparison a build and a development run warn with                                                                                        |
| `./util`       | Bytes, streams, deadlines, ids, small LRUs, CRC32, HTML scanning                                                                                                                                                                                                                                          |
| `./schema`     | The validator the schemas above are written with: zod 4's API, as much of it as they use, and zod's answers                                                                                                                                                                                               |

## Serving route bodies

`classifyRequest` identifies a request's class; it does not authorize a response or run application
code. Before serving `route-body`, a host must enforce the route gate and routing/header rules,
run any matching middleware, and honour its response, redirect, rewrite or failure. Reclassify the
URL and headers after middleware before selecting a body. Serve only the current trusted record
in the manifest's deployment and cache scope, with its freshness and privacy vetoes checked. A
classified route or a public response header alone grants no permission to share its bytes.

A complete static Node.js route body may list only the fixed Next.js build protocol headers:
`host`, `x-matched-path`, `x-prerender-revalidate`, `x-prerender-revalidate-if-generated`,
`x-next-revalidated-tags`, and `x-next-revalidate-tag-token`. Unknown request dependencies still
exclude it. A request carrying any non-host protocol header or router control must reach the
Function. Hosts must preserve that veto on the original and classified headers, and on middleware
headers before and after forwarding or credential removal. Update these readers before publishing
new route-body tables; a matching header name in a build is no permission to answer a control request.

Only bundles declaring `routeBodyPrivacy: 2` are eligible: their runtime preserves privacy vetoes
and `no-transform` prohibitions, including those in targeted CDN cache-control fields. Version 1
bundles still parse but stay with the Function. Update bundle readers before enabling version 2
writers. A stored `cache-control: no-transform` alone supplies only a prohibition; the host must
combine it with its normal revalidation policy rather than infer browser freshness or sharing rights.

## Complete static Pages documents

`staticPagesPrivacy: 1` lets a host identify exact Node.js Pages documents completed at build time
with `revalidate: false`. `edgeServableStaticPages` checks the classified primary HTML output and
privacy vetoes before filters discard them. Version 1 excludes ISR; dynamic routes, loading/PPR shells, JSON siblings,
error documents, unknown request dependencies and older bundles grant no permission.

A host can publish their existing Pages cache identity in the optional `staticPages` table and mark
only the admitted primary build output with `staticPagePrivacy: 1`. Its delivery-record projection
must verify the build source, Pages kind, complete/static output, status, HTML identity and unbounded
policy before retaining that proof. Runtime regeneration never inherits version 1; older records remain unmarked.

`staticPagesPrivacy: 2` also admits exact literal Node.js Pages ISR documents with a known positive
revalidation lifetime, currently without a base path or locale routing. `staticPagePrivacyFor`
returns the expected output version: false-revalidate pages still receive 1. A table entry's optional
`staticPagePrivacy: 2` requires version 2 on each delivered generation; absence still expects 1.
The Function receives a Pages capability only when its build has an eligible ISR document or
supported fallback class. A fixed-page synthetic
regeneration checks the immutable manifest, scope, route, complete HTML, raw privacy
headers and lifetime before attaching 2 to the primary output. `__NEXT_DATA__` supplies only
supplementary consistency facts. JSON siblings remain unmarked. A host must independently recheck
build or runtime source, policy, identity and privacy on every output before projecting the proof.
No response's public TTL or prior generation's marker grants permission to its replacement.
Runtime admission is computed lazily once per immutable Function manifest. Each new render still
undergoes its own privacy and representation checks; the general build selectors remain uncached.

`staticPagesPrivacy: 3` adds supported Node.js Pages `fallback: true` routes. Fixed documents still
earn output proof 1 or 2; they never inherit 3. `staticPagesMembersOf` identifies complete built
HTML with exactly one same-source, same-group JSON twin at the canonical build-scoped data URL.
`staticFallbackPageFor` derives named parameters only for the native first unconditional owner,
preserving exact-route and rewrite precedence. The initial scope excludes encoded aliases,
trailing-slash spellings, base paths, locales, export, catch-all and optional parameters. Builds
that normalize Pages-data URLs before middleware remain with the Function, as for `routePagesData`.

Complete members have `staticPages` entries with proof 3, exact parameters and concrete
`dataPathname`. Build-owned loading bytes instead live in `pagesFallbacks`, with a template data
path and an immutable shell reference; a loading class has no entry ID or generation marker. A
first concrete runtime generation may earn proof 3 at sequence 1 only after its own synthetic
render proves complete HTML, matching props and its own positive finite revalidation lifetime.
The loading shell may omit a lifetime; that supplies no lifetime or generation proof for a concrete
member. An explicit nonpositive, unbounded or invalid loading lifetime excludes the class before
publication. An unbounded or otherwise unproved concrete render remains with the Function.
Both outputs require proof 3 before the host may
project it into the record, bound to one scope, entry, route, concrete path and generation.

The `pages-fallback` request candidate distinguishes HTML from `pages-data`; exact members use
`static-page` with an explicit data representation. Loading bytes never answer a data request.
Manifests with version-3 `staticPages` members or a nonempty `pagesFallbacks` table use schema
version 8. Older edge readers refuse the unsupported manifest; a new loading shell must never
look like a complete dynamic page to one. Update readers before enabling these writers.
Ordinary manifests retain versions 6 or 7.
Readers must retain request, middleware, nonce, configured-header, raw privacy and freshness
checks for both representations. Fresh generations require no additional authority lookup;
only cold or expired data requests may wait for their own publication and a strictly newer
verified record. Unsupported or unproved results stay with the Function. Admission tables are
cached once per immutable bundle, with no cache of visitor pathnames.

The `static-page` request class is only a candidate. A host must still enforce gates, request and
middleware privacy, nonce policy and current-generation validity before serving unchanged HTML.
Application response headers never grant this authority. Query, cookie, authorization, conditional,
router and internal requests retain their existing private paths. A host may forward HEAD without
reading a full record. `no-transform` remains a prohibition, not a public TTL or sharing grant.

## The seam with a host

`./paas` is the only part that describes two parties talking. The protocol is headers, all prefixed
`x-arkor-`, and both sides import the names rather than spelling them: what the edge asks of a
Function (run only the middleware, resume this shell, regenerate this entry, capture this page) and
what the Function says back (which generation answered, what the cache did, which tags the request
invalidated at once, and at which revision of the scope). `PLATFORM_REQUEST_HEADERS` is the whole
list of the ones that tell the runtime what to do, which is what lets it strip every one of them
before the application sees a request.

Beside it are the two things a Function is handed rather than told: its own `env`, published where
application code can reach it without it passing through `process.env`, and a project's storage
bindings, which a host binds under the names their owner gave them and lists in one text binding
that the runtime reads back.

One answer goes the other way. In a deployment whose routes the build split across app Functions
(`functions.split`), a Function handed a request for a route it does not hold answers
`MISDIRECTED_STATUS` (421) with `FUNCTION_HEADER`, naming the Function that does, and the request's
body, unread; the host sends the request on to that Function with that body. Where the Function
routed the request before it found the route elsewhere, the answer also carries `ROUTED_HEADER`, the
routing it already did, and the host sends that header on too. A resume, a regeneration or a
capture names its route up front and is answered before any routing, so it comes back without one
and goes on as it was asked. Which
Function a request should go to in the first place is the manifest's to say (`./manifest`,
`functionFor`), as far as a table can; and where a split bundle puts each route, `./bundle`
(`placedRoutes`, `functionOfRoute`, `appFunctions`).

What is deliberately absent is any host's internals. There is nothing here about how a deployment is
uploaded, where it runs, what it is reached through, or what stores its cache — that is the host's,
and a package that named it would make every host the same one.
