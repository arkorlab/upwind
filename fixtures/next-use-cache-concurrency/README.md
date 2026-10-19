# `fixtures/next-use-cache-concurrency`

Two requests for one `"use cache"` entry, in one isolate, the second while the first is still
reading it. From 16.3 Next.js has the second join the first's invocation and tee the stream the
first read from its cache handler, which belongs to the first request: in workerd that throws
"Cannot perform I/O on behalf of a different request", and the second request is answered 500. The
`use-cache-cross-request` patch has each request read the entry for itself, and this is the build
that shows it in workerd rather than in a reading of the patch.

`tools/next-matrix` builds it with the adapter given `cache-host.mjs`, starts the app Function in
Miniflare, fills the entry with one request, and then sends two more a moment apart. Both have to
be answered 200, from the entry the first filled.

| File                      | What it is for                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app/api/shared/route.js` | a public `"use cache"` function, read behind `connection()` so that the build prerenders nothing and every request reads the entry               |
| `cache-host.mjs`          | the data cache in the isolate's memory: every read takes long enough for a second request to arrive, and nothing written is remembered beside it |
| `adapter.mjs`             | the built adapter, given that host                                                                                                               |
| `next.config.mjs`         | `cacheComponents`                                                                                                                                |

16.2 deduplicates nothing, and both requests are answered from the entry there as well.
