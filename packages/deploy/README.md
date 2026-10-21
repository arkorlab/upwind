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

## Prefetch service capabilities

When supplying `prefetch` to `functionBindings`, also supply
`prefetchBlobs: prefetchBlobsOf(acceptedBundle)` from `./prefetch`. An explicitly empty capability is
valid for a bundle with no blobs to grant. Omitting the capability is a TypeScript error and throws
at binding assembly for JavaScript callers, before an unusable strict binding can be deployed.
A host without a prefetch service needs neither field. This changes deployment configuration only;
it adds no work to a visitor's request and does not migrate existing deployed service bindings.

## Overlapping asset prefixes: request-key manifest rollout

When an asset-prefix rewrite also covers the build's canonical `_next/static` directory,
new manifests use actual request URL keys and `staticFileRequestKeys: true`. This format is
version 7; ordinary canonical-key manifests stay at version 6. The reader accepts versions 3
through 7 without narrowing any previous version. A transition out of overlap also uses request
keys while retaining the preceding deployment's files, including their original `dpl` selection.

Before enabling this writer, update every edge reader to accept version 7 and confirm that no
old-reader traffic remains. This is a required rollout order for a new immutable deployment and
scope, rather than an automatic consequence of merging the reader change.
Repository build and publication workflows do not enforce that deployment order. An older
reader refuses version 7. When validation exercises routes in that candidate, it returns
`validation-unresolved`, retries, and eventually fails the deployment while leaving the active
deployment in place. Candidates without validated routes do not have that protection; validation
is not a substitute for upgrading readers first. If an unsupported manifest is already active
during a mixed rollout or rollback, the existing Function fallback
can increase TTFB, and assets absent from the Function's shipped files can return 404. Keep
version-7-capable readers while version 7 manifests remain in use, or republish version 6
manifests before rolling back the readers. Do not replace an existing manifest under an old
reader. This change itself performs no deployment.

The new map retains only actual request names, including the preceding deployment's reachable
asset URLs. It does not expose canonical names that Next.js rewrites elsewhere. Its extra metadata
pays the existing manifest byte and memory accounting; admission limits and the separate overall
quota policy are unchanged. Prefixless ordinary HTML misses retain their existing lookup path.
Rare decoded file hits and request-key lookups have real string and branch costs; restored file
metadata also has its existing cold manifest decoding cost. No zero-cost claim is made.

The local checker deploys one build with no preceding deployment. Its expected file format is
therefore derived independently from that build; deployment-transition and previous-`dpl`
behavior are covered by the deployment file tests instead.

The exported `projectManifestSchema` now discriminates versions. Its `parse` and `safeParse`
interfaces remain; object-specific methods such as `.extend`, `.omit` and `.strict` are no longer
part of this export. Repository consumers use parsing only. Legacy versions 3–6 still strip and
accept the formerly unknown `staticFileRequestKeys` field, regardless of its supplied value;
version 7 validates it as optional literal `true`. Code that extended the exported object schema
must instead define its own surrounding schema. This API change accompanies the new reader.
