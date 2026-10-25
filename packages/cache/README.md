# @stayingupwind/cache

A deployment's runtime cache, as a host runs it: the authority that keeps each deployment's scope,
the gateways a deployment's Functions reach it through, the entrypoints whatever deploys a site and
the edge in front of it talk to it over, and the client a Function is built with.

Each deployment has a scope of its own, kept by one Durable Object with one SQLite database
(`CacheScope`): the only writer of its entries, generations, tags, invalidations and leases. A
Function reads and writes it through a gateway, behind a token signed for that scope; a read that
needs no authority is answered from storage by a read gateway placed nowhere in particular.

What a host adds is handed in. `AuthorityHost` carries the label its tokens are signed under, where
its scopes are placed, a meter of what is read and written, and whom to tell when a scope moves. A
history of what each change did is a subclass's (`CacheScope.historyOf`). Where a host adds
nothing, nothing is added.

`./standalone/worker` is the cache as a Worker of its own, for a host that runs it as it stands;
the other entry points are its parts, for a host that composes its own.

`@stayingupwind/adapter` is an optional peer, for `./adapter` alone: a host that builds with that
preset installs it beside the cache, as it installs Next.js. Nothing else in the package imports it,
so a host that runs only the standalone Worker, the gateways or the authority leaves it out.

The published package is TypeScript sources: `exports` names `.ts` files, and there is no build
step. Its suites run inside workerd (`@cloudflare/vitest-plugin`).

`./native` provides the same runtime `CacheHost` contract for a single Node.js server. It keeps
the authority's SQLite database in a dedicated worker thread and its bodies in asynchronous local
file storage, with an exclusive database owner, persistent tag revisions and the same lease,
publication and retention logic. `./native-worker` is bundled beside the native server by the
adapter. This path uses no Cloudflare runtime or service. Its suites run in the `native-cache`
Vitest project.

## Entry points

| Subpath                                                    | What it holds                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `./standalone/worker`                                      | The cache as a Worker of its own: its gateway, the scope's object, and the entrypoint a deploy seeds and retires scopes with         |
| `./standalone/read-worker`                                 | The read gateway as a Worker of its own                                                                                              |
| `./standalone/naming`                                      | The label a standalone cache signs its scopes' tokens over                                                                           |
| `./prefetch-worker`                                        | A Worker that answers a blob of a deployment's bundle the build left out of its Function                                             |
| `./authority`                                              | One deployment's cache authority, the scope's Durable Object                                                                         |
| `./authority/{history,io,metering,schema,state,stub}`      | The authority's parts: a host's history, the writes after a commit, the metered writes, the tables, the scope row, the stub          |
| `./gateway`, `./gateway/token`                             | The gateway a deployment's Function reaches, every route behind the scope's token                                                    |
| `./read-gateway`                                           | The read gateway: what a Function reads of its scope, answered from storage without the authority                                    |
| `./control`                                                | The entrypoint whatever deploys a site seeds, retires and invalidates its scopes through                                             |
| `./signals`                                                | The entrypoint an edge asks where a scope stands, and what its reads may still be behind on                                          |
| `./host`                                                   | What a host hands the cache: its tokens' label, where its scopes are placed, its meter, whom to tell when a scope moves              |
| `./bindings`, `./env`                                      | What the cache reads of its environment, and the settings it parses from it                                                          |
| `./function`, `./function/host`, `./function/bundle-blobs` | The client a deployment's Function reaches the cache with, and the blobs the build left out of it                                    |
| `./adapter`                                                | The deployment adapter with that client bundled into every Function it builds but the middleware's, for `NEXT_ADAPTER_PATH`          |
| `./logger`                                                 | Structured JSON logging, which never receives a token, a body or a cache key                                                         |
| `./internal/*`                                             | Every module by its file path, `.ts` included (`./internal/scope/data.ts`), for suites and for a host that composes the parts itself |
