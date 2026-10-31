# Publication grants

A `PublicationGrant` binds data to its scope, generation, publication epoch and immutable release.
Its `validUntil` is an absolute deadline, independent of Next.js freshness and `cacheLife`.
Cache reads, composition, delivery packs, build fallback and final response admission preserve the
earliest bound. A copy, revalidation or 304 cannot renew an existing result. Renewal belongs to the
trusted publisher and requires a fresh result under its current authority.

Hosts configure a `PublicationRequirement` on both the manifest and the Function cache host.
Version 1 requires proof before response headers. Version 2 additionally requires
`valueObservers: true`: the host asserts that every protected value is observed before use and
every reusable cache reader enforces its stored proof. Readers that support only version 1 reject
version 2. This capability must come from a verified build and deployment, never a request header.

Version 2 permits an outer Suspense shell to stream before a descendant starts its data read.
Such a live response is private and `no-store`; it is not evidence for a stored generation.
The runtime checks observations before values are consumed, before and after each streamed read,
and at completion. A later expired dependency closes the stream and cancels its producer. The
runtime does not buffer the page or add a publisher lookup. Completed cache generation writes
separately require all original dependency grants. A response-specific proof for independent
shipped bytes retains that representation's existing cache policy.

`beginPublicationRead()` is a trusted, synchronous producer hint for a live read, not a cache proof.
`observePublicationGrant()` records a public result in the current request and actual Next cache
unit. `observePrivatePublication()` records an authenticated identity without minting a public
deadline; it is forbidden inside a shared Next component cache. Its marker is never a valid grant
for stored data. A private result does not exempt an expired public dependency in the same page.

The deadline contract ends admission of new responses. It cannot erase data already received by a
browser, client router or offline cache. Purge and invalidation alone do not establish this bound.
