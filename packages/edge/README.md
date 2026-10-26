# @stayingupwind/edge

The edge in front of a deployment, as a host runs it. Where a route has a shell the edge can serve,
a document goes out from that shell first, and its continuation is spliced in as the deployment's
Function renders it; any other document, and one whose shell cannot be read in time, is the
Function's to answer whole. Around that, the edge serves:

- the build's files and optimized images;
- prefetch segments;
- the application's middleware, run where Next.js runs it;
- the runtime cache's reads, for a page whose record is already rendered.

A pointer names what a site serves: a manifest, a delivery policy, the Functions behind them, and
whether the edge serves from its shells at all.

A request begins its cache scope check when it reads a generation or dispatches to the deployment's
Function, as a whole request or a shell's continuation. Neither waits for the check. Documents keep
their generation-read timing, so a cold build shell can be read beside its record while the scope
authority is still answering. A document with no generation starts its check when it dispatches
its continuation, after its shell read has begun. Pages Router data handed to the Function checks
too; shipped-file and image responses do not.
The existing scope hold and background refresh cadence are unchanged.

A host hands the edge what is its own. `EdgeHost` carries the names the edge keeps things under,
the domains it serves, the credentials it keeps for itself, how a Function that is gone is told
apart, and an observer that is told what each answer cost. `EdgeRuntime` is how the edge reaches
what is outside it: a Function, the image transformer, the blob Worker, the clock, the isolate's
memory, and whatever takes its reports. Everything else is the edge's.

`./standalone/worker` is the edge as a Worker of its own, for a host with no deployment service of
its own. It serves one site, with its pointer pinned on the Worker or kept in `EDGE_STATE`, and its
Functions reached over service bindings. The other entry points are its parts, for a host that
composes its own.

A Worker that holds the edge needs Node.js compatibility. The module that compresses live answers
imports `node:zlib` as it loads, whether or not a request needs compressing, so a Worker without it
does not load. Set the `nodejs_compat` flag, or a compatibility date of 2026-08-04 or later, from
which it is the default.

The published package is TypeScript sources: `exports` names `.ts` files, and there is no build
step. Its suites run inside workerd (`@cloudflare/vitest-plugin`).

## Entry points

| Subpath                                            | What it holds                                                                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `./standalone`, `./standalone/worker`              | The edge on its own, serving one site, and the Worker a host deploys it as                                                               |
| `./blob-worker`                                    | The Worker the edge reads a deployment's blobs and manifests through, by content                                                         |
| `./route`                                          | A request whose site is known, from the reads its pointer names to the answer                                                            |
| `./pattern-budget`                                 | The one allowance every routing test of a request spends, kept across its awaits, for a host that routes beside the edge                 |
| `./edge-host`, `./edge-runtime`, `./bindings`      | What a host hands the edge, what reaches a Function for it, and what it reads of its environment                                         |
| `./preview/{pointer,manifest,state,storage}`       | The pointer and the manifest as the edge reads them, and what it knows of a site for a request                                           |
| `./memory/caches`                                  | What an isolate keeps between requests, and the budget it keeps it within                                                                |
| `./reports`                                        | What the edge reports of a route as it serves it, for a host to act on                                                                   |
| `./observability/{logger,metrics}`                 | Structured logging, and the measurements of each answer an observer is told                                                              |
| `./handlers/{csp-nonce,layered-clients,responses}` | A document's CSP nonce, the clients sent a second brotli layer, and the edge's own responses                                             |
| `./strategies/{asset-upstream,context}`            | How an asset is fetched and kept, and what every strategy is handed for a request                                                        |
| `./request-context`                                | What the edge knows of a request before any handler looks at it                                                                          |
| `./internal/*`                                     | Every module by its file path, `.ts` included (`./internal/cache/decision.ts`), for suites and for a host that composes the parts itself |
