# `fixtures/next-use-cache-concurrency`

Two requests for one `"use cache"` entry, in one isolate, the second while the first is still
reading it. From 16.3 Next.js has the second join the first's invocation and tee the stream the
first read from its cache handler, which belongs to the first request: in workerd that throws
"Cannot perform I/O on behalf of a different request", and the second request is answered 500. The
`use-cache-cross-request` patch has each request read the entry for itself, and this is the build
that shows it in workerd rather than in a reading of the patch.

`tools/next-matrix` builds it with the adapter given `cache-host.mjs`, and starts the app Function
in Miniflare with a binding the cache host tells of every read through: the key, and the request
the read is for, by a header the runner sent that request with. A read goes on only once the runner
answers. One request fills the entry, its reads let through. Then the runner holds them: it sends
the first request and waits for its read to begin, then sends the second and waits for the second's
own read of the same key to begin while the first's is still held. Only then does it let both go
on, and both have to be answered 200, from the entry the fill wrote.

Nothing is left to timing. A run in which the second request's read was not seen to begin while the
first's was held fails rather than passes, and without the patch that is what happens: the second
request joins the first's invocation instead of reading, and is answered 500 once the first's read
is let go. Every wait is bounded, 10 s for a read to begin and 30 s for an answer, so a broken run
ends by saying what it was waiting for.

| File                      | What it is for                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `app/api/shared/route.js` | a public `"use cache"` function, read behind `connection()` so that the build prerenders nothing and every request reads the entry   |
| `cache-host.mjs`          | the data cache in the isolate's memory: every read waits for the runner to let it go on, and nothing written is remembered beside it |
| `adapter.mjs`             | the built adapter, given that host                                                                                                   |
| `next.config.mjs`         | `cacheComponents`                                                                                                                    |

16.2 deduplicates nothing, and both requests are answered from the entry there as well.
