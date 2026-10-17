# @stayingupwind/deploy

What deploying a build assembles from it, for whatever host deploys one: the manifest the edge
serves by, the shells it stores, where each shell is placed, the runtime cache the deployment starts
with, what each of its Functions is bound to, and the pointer that sends a site's requests to the
edge. Each piece is a function of the bundle and the host's choices, and does not depend on where
the host keeps its objects. What writes them is a target the host hands in (`DeployTarget`): the
build's blobs, a bucket, a key-value namespace, and the runtime cache to seed, where there is one.

A deployment is staged first (`stageDeployment`): its blobs and shells are stored and its cache
seeded, but its manifest is not yet where the edge reads one, so a refusal leaves nothing routed to
it. Then it is published (`publishDeployment`). `deployBundle` does both. The pointer it returns is
the caller's to write where its edge looks.

Both run a deployment in one process, in as many calls out as the build is large. A host that
deploys from a Worker, which caps the calls each invocation makes, uses the pure modules instead
(`./shells`, `./cache-seed`, `./manifest`, `./delivery`), spread over invocations of its own.

Like staging, `assembleManifest` refuses a build whose Next.js is outside the versions deployed, so
a host on the pure modules has that check by default. A host that judged the version itself when a
deployment came in, and assembles one it already holds or serves again, passes
`nextVersionJudged: true`: the range moves with the adapter's, and a deployment admitted under an
earlier range is then assembled as it was.

The published package is TypeScript sources: `exports` names `.ts` files, and there is no build
step. It runs as a Worker or under Node.

## Entry points

| Subpath          | What it holds                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `./deploy`       | Staging and publishing a deployment against a host's target, and the refusals a bundle can meet             |
| `./manifest`     | The manifest the edge serves by, assembled from a build, and the size it must stay within                   |
| `./shells`       | The shells a build's routes are served from, as they are stored                                             |
| `./delivery`     | The shells a manifest needs placed under a delivery policy                                                  |
| `./static-files` | The files the manifest serves: this build's, and those an open page of the deployment before still asks for |
| `./cache-seed`   | The runtime cache a deployment starts with: its scope, and the build's generation of each route             |
| `./bindings`     | What every Function of a deployment is bound to beside its environment, the cache's gateways among them     |
| `./fingerprint`  | A deployment's fingerprint, which the edge's deployment checks read                                         |
| `./pointer`      | The pointer that has the edge serve a site from a deployment's manifest                                     |
