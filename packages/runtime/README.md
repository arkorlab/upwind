# @stayingupwind/runtime

The code a deployment's Function is: it answers a request out of what `next build` produced, through
the routing tables, the middleware and the prerenders the bundle carries. It is written for workerd
with `nodejs_compat`, and it holds the parts of serving a Next.js application that are the same
whoever hosts it.

You do not install this to use it. `@stayingupwind/adapter` resolves it to a path and bundles it into
each Function it builds, which is why it is published as TypeScript sources with no build step of its
own, and why it must stay a package on disk rather than be inlined into the adapter.

| Subpath        | What it is                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `./function`   | The entry: one default export with `fetch`, which is what workerd looks for                                                                     |
| `./cache-host` | `CacheHost` — the interface a host implements so that the Function has a cache, and the `CacheHostError` one raises. Nothing here implements it |

## What the adapter has to supply

The runtime imports four modules it does not contain, which the adapter resolves for it, and reads one
constant the adapter defines:

| Name                      | What it is                                                                                                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arkor:app`               | The application's bundle: a table of thunks, one per entrypoint, evaluated on the first request for it                                                                                                                                          |
| `arkor:edge`              | The same for entrypoints on the deprecated edge runtime; an empty table where a build produced none                                                                                                                                             |
| `arkor:wasm`              | Publishes each compiled WebAssembly module under the global its code reads it from; empty where a build reached none                                                                                                                            |
| `arkor:cache-host`        | `createCacheHost(env)` — the one of the four that comes from outside the build, and the whole of how a host gives its cache to a deployment. A build that names none resolves to a stub returning nothing, and the Function then caches nothing |
| `__ARKOR_FUNCTION_KIND__` | `'app'` or `'middleware'` — which of a deployment's two Functions this bundle became. The middleware one runs the middleware and answers everything else `404`                                                                                  |
| `__ARKOR_FUNCTION_NAME__` | The Function's own name: `app`, or `app-2`, `app-3`… in a deployment whose routes the build split across app Functions, and `middleware` for the middleware one; what a request for another Function's route is told apart by                   |

Module order matters at the top of `./function`: the scheduler a prerender's tasks run on, and the
hooks Next.js reads off the global at its first request, are installed before any Next.js module is
evaluated — whichever module asks for one first.

## What it does with a request

`@next/routing` walks the bundle's tables, as Next.js's own router would, and the runtime serves what
each phase decides: the middleware where it matches, a document or an RSC payload from the build's
prerenders, a resume of a shell the edge already sent, a route handler, a Pages Router data URL, an
image the edge could not serve. A rewrite to somewhere else is fetched; a redirect is answered.

Two things it does not do. It keeps **no cache of its own**: it derives an entry's identity, judges
what it reads against the tags it has synced, renders a generation and says what that generation is
made of — and hands every read and write to a `CacheHost`. A deployment whose Function was given no
host runs as it did before any cache existed, answering every read a miss. And it holds **no
knowledge of the host** in front of it: what arrives is the wire protocol in `@stayingupwind/core`'s
`./paas`, and nothing more.

In a deployment whose routes the build split across app Functions, every Function routes every
request — each carries the whole `runtime.json` — and answers only its own routes. A request that
lands on another's, after the middleware and every rewrite, is answered `421` with that Function's
name, the routing it came to, and the request's body as it arrived (`placement.ts`, `handoff.ts`); a
resume or a regeneration naming another's route is answered so before anything is read. Handed the
routing back, the Function that holds the route serves it without routing it again: the middleware
has run, and what it decided travels with the request.

A resume is the one exchange worth naming here. The edge serves the build's shell and asks the
Function for the rest of the document, which comes back as the postponed part alone — so the visitor
is not sent the shell twice. A route that cannot resume one (an entrypoint on the edge runtime never
can) is not among the shells an edge is told it may serve.

## What libraries find on the global

Two things an application's libraries look for on the global, answered from the request being
served, since a Function isolate serves many at once:

- `Symbol.for('@vercel/request-context')`: the request's headers, its URL and `waitUntil`, which
  `track()` from `@vercel/analytics/server` reads (`request-context.ts`).
- `Symbol.for('__SENTRY_SAFE_RANDOM_ID_WRAPPER__')`: where Sentry's Next.js SDK reads its random
  values and its clock, so that a prerender does not read them. The SDK's own runner keeps one
  snapshot of the async context for the whole isolate, which workerd refuses outside the request
  that took it, and what it falls back to reads inside whichever render is running — which, during
  a prerender, Next.js aborts. Here each read runs in the context the current request entered the
  Function in (`random-safe-context.ts`).
