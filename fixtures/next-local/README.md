# `fixtures/next-local`

The application CI's `local-check` job serves on a local stack (`@stayingupwind/local`), as it
would be served deployed:

1. It is built through the cache's adapter preset (`pnpm run build:local`, which names
   `packages/cache/src/function/adapter.ts`).
2. A stack serves it on one machine as it is served deployed: the standalone edge, the runtime cache
   and the prefetch Worker.
3. `pnpm local:check` asks it for every document and file it prerendered, as a deployment is
   validated.

Every file is here because the stack has to serve something it holds:

| File                                        | What the stack has to serve                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `next.config.ts`                            | header rules with and without a condition, a redirect, an `afterFiles` rewrite and one to another origin |
| `proxy.ts`                                  | the middleware: rewrites, a redirect, a cookie and a request header, a read of the storage |
| `instrumentation.ts`                        | the hook the runtime loads once, before any request                                        |
| `app/page.tsx`, `app/items/[id]/page.tsx`   | shells resumed with what only the request says; a class shell beside a known member        |
| `app/static/page.tsx`                       | a page complete at build time                                                              |
| `app/stream/page.tsx`                       | a document that arrives in pieces                                                          |
| `app/posts/[slug]/page.tsx`                 | a member rendered on demand and kept by the cache, under the tags a revalidation names     |
| `app/cache-private-shell/page.tsx`          | `'use cache: private'` beneath a shared `'use cache'`                                      |
| `app/not-found.tsx`                         | a path with no page, rendered rather than served from a file                               |
| `app/api/*`                                 | route handlers: an echo, a failure, a lazy import, the storage, a revalidation, WebAssembly in both forms |
| `public/*`                                  | files the edge serves itself, and one too large for the Worker to carry                    |

Like the other fixtures it is not a workspace package: npm installs it apart, with the Next.js its
`package.json` pins.
