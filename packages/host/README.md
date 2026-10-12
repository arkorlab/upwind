# @stayingupwind/host

What the parts of a host share: the edge that serves a deployment, the runtime cache behind it, and
whatever deploys a build to them. Nothing here serves a request. It is the delivery policy the edge
serves under, the pointer that names what a site serves, the contracts of the runtime cache, the
names a deployment's objects are kept under in storage, and the pieces of the edge's own work that
something which deploys has to agree with — so that the three cannot disagree about what a field,
a key or a header means.

The published package is TypeScript sources: `exports` names `.ts` files, and there is no build
step. `sideEffects: false` is true of it — nothing here initializes anything — and a module that only
reads a schema's type imports nothing it builds.

## Entry points

| Subpath          | What it holds                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `./delivery`     | The delivery policy (where shells and assets are read from, the middleware's budget, how documents are served from the runtime cache), the pointer the edge reads, and what one manifest may cost an isolate |
| `./storage`      | The keys a deployment's objects are kept under — the pointer, manifests and policies, the bundle and its blobs — for what writes them and the edge that reads them alike                                     |
| `./cache`        | The runtime cache as its parts share it: the authority's model of a scope, the contract its gateway answers, and the token that opens a scope to a deployment's Workers                                      |
| `./bindings`     | The bindings a deployment's Worker is given beside its own environment, for the cache and the bundle reader it runs with                                                                                     |
| `./bundle`       | The runtime cache seeded from a bundle: the build's generation of each route, as an entry                                                                                                                    |
| `./splice`       | A shell and its continuation on the wire as one document, in the encoding the shell was stored in                                                                                                            |
| `./preloads`     | The resource hints a shell's head names, read out of it so the edge can send them early                                                                                                                      |
| `./credentials`  | The headers and cookies a host keeps for itself, taken off everything the edge forwards to an application                                                                                                    |
| `./domains`      | Whether a hostname is one of a list of domains or a name beneath one                                                                                                                                         |
| `./next-support` | The Next.js versions a host admits, and how much of what it serves each one gets                                                                                                                             |
| `./util`         | Checking a value from outside against its schema at a bounded cost                                                                                                                                           |
| `./zod`          | `@stayingupwind/core`'s schemas as zod schemas, for what takes zod's alone                                                                                                                                   |
