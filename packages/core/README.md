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
| `./cron`       | Cron expressions in the dialect Vercel's cron jobs accept — five UTC fields, no `@daily`, no `MON` — and the schema a project declares them with                                                                                                                                                          |
| `./next`       | What is known about Next.js's own releases rather than about a deployment: the newest one carrying security fixes that this release of upwind knows of, and the comparison a build and a development run warn with                                                                                        |
| `./util`       | Bytes, streams, deadlines, ids, small LRUs, CRC32, HTML scanning                                                                                                                                                                                                                                          |
| `./schema`     | The validator the schemas above are written with: zod 4's API, as much of it as they use, and zod's answers                                                                                                                                                                                               |

## The seam with a host

`./paas` is the only part that describes two parties talking. The protocol is headers, all prefixed
`x-arkor-`, and both sides import the names rather than spelling them: what the edge asks of a
Function (run only the middleware, resume this shell, regenerate this entry) and what the Function
says back (which generation answered, what the cache did, which tags the request invalidated at
once, and at which revision of the scope). `PLATFORM_REQUEST_HEADERS` is the whole
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
routing it already did, and the host sends that header on too. A resume or a regeneration names its
route up front and is answered before any routing, so it comes back without one and goes on as it
was asked. Which
Function a request should go to in the first place is the manifest's to say (`./manifest`,
`functionFor`), as far as a table can; and where a split bundle puts each route, `./bundle`
(`placedRoutes`, `functionOfRoute`, `appFunctions`).

What is deliberately absent is any host's internals. There is nothing here about how a deployment is
uploaded, where it runs, what it is reached through, or what stores its cache — that is the host's,
and a package that named it would make every host the same one.
