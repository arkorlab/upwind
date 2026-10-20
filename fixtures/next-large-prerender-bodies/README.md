# Large completed page bodies

`next.config.js` and both files under `app/memory-pressure/[step]` are unmodified copies of
[Next.js 16.4.2's memory-pressure fixture](https://github.com/vercel/next.js/tree/2864b1772c37242a9b40ab4d366eb7d368c2a070/test/e2e/app-dir/segment-cache/memory-pressure).
The CI proof verifies their exact SHA256 hashes. They generate 60 pages, each containing 1MiB of
text. The root layout, small page, adapter configuration and fake blob host are separate helpers
owned by this reproducer. This check does not run or claim the upstream browser memory tests.

The normal adapter leaves only eligible completed large HTML and whole Flight bodies outside the
Function, retaining their bundle references and uploaded blobs. The emitted Function must remain
within the unchanged 64MiB size audit. Local CI Worker requests verify exact body bytes and headers,
HEAD and small-page zero-read paths, and missing-reader/blob/wrong-size failures. The fake service
binding accepts only the selected immutable reference; all network egress is refused. The proof
records source and blob hashes, sizes and fixed outcomes, with no deployment, heap, cold-start or
TTFB claim. An option-OFF build is not measured by this lane.
