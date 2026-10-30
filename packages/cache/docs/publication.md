# Bounded public publication

A publication grant is a trusted publisher's absolute deadline for admitting a new response. It is
separate from Next.js freshness: it does not change `cacheLife`, prerendering, Suspense or prefetch.
Fresh cache hits check their existing metadata locally. They make no publication lookup.

```ts
import { observePublicationGrant } from '@stayingupwind/core/paas';

async function sharedData() {
  'use cache';
  const { data, grant } = await publisher.read(); // The application's existing authority call.
  await observePublicationGrant(grant);
  return data;
}
```

The publisher returns `PublicationGrant` from `@stayingupwind/core/cache`:

```ts
interface PublicationGrant {
  scope: string;
  dataGeneration: string;
  publicationEpoch: number;
  release: { id: string; digest: string };
  validUntil: number; // Absolute Unix milliseconds, exclusive.
}
```

`publicationIdentity(grant)` hashes the scope, data generation, publication epoch and immutable
release identity; the deadline is excluded. `publicationTagOf(grant)` encodes that identity and
the original deadline into a bounded reserved tag. `observePublicationGrant` records that tag in
the actual registered Next cache store and active runtime request. Cached children propagate their
original tags into their parents. Combining results takes the earliest deadline, including multiple
grants of the same identity. Reads, copies, delayed writes and conditional responses never renew it.

Fetch-cache users can pass the tag through Next's existing `next.tags`. An authority RPC returning
data and its grant should use `cache: 'no-store'`; cache the validated result in the surrounding
`use cache` scope. Reusing an independently cached RPC body must not manufacture a fresh grant.
Unrelated static component entries keep their original profiles and do not inherit request-wide
grants. The runtime's whole response and regenerated route do accumulate their read dependencies.

The host seals the same `PublicationRequirement` into `cacheHostFor(names, { publication })`
and `assembleManifest({ ..., publication })`, after choosing the application's data generation:

```ts
const publication = {
  version: 1 as const,
  identities: [await publicationIdentity(grant)],
  routes: ['/boards/[id]'],
  independentBuild: ['/boards/[id]'],
};
```

`routes` contains source route identities, not visitor-supplied path claims. Each listed route's
cached response requires all listed identities. Optional `independentBuild` is a host/compiler
proof that **every shipped representation** of that route is free of protected data: HTML, Flight,
prefetch segments, postponed state and resume data. A visually static shell alone is insufficient.
Such a build remains available while its dynamic parts render. Without that proof, a missing,
corrupt, expired or ungranted record must render normally rather than revive shipped bytes.

New adapter bundles declare `publicationGrants: 1`; protected manifest assembly refuses a bundle
without that runtime capability. Protected manifests use schema version 9; manifests without this
capability keep their existing versions. An older edge refuses the new version and delegates to the application's runtime, which
must already have the matching sealed requirement. Roll out the enforcing runtime and edge before
enabling publication requirements. Do not roll either back to an unaware implementation while
protected deployments remain reachable. An unknown capability is not permission to serve a build.

Grant tags survive existing data records, generation packs, artifacts and Cache API/memory copies.
Data-cache expiry is a local miss, not a lookup to renew the old result. Response admission checks
the deadline again after asynchronous preparation. Protected responses forbid an outer HTTP cache
from bypassing that check; their cacheable internal records remain available at the edge. A detected
clock rollback closes that runtime's protected admission until it is replaced.

The publisher must persist its issuance ceiling **before** emitting grants, fence renewal by owner
and data generation, and stop old-generation issuance during withdrawal. Waiting for the maximum
issued deadline belongs in preparation, outside a short activation transaction. Purges can speed
up convergence but are not withdrawal acknowledgements. An old release must be unable to obtain a
new grant for a different committed generation/release, even through a retained deployment URL.

This contract assumes trusted publisher code and the platform's normal clock/expiry semantics.
It does not establish a global clock-skew bound or a globally synchronized purge barrier. An ACK
may certify that compliant serving layers no longer admit old-generation responses under that
contract. It cannot revoke already admitted streams, downloaded browser/router/offline copies, or
an uncontrolled third-party cache. If those stronger guarantees are required, use an acknowledged
serving fence instead of treating a timer or purge API success as proof.
