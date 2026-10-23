# Compact repair locators and reader rollout

Version one remains the default delivery format. Deploying dual readers does not change an
existing scope's format and does not enable a producer. A scope belongs to one immutable
deployment; retained Functions continue reading that deployment's own scope.

## Representation and size

Version two keeps ordinary artifact objects, including arbitrary nonempty literal references and
pack artifacts with no location. Only references shaped as `r/<namespace32>/<nonce32>` use a tuple.
Both components are 32 lowercase hexadecimal characters; the key has exactly 67 ASCII bytes.
The scope retains its namespace, generated at its first approved seed. Each repair chooses a new
nonce. Key shape proves neither ownership nor that a replacement PUT succeeded.

The SQL tuple contains, in order, `artifactId`, `sha256`, `byteLength`, `contentType`, `encoding`,
`role`, and `storageRef`. A pack tuple adds `representationKey` as its eighth value. Readers expand
these tuples into the existing artifact object. Content identity, role and representation keep
their previous meanings. Resolving a tuple needs no lookup, hash, await or probe.

Removing seven property names and their quotes/colons saves exactly 80 JSON bytes; removing the
pack's eighth property saves 100. Array and object delimiters and separators have equal width, and
all other values retain their JSON encodings. A shortest accepted reference is `"x"`, three JSON
bytes. The new key takes 69 JSON bytes, so its maximum growth is 66 bytes. An initial repair
therefore shrinks an artifact by at least 14 bytes in SQL and 34 bytes in a pack. Replacing a tuple's
67-byte ASCII key with another changes its JSON width by zero. Short ordinary references must
remain objects: compacting them early would invalidate this repeated-repair proof. Variable-width
or malformed tuple references are rejected by the dual readers.

The pack version prefix and the header's version must agree. Version-one artifacts cannot contain
tuples. Both versions keep their existing header/body ceilings; this change introduces no new
upload or seed acceptance limit. The authority's record-size calculation and writer must select
the same version before a producer can be enabled.

## Consumer approval and migration

1. Publish dual readers first: the edge, authority SQL readers, gateway and read gateway's streaming
   prefix reader, Function runtime, and Function cache host. Retain all version-one paths and
   copies. Publishing only a new adapter does not upgrade an immutable Function or an external
   `cacheHostModule`.
2. Audit the actual first-party runtime/cache-host bytes and record their complete main-module blob
   digests, host identity and host-source digest. The adapter bundles the runtime and cache host
   into the main module; `app.cjs` and `runtime.json` remain separate modules. The approval must
   cover every actual app, split, middleware, workflow and Durable Object Function in the bundle.
   Verify the audited main module contains the decoder and cache host rather than a wrapper that
   imports an unapproved separate reader chunk. The first-party adapter's runtime bundler has
   `codeSplitting: false`, only Node/Cloudflare built-ins external, and bundles `cacheHostModule`
   internally; its generated app/edge/wasm modules are the explicit exceptions. `function.ts`
   hashes that complete runtime file, and `auditTracedFiles` rejects reserved-name collisions.
   The approval helper also declines duplicate/noncanonical module names in uploaded bundles so
   another module cannot alias an audited main module or its imports.
   A bundle's own capability flag, package version or module path is insufficient. Unknown or
   custom hosts continue on version one.
3. Retain trusted rollout evidence that every traffic-serving platform reader runs an approved
   version. One capability probe or one version-metadata answer does not prove an all-traffic
   rollout. The trusted deploy host supplies `ApprovedPackReaderRollout`; `scopePackReadersOf`
   compares the already-collected actual main-module hashes without new hashing or storage reads.
   An absent, incomplete or ambiguous approval produces no version-two proof.
4. Build a new immutable deployment, create its own scope, seed and warm it through the normal
   deployment workflow, then activate it through normal validation. Pass the serialized verified
   `ScopePackReaders` as `generationPackReaders` in the first scope seed. The authority binds it
   to the deployment/build and seals `pack_schema_version` plus `repair_namespace` in that first
   transaction. The proof is retained in private audit metadata. A seed retry never upgrades or
   downgrades a scope, even if the current approval changes.
5. Keep the dual-reader rollback floor while any version-two scope or retained Function remains
   live. Keep old scopes and their Workers unchanged until their normal retirement/drain. Do not
   rewrite old packs to version two or replace a retained Function inside its existing deployment.

The scope context hydrates the sealed format and namespace from its existing `SELECT *` identity
read. The new columns are created with new tables; an empty old table is upgraded only during its
first seed write. An already-seeded legacy table does not need a new constructor/read probe.
Ordinary serving never reads approval metadata.

Version-one repair jobs still need their bounded preflight when a longer literal replacement can
exceed an existing record ceiling. This rollout does not promise a universal in-place repair of
all retained legacy records. The compatible migration is a newly built, seeded and warmed scope;
no old immutable consumer is sent a format that would cause a miss or fallback.

## Fresh writes and cleanup

The repair writer must reserve a candidate location durably, retain attempt/job pins, verify the
replacement bytes, and obtain the successful conditional/checksummed PUT receipt before publishing
it. An existing object or a negative HEAD is insufficient. Conditional-create collisions choose a
new nonce instead of overwriting an unknown object. Ambiguous writes retain their reservation
until reconciled; a negative read cannot settle an earlier unknown PUT.

The scope's `r/<namespace32>/` prefix makes late/orphan repair uploads discoverable. Cleanup must
select actual owner metadata and preserve reservations, referenced objects and newer attempts;
key shape alone never authorizes deletion. Retirement must drain/pin older projections and clean
this owned prefix as well as the legacy scope prefix. Namespace collisions do not authorize
removing another scope's objects.

These changes define and implement the reader/approval boundary. Enabling an actual producer also
requires the bounded repair job, fresh-write receipt and owned cleanup implementation. No production
approval, deployment or migration is performed by these changes.

## Source evidence

- [R2 conditional writes, checksums and metadata](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 consistency and unknown in-flight writes](https://developers.cloudflare.com/r2/reference/consistency/)
- [Workers gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/)
- [Worker version metadata](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/)

Official documentation checked on 2026-10-23. No local project test, lint, typecheck, build or
benchmark gate was run; the regression cases are intended for CI.
