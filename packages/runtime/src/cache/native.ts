/**
 * The platform's own `fetch`, taken before any of Next.js is evaluated. Next.js replaces the
 * global with one that reads the render's stores: inside a prerender, a request it does not
 * know to be cached is dynamic I/O, and is left hanging until the prerender aborts. The cache
 * host is asked from inside renders — a `use cache` read, a tag sync — and is not the
 * application's data: it goes out through the runtime's fetch, which no render sees.
 */
export const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);
